/**
 * Controller-owned guest identities and normalized workspace memberships.
 */

import { z } from "zod";
import type { CollaborationGuestAccess, CollaborationRevocation, CollaborationWorkspacePermission } from "@/shared/collaboration";
import { CollaborationGuestGrantSchema, CollaborationWorkspacePermissionSchema } from "@/contracts/schemas/collaboration";
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
  all_workspaces_admin: z.union([z.literal(0), z.literal(1)]),
});

function decodeGuest(value: unknown): CollaborationGuestAccess {
  const row = parseCollaborationRecord(GuestRowSchema, value);
  const memberships = row.all_workspaces_admin === 1
    ? getDatabase().query("SELECT id, 'work' AS permission FROM workspaces WHERE user_id = ? ORDER BY id").all(row.owner_user_id)
    : getDatabase().query(`
    SELECT membership.workspace_id AS id, membership.permission FROM collaboration_memberships membership
    JOIN workspaces workspace ON workspace.id = membership.workspace_id
      AND workspace.user_id = membership.owner_user_id
    WHERE membership.guest_id = ? AND membership.owner_user_id = ?
      AND membership.revoked_at IS NULL
    ORDER BY membership.workspace_id
  `).all(row.id, row.owner_user_id);
  const workspaces = row.revoked_at ? [] : parseCollaborationRecord(z.array(z.object({
    id: z.string().min(1), permission: CollaborationWorkspacePermissionSchema,
  })), memberships);
  const workspaceIds = workspaces.map((entry) => entry.id);
  const grant = parseCollaborationRecord(CollaborationGuestGrantSchema, {
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
  return { ...grant, allWorkspacesAdmin: row.all_workspaces_admin === 1,
    workspacePermissions: Object.fromEntries(workspaces.map((entry) => [entry.id, entry.permission])) };
}

export function getCollaborationGuestByNodeInternal(nodeId: string): CollaborationGuestAccess | undefined {
  const row = getDatabase().query(`
    SELECT guest.*, owner.username AS owner_username FROM collaboration_guests guest
    JOIN webapp_users owner ON owner.id = guest.owner_user_id AND owner.disabled_at IS NULL
    WHERE guest.node_id = ?
  `).get(nodeId);
  return row ? decodeGuest(row) : undefined;
}

export function listCollaborationGuests(ownerUserId: string): CollaborationGuestAccess[] {
  return getDatabase().query(`
    SELECT guest.*, owner.username AS owner_username FROM collaboration_guests guest
    JOIN webapp_users owner ON owner.id = guest.owner_user_id AND owner.disabled_at IS NULL
    WHERE guest.owner_user_id = ? ORDER BY guest.created_at, guest.id
  `).all(ownerUserId).map(decodeGuest);
}

export function listActiveCollaborationGuestsInternal(): CollaborationGuestAccess[] {
  return getDatabase().query(`
    SELECT guest.*, owner.username AS owner_username FROM collaboration_guests guest
    JOIN webapp_users owner ON owner.id = guest.owner_user_id AND owner.disabled_at IS NULL
    WHERE guest.revoked_at IS NULL ORDER BY guest.id
  `).all().map(decodeGuest).filter((guest) => guest.allWorkspacesAdmin || guest.workspaceIds.length > 0);
}

export function updateCollaborationWorkspacePermission(input: {
  ownerUserId: string; guestId: string; workspaceId: string; permission: CollaborationWorkspacePermission;
}): void {
  assertSelectiveGrant(input.ownerUserId, input.guestId);
  const result = getDatabase().query(`
    UPDATE collaboration_memberships SET permission = ?
    WHERE guest_id = ? AND owner_user_id = ? AND workspace_id = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM collaboration_guests
        WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL)
  `).run(input.permission, input.guestId, input.ownerUserId, input.workspaceId, input.guestId, input.ownerUserId);
  if (result.changes === 0) {
    throw new DomainError("collaboration_workspace_unavailable", "The collaborator's workspace grant is unavailable.");
  }
}

function assertSelectiveGrant(ownerUserId: string, guestId: string): void {
  if (getDatabase().query(`
    SELECT 1 FROM collaboration_guests WHERE id = ? AND owner_user_id = ? AND all_workspaces_admin = 1
  `).get(guestId, ownerUserId)) {
    throw new DomainError("collaboration_admin_forbidden",
      "An administrator has access to all workspaces. Revoke the collaborator to remove this access.");
  }
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
    if (!wholeGuest) assertSelectiveGrant(input.ownerUserId, input.guestId);
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
