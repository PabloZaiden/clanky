/**
 * Controller-owned guest identities and normalized workspace memberships.
 */

import { z } from "zod";
import type { CollaborationGuestGrant, CollaborationRevocation } from "@/shared/collaboration";
import { CollaborationGuestGrantSchema } from "@/contracts/schemas/collaboration";
import { DomainError } from "../domain/domain-error";
import { getDatabase } from "./database";
import { parseCollaborationRecord } from "./collaboration-storage";

const GuestRowSchema = z.object({
  id: z.string(),
  owner_user_id: z.string(),
  owner_username: z.string(),
  node_id: z.string(),
  public_key: z.string(),
  fingerprint: z.string(),
  name: z.string().nullable(),
  relay_url: z.string(),
  relay_fingerprint: z.string(),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
});

function decodeGuest(value: unknown): CollaborationGuestGrant {
  const row = parseCollaborationRecord(GuestRowSchema, value);
  const memberships = getDatabase().query(`
    SELECT membership.workspace_id AS id FROM collaboration_memberships membership
    JOIN workspaces workspace ON workspace.id = membership.workspace_id
      AND workspace.user_id = membership.owner_user_id
    WHERE membership.guest_id = ? AND membership.owner_user_id = ?
      AND membership.revoked_at IS NULL
    ORDER BY membership.workspace_id
  `).all(row.id, row.owner_user_id);
  const workspaceIds = parseCollaborationRecord(z.array(z.object({ id: z.string().min(1) })), memberships)
    .map((entry) => entry.id);
  return parseCollaborationRecord(CollaborationGuestGrantSchema, {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username,
    identity: { nodeId: row.node_id, publicKey: row.public_key, fingerprint: row.fingerprint },
    name: row.name,
    relayUrl: row.relay_url,
    relayFingerprint: row.relay_fingerprint,
    workspaceIds: row.revoked_at ? [] : workspaceIds,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  });
}

export function getCollaborationGuestByNodeInternal(nodeId: string): CollaborationGuestGrant | undefined {
  const row = getDatabase().query(`
    SELECT guest.*, owner.username AS owner_username FROM collaboration_guests guest
    JOIN webapp_users owner ON owner.id = guest.owner_user_id AND owner.disabled_at IS NULL
    WHERE guest.node_id = ?
  `).get(nodeId);
  return row ? decodeGuest(row) : undefined;
}

export function listCollaborationGuests(ownerUserId: string): CollaborationGuestGrant[] {
  return getDatabase().query(`
    SELECT guest.*, owner.username AS owner_username FROM collaboration_guests guest
    JOIN webapp_users owner ON owner.id = guest.owner_user_id AND owner.disabled_at IS NULL
    WHERE guest.owner_user_id = ? ORDER BY guest.created_at, guest.id
  `).all(ownerUserId).map(decodeGuest);
}

export function listActiveCollaborationGuestsInternal(): CollaborationGuestGrant[] {
  return getDatabase().query(`
    SELECT guest.*, owner.username AS owner_username FROM collaboration_guests guest
    JOIN webapp_users owner ON owner.id = guest.owner_user_id AND owner.disabled_at IS NULL
    WHERE guest.revoked_at IS NULL ORDER BY guest.id
  `).all().map(decodeGuest).filter((guest) => guest.workspaceIds.length > 0);
}

export function revokeCollaborationGuest(
  input: { ownerUserId: string; guestId: string; workspaceId?: string; now: string },
): CollaborationRevocation | undefined {
  const db = getDatabase();
  return db.transaction(() => {
    const row = db.query(`
      SELECT guest.*, owner.username AS owner_username FROM collaboration_guests guest
      JOIN webapp_users owner ON owner.id = guest.owner_user_id AND owner.disabled_at IS NULL
      WHERE guest.id = ? AND guest.owner_user_id = ?
    `).get(input.guestId, input.ownerUserId);
    if (!row) {
      throw new DomainError("collaboration_guest_not_found", "Guest not found.");
    }
    const guest = decodeGuest(row);
    if (guest.revokedAt !== null) return undefined;
    const wholeGuest = input.workspaceId === undefined;
    const workspaceIds = wholeGuest
      ? guest.workspaceIds
      : guest.workspaceIds.filter((id) => id === input.workspaceId);
    if (!wholeGuest && workspaceIds.length === 0) return undefined;
    if (wholeGuest) {
      db.query("UPDATE collaboration_guests SET revoked_at = ? WHERE id = ? AND owner_user_id = ?")
        .run(input.now, input.guestId, input.ownerUserId);
      db.query(`
        UPDATE collaboration_memberships SET revoked_at = ?
        WHERE guest_id = ? AND owner_user_id = ? AND revoked_at IS NULL
      `).run(input.now, input.guestId, input.ownerUserId);
    } else {
      db.query(`
        UPDATE collaboration_memberships SET revoked_at = ?
        WHERE guest_id = ? AND owner_user_id = ? AND workspace_id = ? AND revoked_at IS NULL
      `).run(input.now, input.guestId, input.ownerUserId, input.workspaceId!);
    }
    return { guestId: guest.id, nodeId: guest.identity.nodeId,
      ownerUserId: guest.ownerUserId, workspaceIds, wholeGuest };
  }).immediate();
}
