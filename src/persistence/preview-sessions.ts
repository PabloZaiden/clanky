/**
 * Preview session persistence layer.
 */

import type { PreviewSession, PreviewSessionStatus } from "../types";
import { createLogger } from "../core/logger";
import { getDatabase } from "./database";
import { requirePersistenceUserId } from "./ownership";

const log = createLogger("persistence:preview-sessions");

function previewToRow(preview: PreviewSession): Record<string, number | string | null> {
  return {
    id: preview.config.id,
    user_id: requirePersistenceUserId(),
    workspace_id: preview.config.workspaceId,
    remote_host: preview.config.remoteHost,
    remote_port: preview.config.remotePort,
    local_host: preview.config.localHost,
    local_port: preview.config.localPort,
    local_url: preview.config.localUrl,
    initial_path: preview.config.initialPath,
    cli_client_id: preview.config.cliClientId ?? null,
    cli_hostname: preview.config.cliHostname ?? null,
    created_at: preview.config.createdAt,
    updated_at: preview.config.updatedAt,
    status: preview.state.status,
    connected_at: preview.state.connectedAt ?? null,
    closed_at: preview.state.closedAt ?? null,
    error_message: preview.state.error ?? null,
  };
}

function rowToPreview(row: Record<string, unknown>): PreviewSession {
  return {
    config: {
      id: row["id"] as string,
      workspaceId: row["workspace_id"] as string,
      remoteHost: row["remote_host"] as string,
      remotePort: row["remote_port"] as number,
      localHost: row["local_host"] as string,
      localPort: row["local_port"] as number,
      localUrl: row["local_url"] as string,
      initialPath: row["initial_path"] as string,
      cliClientId: (row["cli_client_id"] as string | null) ?? undefined,
      cliHostname: (row["cli_hostname"] as string | null) ?? undefined,
      createdAt: row["created_at"] as string,
      updatedAt: row["updated_at"] as string,
    },
    state: {
      status: row["status"] as PreviewSessionStatus,
      connectedAt: (row["connected_at"] as string | null) ?? undefined,
      closedAt: (row["closed_at"] as string | null) ?? undefined,
      error: (row["error_message"] as string | null) ?? undefined,
    },
  };
}

export async function savePreviewSession(preview: PreviewSession): Promise<void> {
  const db = getDatabase();
  const row = previewToRow(preview);
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  const updateClause = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");

  db.run(
    `INSERT INTO preview_sessions (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updateClause}
     WHERE preview_sessions.user_id = excluded.user_id`,
    Object.values(row),
  );
  log.debug("Saved preview session", { id: preview.config.id, status: preview.state.status });
}

export async function getPreviewSession(id: string): Promise<PreviewSession | null> {
  const db = getDatabase();
  const row = db.query("SELECT * FROM preview_sessions WHERE id = ? AND user_id = ?").get(
    id,
    requirePersistenceUserId(),
  ) as Record<string, unknown> | null;
  return row ? rowToPreview(row) : null;
}

export async function deletePreviewSession(id: string): Promise<void> {
  const db = getDatabase();
  db.run(
    "DELETE FROM preview_sessions WHERE id = ? AND user_id = ?",
    [id, requirePersistenceUserId()],
  );
  log.debug("Deleted preview session", { id });
}

export async function listPreviewSessionsByWorkspaceAndStatuses(
  workspaceId: string,
  statuses: PreviewSessionStatus[],
): Promise<PreviewSession[]> {
  if (statuses.length === 0) {
    return [];
  }
  const placeholders = statuses.map(() => "?").join(", ");
  const db = getDatabase();
  const rows = db.query(`
    SELECT * FROM preview_sessions
    WHERE workspace_id = ? AND user_id = ? AND status IN (${placeholders})
    ORDER BY updated_at DESC
  `).all(workspaceId, requirePersistenceUserId(), ...statuses) as Record<string, unknown>[];
  return rows.map(rowToPreview);
}

export async function listPreviewSessionsByStatuses(
  statuses: PreviewSessionStatus[],
): Promise<PreviewSession[]> {
  if (statuses.length === 0) {
    return [];
  }
  const placeholders = statuses.map(() => "?").join(", ");
  const db = getDatabase();
  const rows = db.query(`
    SELECT * FROM preview_sessions
    WHERE user_id = ? AND status IN (${placeholders})
    ORDER BY updated_at DESC
  `).all(requirePersistenceUserId(), ...statuses) as Record<string, unknown>[];
  return rows.map(rowToPreview);
}
