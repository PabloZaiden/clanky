/**
 * Atomic one-use invitation redemption; only token hashes reach storage.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CollaborationGuestGrant, CollaborationInvitation } from "@/shared/collaboration";
import { COLLABORATION_MAX_GUESTS, COLLABORATION_MAX_INVITATIONS } from "@/shared/collaboration";
import { CollaborationInvitationSchema } from "@/contracts/schemas/collaboration";
import type { AcceptCollaborationInvitation } from "@/contracts/schemas/collaboration";
import { DomainError } from "../domain/domain-error";
import { getDatabase } from "./database";
import { getCollaborationGuestByNodeInternal } from "./collaboration-guests";
import {
  getCollaborationControllerIdentityInternal,
  parseCollaborationRecord,
  requireCollaborationWorkspaces,
} from "./collaboration-storage";

const InvitationRowSchema = z.object({
  id: z.string(),
  protocol_version: z.literal(1),
  controller_node_id: z.string(),
  controller_public_key: z.string(),
  controller_fingerprint: z.string(),
  owner_user_id: z.string(),
  name: z.string().nullable(),
  relay_url: z.string(),
  relay_fingerprint: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  consumed_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  workspace_count: z.number().int().positive(),
});

function decodeInvitation(value: unknown): CollaborationInvitation {
  const row = parseCollaborationRecord(InvitationRowSchema, value);
  const relations = getDatabase().query(`
    SELECT workspace_id AS id FROM collaboration_invitation_workspaces
    WHERE invitation_id = ? AND owner_user_id = ? ORDER BY workspace_id
  `).all(row.id, row.owner_user_id);
  const workspaceIds = parseCollaborationRecord(z.array(z.object({ id: z.string().min(1) })), relations)
    .map((entry) => entry.id);
  return parseCollaborationRecord(CollaborationInvitationSchema, {
    protocolVersion: row.protocol_version,
    controller: { nodeId: row.controller_node_id, publicKey: row.controller_public_key,
      fingerprint: row.controller_fingerprint },
    id: row.id, name: row.name, workspaceIds,
    relayUrl: row.relay_url, relayFingerprint: row.relay_fingerprint,
    createdAt: row.created_at, expiresAt: row.expires_at,
    consumedAt: row.consumed_at, revokedAt: row.revoked_at,
  });
}

export function saveCollaborationInvitation(
  ownerUserId: string,
  tokenHash: string,
  invitation: CollaborationInvitation,
): void {
  const db = getDatabase();
  db.transaction(() => {
    requireCollaborationWorkspaces(ownerUserId, invitation.workspaceIds);
    db.query("DELETE FROM collaboration_invitations WHERE owner_user_id = ? AND expires_at <= ?")
      .run(ownerUserId, invitation.createdAt);
    const count = parseCollaborationRecord(z.object({ count: z.number().int() }),
      db.query("SELECT count(*) AS count FROM collaboration_invitations WHERE owner_user_id = ?").get(ownerUserId));
    if (count.count >= COLLABORATION_MAX_INVITATIONS) {
      throw new DomainError("collaboration_invitation_limit", "Too many unexpired collaboration invitations.");
    }
    db.query(`
      INSERT INTO collaboration_invitations
        (id, owner_user_id, token_hash, protocol_version, controller_node_id, controller_public_key,
         controller_fingerprint, name, relay_url, relay_fingerprint,
         created_at, expires_at, consumed_at, revoked_at, workspace_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(invitation.id, ownerUserId, tokenHash, invitation.protocolVersion,
      invitation.controller.nodeId, invitation.controller.publicKey,
      invitation.controller.fingerprint, invitation.name,
      invitation.relayUrl, invitation.relayFingerprint, invitation.createdAt,
      invitation.expiresAt, invitation.workspaceIds.length);
    const insert = db.query(`
      INSERT INTO collaboration_invitation_workspaces (invitation_id, owner_user_id, workspace_id)
      VALUES (?, ?, ?)
    `);
    for (const workspaceId of invitation.workspaceIds) {
      insert.run(invitation.id, ownerUserId, workspaceId);
    }
  }).immediate();
}

export function listCollaborationInvitations(ownerUserId: string): CollaborationInvitation[] {
  return getDatabase().query(`
    SELECT * FROM collaboration_invitations WHERE owner_user_id = ? ORDER BY created_at, id
  `).all(ownerUserId).map(decodeInvitation);
}

export function revokeCollaborationInvitation(ownerUserId: string, id: string, now: string): void {
  const result = getDatabase().query(`
    UPDATE collaboration_invitations SET revoked_at = COALESCE(revoked_at, ?)
    WHERE id = ? AND owner_user_id = ?
  `).run(now, id, ownerUserId);
  if (result.changes === 0) {
    throw new DomainError("collaboration_invitation_not_found", "Invitation not found.");
  }
}

export function consumeCollaborationInvitation(
  input: AcceptCollaborationInvitation & { tokenHash: string; now: string },
): CollaborationGuestGrant {
  const db = getDatabase();
  return db.transaction(() => {
    const value = db.query("SELECT * FROM collaboration_invitations WHERE token_hash = ?")
      .get(input.tokenHash);
    if (!value) {
      throw new DomainError("collaboration_invitation_unavailable", "The invitation is unavailable or expired.");
    }
    const row = parseCollaborationRecord(InvitationRowSchema, value);
    const invitation = decodeInvitation(value);
    if (invitation.revokedAt !== null || invitation.consumedAt !== null
      || invitation.expiresAt <= input.now) {
      throw new DomainError("collaboration_invitation_unavailable", "The invitation is unavailable or expired.");
    }
    if (input.relayUrl !== invitation.relayUrl || input.relayFingerprint !== invitation.relayFingerprint) {
      throw new DomainError("collaboration_relay_mismatch", "The invitation relay route does not match.");
    }
    const controller = getCollaborationControllerIdentityInternal();
    if (!controller || controller.nodeId !== invitation.controller.nodeId
      || controller.publicKey !== invitation.controller.publicKey
      || controller.fingerprint !== invitation.controller.fingerprint) {
      throw new DomainError("collaboration_controller_mismatch", "The invitation controller identity has changed.");
    }
    if (invitation.workspaceIds.length !== row.workspace_count) {
      throw new DomainError("collaboration_workspace_unavailable", "One or more selected workspaces are unavailable.");
    }
    requireCollaborationWorkspaces(row.owner_user_id, invitation.workspaceIds);
    if (db.query("SELECT 1 FROM collaboration_guests WHERE node_id = ? OR fingerprint = ?")
      .get(input.guest.nodeId, input.guest.fingerprint)) {
      throw new DomainError("collaboration_identity_already_paired", "Use a new identity for each collaboration pairing.");
    }
    const count = parseCollaborationRecord(z.object({ count: z.number().int() }),
      db.query("SELECT count(*) AS count FROM collaboration_guests WHERE owner_user_id = ?").get(row.owner_user_id));
    if (count.count >= COLLABORATION_MAX_GUESTS) {
      throw new DomainError("collaboration_guest_limit", "The collaboration guest limit has been reached.");
    }
    const guestId = randomUUID();
    db.query(`
      INSERT INTO collaboration_guests
        (id, owner_user_id, node_id, public_key, fingerprint, name,
         relay_url, relay_fingerprint, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(guestId, row.owner_user_id, input.guest.nodeId, input.guest.publicKey,
      input.guest.fingerprint, input.name ?? invitation.name,
      input.relayUrl, input.relayFingerprint, input.now);
    const insert = db.query(`
      INSERT INTO collaboration_memberships (guest_id, owner_user_id, workspace_id, revoked_at)
      VALUES (?, ?, ?, NULL)
    `);
    for (const workspaceId of invitation.workspaceIds) {
      insert.run(guestId, row.owner_user_id, workspaceId);
    }
    db.query(`
      UPDATE collaboration_invitations SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL
    `).run(input.now, invitation.id);
    const grant = getCollaborationGuestByNodeInternal(input.guest.nodeId);
    if (!grant) {
      throw new DomainError("collaboration_storage_invalid", "The accepted guest could not be loaded.");
    }
    return grant;
  }).immediate();
}
