/**
 * Persistence operations for Clanky's managed context-key associations.
 *
 * Plaintext API-key tokens are deliberately not represented by this module.
 */

import type { ManagedContextType } from "@/shared/context-api-key";
import { getDatabase } from "../database";
import { requirePersistenceUserId } from "../ownership";
import { associationToRow, rowToAssociation } from "./helpers";
import type { ContextApiKeyAssociation, NewContextApiKeyAssociation } from "./types";

function listAssociationsForUser(userId: string): ContextApiKeyAssociation[] {
  const rows = getDatabase()
    .prepare(`
      SELECT user_id, workspace_id, context_type, context_id, api_key_id,
        generation, created_at, revoked_at
      FROM clanky_context_api_keys
      WHERE user_id = ?
      ORDER BY created_at ASC, generation ASC
    `)
    .all(userId) as Record<string, unknown>[];
  return rows.map(rowToAssociation);
}

export async function createContextApiKeyAssociation(
  association: NewContextApiKeyAssociation,
): Promise<ContextApiKeyAssociation> {
  return await createContextApiKeyAssociationForUser(requirePersistenceUserId(), association);
}

export async function createContextApiKeyAssociationForUser(
  userId: string,
  association: NewContextApiKeyAssociation,
): Promise<ContextApiKeyAssociation> {
  const createdAt = association.createdAt ?? new Date().toISOString();
  const row = associationToRow({ ...association, userId, createdAt });
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  const values = Object.values(row) as (string | number | null)[];
  getDatabase()
    .prepare(`INSERT INTO clanky_context_api_keys (${columns.join(", ")}) VALUES (${placeholders})`)
    .run(...values);
  return {
    userId,
    workspaceId: association.workspaceId,
    contextType: association.contextType,
    contextId: association.contextId,
    apiKeyId: association.apiKeyId,
    generation: association.generation,
    createdAt,
    ...(association.revokedAt !== undefined ? { revokedAt: association.revokedAt } : {}),
  };
}

export async function listContextApiKeyAssociations(): Promise<ContextApiKeyAssociation[]> {
  return listAssociationsForUser(requirePersistenceUserId());
}

export async function listContextApiKeyAssociationsForUser(userId: string): Promise<ContextApiKeyAssociation[]> {
  return listAssociationsForUser(userId);
}

export async function listContextApiKeyAssociationsForContext(
  workspaceId: string,
  contextType: ManagedContextType,
  contextId: string,
): Promise<ContextApiKeyAssociation[]> {
  return await listContextApiKeyAssociationsForContextForUser(
    requirePersistenceUserId(),
    workspaceId,
    contextType,
    contextId,
  );
}

export async function listContextApiKeyAssociationsForContextForUser(
  userId: string,
  workspaceId: string,
  contextType: ManagedContextType,
  contextId: string,
): Promise<ContextApiKeyAssociation[]> {
  const rows = getDatabase()
    .prepare(`
      SELECT user_id, workspace_id, context_type, context_id, api_key_id,
        generation, created_at, revoked_at
      FROM clanky_context_api_keys
      WHERE user_id = ? AND workspace_id = ? AND context_type = ? AND context_id = ?
      ORDER BY generation ASC
    `)
    .all(userId, workspaceId, contextType, contextId) as Record<string, unknown>[];
  return rows.map(rowToAssociation);
}

export async function getNextContextApiKeyGeneration(
  workspaceId: string,
  contextType: ManagedContextType,
  contextId: string,
): Promise<number> {
  return await getNextContextApiKeyGenerationForUser(
    requirePersistenceUserId(),
    workspaceId,
    contextType,
    contextId,
  );
}

export async function getNextContextApiKeyGenerationForUser(
  userId: string,
  workspaceId: string,
  contextType: ManagedContextType,
  contextId: string,
): Promise<number> {
  const row = getDatabase()
    .prepare(`
      SELECT COALESCE(MAX(generation), 0) AS generation
      FROM clanky_context_api_keys
      WHERE user_id = ? AND workspace_id = ? AND context_type = ? AND context_id = ?
    `)
    .get(userId, workspaceId, contextType, contextId) as { generation?: number } | null;
  return (row?.generation ?? 0) + 1;
}

export async function revokeContextApiKeyAssociation(apiKeyId: string): Promise<boolean> {
  return await revokeContextApiKeyAssociationForUser(requirePersistenceUserId(), apiKeyId);
}

export async function revokeContextApiKeyAssociationForUser(
  userId: string,
  apiKeyId: string,
): Promise<boolean> {
  const result = getDatabase()
    .prepare(`
      UPDATE clanky_context_api_keys
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE user_id = ? AND api_key_id = ?
    `)
    .run(new Date().toISOString(), userId, apiKeyId);
  return result.changes > 0;
}
