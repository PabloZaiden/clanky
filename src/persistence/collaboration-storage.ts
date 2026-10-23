/**
 * Validated collaboration storage primitives with explicit owner bindings.
 */

import { z } from "zod";
import { createLogger } from "@pablozaiden/webapp/server";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type { MeshRelayPeerIdentity } from "@/shared/mesh-relay";
import { MeshRelayPeerIdentitySchema } from "@/contracts/schemas/mesh-relay";
import { DomainError } from "../domain/domain-error";
import { getDatabase } from "./database";

const log = createLogger("persistence:collaboration");

export function parseCollaborationRecord<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    log.error("Invalid persisted collaboration metadata", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    });
    throw new DomainError("collaboration_storage_invalid", "Stored collaboration metadata is invalid.");
  }
  return parsed.data;
}

export function getCollaborationOwner(userId: string): { id: string; username: string } | undefined {
  const row = getDatabase().query(`
    SELECT id, username FROM webapp_users WHERE id = ? AND disabled_at IS NULL
  `).get(userId);
  return row
    ? parseCollaborationRecord(z.object({ id: z.string().min(1), username: z.string().min(1) }), row)
    : undefined;
}

export function getCollaborationOwnerUser(userId: string): CurrentUser | undefined {
  const row = getDatabase().query(`
    SELECT id, username, role FROM webapp_users WHERE id = ? AND disabled_at IS NULL
  `).get(userId);
  if (!row) return undefined;
  const user = parseCollaborationRecord(z.object({
    id: z.string().min(1), username: z.string().min(1),
    role: z.enum(["owner", "admin", "user"]),
  }), row);
  return { ...user, isOwner: user.role === "owner", isAdmin: user.role !== "user" };
}

export function getCollaborationControllerIdentityInternal(): MeshRelayPeerIdentity | undefined {
  const row = getDatabase().query(`
    SELECT node_id AS nodeId, public_key AS publicKey, fingerprint FROM mesh_node_identity WHERE singleton = 1
  `).get();
  return row ? parseCollaborationRecord(MeshRelayPeerIdentitySchema, row) : undefined;
}

export function collaborationWorkspaceExists(ownerUserId: string, workspaceId: string): boolean {
  return getDatabase().query(`
    SELECT 1 FROM workspaces WHERE id = ? AND user_id = ?
  `).get(workspaceId, ownerUserId) !== null;
}

export function requireCollaborationWorkspaces(ownerUserId: string, workspaceIds: readonly string[]): void {
  if (!getCollaborationOwner(ownerUserId)
    || workspaceIds.length === 0
    || workspaceIds.some((id) => !collaborationWorkspaceExists(ownerUserId, id))) {
    throw new DomainError(
      "collaboration_workspace_unavailable",
      "One or more selected workspaces are unavailable.",
    );
  }
}

export function getCollaborationResourceBinding(
  kind: "chat" | "task",
  resourceId: string,
): { ownerUserId: string; workspaceId: string | null } | undefined {
  const db = getDatabase();
  const row = kind === "chat"
    ? db.query("SELECT user_id AS ownerUserId, workspace_id AS workspaceId FROM chats WHERE id = ?").get(resourceId)
    : db.query("SELECT user_id AS ownerUserId, workspace_id AS workspaceId FROM tasks WHERE id = ?").get(resourceId);
  return row ? parseCollaborationRecord(z.object({
    ownerUserId: z.string().min(1),
    workspaceId: z.string().min(1).nullable(),
  }), row) : undefined;
}
