/**
 * Immutable creator metadata, without activity timestamps or action history.
 */

import { z } from "zod";
import type { CollaborationAuthorship, CollaborationCreator } from "@/shared/collaboration";
import { CollaborationAuthorshipSchema } from "@/contracts/schemas/collaboration";
import { DomainError } from "../domain/domain-error";
import { getDatabase } from "./database";
import {
  getCollaborationOwner,
  getCollaborationResourceBinding,
  parseCollaborationRecord,
} from "./collaboration-storage";

export function collaborationCreatorProjection(kind: "chat" | "task"): string {
  const table = kind === "chat" ? "chats" : "tasks";
  const resourceKind = kind === "chat" ? "'chat'" : "'task'";
  return `COALESCE(
    (SELECT json_object('kind', attribution.creator_kind, 'id', attribution.creator_id, 'name', attribution.creator_name)
      FROM collaboration_authorship attribution
      WHERE attribution.resource_kind = ${resourceKind} AND attribution.resource_id = ${table}.id
        AND attribution.owner_user_id = ${table}.user_id AND attribution.workspace_id = ${table}.workspace_id),
    (SELECT json_object('kind', 'user', 'id', owner.id, 'name', owner.username)
      FROM webapp_users owner WHERE owner.id = ${table}.user_id AND owner.disabled_at IS NULL)
  ) AS collaboration_creator_json`;
}

export function collaborationCreatorFromRow(row: Record<string, unknown>): CollaborationCreator | undefined {
  const raw = row["collaboration_creator_json"];
  if (raw === null || raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(z.string().parse(raw)) as unknown;
  } catch (cause) {
    throw new DomainError("collaboration_storage_invalid", "Stored creator metadata is invalid.", { cause });
  }
  return parseCollaborationRecord(CollaborationAuthorshipSchema.shape.creator, value);
}

export function getCollaborationAuthorship(
  kind: "chat" | "task",
  resourceId: string,
  ownerUserId: string,
  workspaceId: string,
): CollaborationAuthorship | undefined {
  const binding = getCollaborationResourceBinding(kind, resourceId);
  if (!binding || binding.ownerUserId !== ownerUserId || binding.workspaceId !== workspaceId) {
    throw new DomainError("collaboration_resource_unavailable", "The resource is outside the authorized workspace.");
  }
  const value = getDatabase().query(`
    SELECT resource_kind, resource_id, owner_user_id, workspace_id, creator_kind, creator_id, creator_name
    FROM collaboration_authorship
    WHERE resource_kind = ? AND resource_id = ? AND owner_user_id = ? AND workspace_id = ?
  `).get(kind, resourceId, ownerUserId, workspaceId);
  if (value) {
    const row = parseCollaborationRecord(z.object({
      resource_kind: z.enum(["chat", "task"]), resource_id: z.string(),
      owner_user_id: z.string(), workspace_id: z.string(),
      creator_kind: z.enum(["user", "guest"]), creator_id: z.string(), creator_name: z.string(),
    }), value);
    return parseCollaborationRecord(CollaborationAuthorshipSchema, {
      resourceKind: row.resource_kind, resourceId: row.resource_id,
      ownerUserId: row.owner_user_id, workspaceId: row.workspace_id,
      creator: { kind: row.creator_kind, id: row.creator_id, name: row.creator_name },
    });
  }
  const owner = getCollaborationOwner(ownerUserId);
  return owner ? { resourceKind: kind, resourceId, ownerUserId, workspaceId,
    creator: { kind: "user", id: owner.id, name: owner.username } } : undefined;
}

export function setCollaborationAuthorshipOnce(authorship: CollaborationAuthorship): CollaborationAuthorship {
  const validated = parseCollaborationRecord(CollaborationAuthorshipSchema, authorship);
  const db = getDatabase();
  return db.transaction(() => {
    const binding = getCollaborationResourceBinding(validated.resourceKind, validated.resourceId);
    if (!binding || binding.ownerUserId !== validated.ownerUserId || binding.workspaceId !== validated.workspaceId) {
      throw new DomainError("collaboration_resource_unavailable", "The resource is outside the authorized workspace.");
    }
    db.query(`
      INSERT INTO collaboration_authorship
        (resource_kind, resource_id, owner_user_id, workspace_id, creator_kind, creator_id, creator_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource_kind, resource_id) DO NOTHING
    `).run(validated.resourceKind, validated.resourceId, validated.ownerUserId, validated.workspaceId,
      validated.creator.kind, validated.creator.id, validated.creator.name);
    const stored = getCollaborationAuthorship(validated.resourceKind, validated.resourceId,
      validated.ownerUserId, validated.workspaceId);
    if (!stored) {
      throw new DomainError("collaboration_storage_invalid", "Creator metadata could not be loaded.");
    }
    return stored;
  }).immediate();
}
