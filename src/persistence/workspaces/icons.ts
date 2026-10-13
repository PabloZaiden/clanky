/**
 * Private workspace icon storage.
 */

import type {
  WorkspaceIconMetadata,
  WorkspaceIconMimeType,
} from "@/shared/workspace";
import { getDatabase } from "../database";
import { requirePersistenceUserId } from "../ownership";

export interface StoredWorkspaceIcon extends WorkspaceIconMetadata {
  content: Uint8Array;
}

export async function getWorkspaceIcon(
  workspaceId: string,
): Promise<StoredWorkspaceIcon | null> {
  const row = getDatabase().prepare(`
    SELECT mime_type, content, updated_at
    FROM workspace_icons
    WHERE workspace_id = ? AND user_id = ?
  `).get(workspaceId, requirePersistenceUserId()) as {
    mime_type: WorkspaceIconMimeType;
    content: Uint8Array;
    updated_at: string;
  } | null;

  if (!row) {
    return null;
  }
  return {
    mimeType: row.mime_type,
    content: new Uint8Array(row.content),
    updatedAt: row.updated_at,
  };
}

export async function saveWorkspaceIcon(
  workspaceId: string,
  mimeType: WorkspaceIconMimeType,
  content: Uint8Array,
): Promise<WorkspaceIconMetadata> {
  const updatedAt = new Date().toISOString();
  getDatabase().prepare(`
    INSERT INTO workspace_icons (workspace_id, user_id, mime_type, content, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      user_id = excluded.user_id,
      mime_type = excluded.mime_type,
      content = excluded.content,
      updated_at = excluded.updated_at
  `).run(
    workspaceId,
    requirePersistenceUserId(),
    mimeType,
    content,
    updatedAt,
  );
  return { mimeType, updatedAt };
}

export async function deleteWorkspaceIcon(workspaceId: string): Promise<void> {
  getDatabase().prepare(`
    DELETE FROM workspace_icons
    WHERE workspace_id = ? AND user_id = ?
  `).run(workspaceId, requirePersistenceUserId());
}
