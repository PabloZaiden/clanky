/**
 * Row conversion helpers for Clanky's managed context-key associations.
 */

import {
  MANAGED_CONTEXT_TYPES,
  type ManagedContextType,
} from "@/shared/context-api-key";
import type { ContextApiKeyAssociation, NewContextApiKeyAssociation } from "./types";

function isManagedContextType(value: unknown): value is ManagedContextType {
  return typeof value === "string"
    && MANAGED_CONTEXT_TYPES.includes(value as ManagedContextType);
}

export function associationToRow(
  association: NewContextApiKeyAssociation & { userId: string },
): Record<string, unknown> {
  return {
    user_id: association.userId,
    workspace_id: association.workspaceId,
    context_type: association.contextType,
    context_id: association.contextId,
    api_key_id: association.apiKeyId,
    generation: association.generation,
    created_at: association.createdAt ?? new Date().toISOString(),
    revoked_at: association.revokedAt ?? null,
  };
}

export function rowToAssociation(row: Record<string, unknown>): ContextApiKeyAssociation {
  const contextType = row["context_type"];
  const generation = row["generation"];
  if (!isManagedContextType(contextType)) {
    throw new Error(`Invalid managed context type in persisted association: ${String(contextType)}`);
  }
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    throw new Error(`Invalid managed context generation in persisted association: ${String(generation)}`);
  }

  return {
    userId: row["user_id"] as string,
    workspaceId: row["workspace_id"] as string,
    contextType,
    contextId: row["context_id"] as string,
    apiKeyId: row["api_key_id"] as string,
    generation,
    createdAt: row["created_at"] as string,
    revokedAt: typeof row["revoked_at"] === "string" ? row["revoked_at"] : undefined,
  };
}
