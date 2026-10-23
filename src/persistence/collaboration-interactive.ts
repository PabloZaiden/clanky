/**
 * Interactive transport principals are immutable and independent of job data.
 */

import { z } from "zod";
import type { CollaborationInteractiveResource } from "@/shared/collaboration";
import { CollaborationInteractiveResourceSchema } from "@/contracts/schemas/collaboration";
import { DomainError } from "../domain/domain-error";
import { getDatabase } from "./database";
import { parseCollaborationRecord } from "./collaboration-storage";

const InteractiveBindingSchema = z.object({
  id: z.string().min(1), ownerUserId: z.string().min(1), workspaceId: z.string().min(1).nullable(),
});

function loadBinding(kind: "terminal" | "preview", id: string): {
  id: string; ownerUserId: string; workspaceId: string | null;
} | undefined {
  const db = getDatabase();
  const row = kind === "terminal"
    ? db.query("SELECT id, user_id AS ownerUserId, workspace_id AS workspaceId FROM terminal_sessions WHERE id = ?").get(id)
    : db.query("SELECT id, user_id AS ownerUserId, workspace_id AS workspaceId FROM preview_sessions WHERE id = ?").get(id);
  return row ? parseCollaborationRecord(InteractiveBindingSchema, row) : undefined;
}

function decodeInteractive(value: unknown): CollaborationInteractiveResource {
  const row = parseCollaborationRecord(z.object({
    resource_kind: z.enum(["terminal", "preview"]),
    resource_id: z.string(),
    owner_user_id: z.string(),
    workspace_id: z.string(),
    membership_id: z.string().nullable(),
  }), value);
  return parseCollaborationRecord(CollaborationInteractiveResourceSchema, {
    kind: row.resource_kind, id: row.resource_id, ownerUserId: row.owner_user_id,
    workspaceId: row.workspace_id, membershipId: row.membership_id,
  });
}

export function getCollaborationInteractiveResource(
  kind: "terminal" | "preview",
  id: string,
): CollaborationInteractiveResource | undefined {
  const binding = loadBinding(kind, id);
  if (!binding?.workspaceId) return undefined;
  const row = getDatabase().query(`
    SELECT * FROM collaboration_interactive_resources WHERE resource_kind = ? AND resource_id = ?
  `).get(kind, id);
  if (!row) {
    return { kind, id, ownerUserId: binding.ownerUserId, workspaceId: binding.workspaceId, membershipId: null };
  }
  const resource = decodeInteractive(row);
  if (resource.ownerUserId !== binding.ownerUserId || resource.workspaceId !== binding.workspaceId) {
    throw new DomainError("collaboration_storage_invalid", "Interactive resource ownership is inconsistent.");
  }
  return resource;
}

export function claimCollaborationInteractiveResource(
  claim: CollaborationInteractiveResource,
): CollaborationInteractiveResource {
  const validated = parseCollaborationRecord(CollaborationInteractiveResourceSchema, claim);
  const db = getDatabase();
  return db.transaction(() => {
    const binding = loadBinding(validated.kind, validated.id);
    if (!binding || binding.ownerUserId !== validated.ownerUserId || binding.workspaceId !== validated.workspaceId) {
      throw new DomainError("collaboration_resource_unavailable", "The interactive resource is outside the authorized workspace.");
    }
    if (validated.membershipId !== null && !db.query(`
      SELECT 1 FROM collaboration_memberships membership
      JOIN collaboration_guests guest ON guest.id = membership.guest_id
        AND guest.owner_user_id = membership.owner_user_id
      WHERE membership.guest_id = ? AND membership.owner_user_id = ?
        AND membership.workspace_id = ? AND membership.revoked_at IS NULL AND guest.revoked_at IS NULL
    `).get(validated.membershipId, validated.ownerUserId, validated.workspaceId)) {
      throw new DomainError("collaboration_access_denied", "Workspace access is no longer available.");
    }
    db.query(`
      INSERT INTO collaboration_interactive_resources
        (resource_kind, resource_id, owner_user_id, workspace_id, membership_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(resource_kind, resource_id) DO NOTHING
    `).run(validated.kind, validated.id, validated.ownerUserId, validated.workspaceId, validated.membershipId);
    const stored = getCollaborationInteractiveResource(validated.kind, validated.id);
    if (!stored || stored.membershipId !== validated.membershipId) {
      throw new DomainError("collaboration_interactive_forbidden", "This interactive resource belongs to another participant.");
    }
    return stored;
  }).immediate();
}

export function listCollaborationInteractiveResourcesForPrincipal(input: {
  ownerUserId: string; membershipId: string | null; workspaceId?: string; kind?: "terminal" | "preview";
}): CollaborationInteractiveResource[] {
  const rows = getDatabase().query(`
    SELECT * FROM collaboration_interactive_resources
    WHERE owner_user_id = ? AND membership_id IS ?
      AND (? IS NULL OR workspace_id = ?) AND (? IS NULL OR resource_kind = ?)
    ORDER BY resource_kind, resource_id
  `).all(input.ownerUserId, input.membershipId, input.workspaceId ?? null, input.workspaceId ?? null,
    input.kind ?? null, input.kind ?? null);
  return rows.map(decodeInteractive).filter((resource) =>
    getCollaborationInteractiveResource(resource.kind, resource.id) !== undefined);
}
