/**
 * SSH session persistence layer.
 */

import {
  DEFAULT_SSH_CONNECTION_MODE,
  normalizeSshSessionUseTmux,
  normalizeSshConnectionMode,
  type SshSession,
} from "../types";
import { getDatabase } from "./database";
import { createLogger } from "../core/logger";
import { requirePersistenceUserId } from "./ownership";

const log = createLogger("persistence:ssh-sessions");

const ALLOWED_SSH_SESSION_COLUMNS = new Set([
  "id",
  "user_id",
  "name",
  "workspace_id",
  "task_id",
  "directory",
  "connection_mode",
  "use_tmux",
  "remote_session_name",
  "created_at",
  "updated_at",
  "status",
  "last_connected_at",
  "error_message",
  "runtime_connection_mode",
  "notice_message",
]);

function validateColumnNames(columns: string[]): void {
  for (const column of columns) {
    if (!ALLOWED_SSH_SESSION_COLUMNS.has(column)) {
      throw new Error(`Invalid SSH session column name: ${column}`);
    }
  }
}

function sshSessionToRow(session: SshSession): Record<string, unknown> {
  return {
    id: session.config.id,
    user_id: requirePersistenceUserId(),
    name: session.config.name,
    workspace_id: session.config.workspaceId,
    task_id: session.config.taskId ?? null,
    directory: session.config.directory,
    connection_mode: session.config.connectionMode,
    use_tmux: session.config.useTmux ? 1 : 0,
    remote_session_name: session.config.remoteSessionName,
    created_at: session.config.createdAt,
    updated_at: session.config.updatedAt,
    status: session.state.status,
    last_connected_at: session.state.lastConnectedAt ?? null,
    error_message: session.state.error ?? null,
    runtime_connection_mode: session.state.runtimeConnectionMode ?? null,
    notice_message: session.state.notice ?? null,
  };
}

function rowToSshSession(row: Record<string, unknown>): SshSession {
  return {
    config: {
      id: row["id"] as string,
      name: row["name"] as string,
      workspaceId: row["workspace_id"] as string,
      taskId: (row["task_id"] as string | null) ?? undefined,
      directory: row["directory"] as string,
      connectionMode: normalizeSshConnectionMode(
        (row["connection_mode"] as SshSession["config"]["connectionMode"] | null) ?? DEFAULT_SSH_CONNECTION_MODE,
      ),
      useTmux: normalizeSshSessionUseTmux(row["use_tmux"]),
      remoteSessionName: row["remote_session_name"] as string,
      createdAt: row["created_at"] as string,
      updatedAt: row["updated_at"] as string,
    },
    state: {
      status: row["status"] as SshSession["state"]["status"],
      lastConnectedAt: (row["last_connected_at"] as string | null) ?? undefined,
      error: (row["error_message"] as string | null) ?? undefined,
      runtimeConnectionMode: (row["runtime_connection_mode"] as string | null)
        ? normalizeSshConnectionMode(row["runtime_connection_mode"])
        : undefined,
      notice: (row["notice_message"] as string | null) ?? undefined,
    },
  };
}

export async function saveSshSession(session: SshSession): Promise<void> {
  const db = getDatabase();
  const row = sshSessionToRow(session);
  const columns = Object.keys(row);
  validateColumnNames(columns);

  const placeholders = columns.map(() => "?").join(", ");
  const values = Object.values(row) as Array<string | null>;
  const updateClause = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");

  db.run(
    `INSERT INTO ssh_sessions (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updateClause}
     WHERE ssh_sessions.user_id = excluded.user_id`,
    values,
  );
  log.debug("Saved SSH session", {
    id: session.config.id,
    workspaceId: session.config.workspaceId,
    status: session.state.status,
  });
}

export async function getSshSession(id: string): Promise<SshSession | null> {
  const db = getDatabase();
  const row = db.query("SELECT * FROM ssh_sessions WHERE id = ? AND user_id = ?").get(id, requirePersistenceUserId()) as Record<string, unknown> | null;
  return row ? rowToSshSession(row) : null;
}

export async function listSshSessions(): Promise<SshSession[]> {
  const db = getDatabase();
  const rows = db.query("SELECT * FROM ssh_sessions WHERE user_id = ? ORDER BY created_at DESC").all(requirePersistenceUserId()) as Record<string, unknown>[];
  return rows.map(rowToSshSession);
}

export async function listSshSessionsByWorkspace(workspaceId: string): Promise<SshSession[]> {
  const db = getDatabase();
  const rows = db.query(
    "SELECT * FROM ssh_sessions WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC",
  ).all(workspaceId, requirePersistenceUserId()) as Record<string, unknown>[];
  return rows.map(rowToSshSession);
}

export async function getSshSessionByTaskId(taskId: string): Promise<SshSession | null> {
  const db = getDatabase();
  const row = db.query(
    "SELECT * FROM ssh_sessions WHERE task_id = ? AND user_id = ? LIMIT 1",
  ).get(taskId, requirePersistenceUserId()) as Record<string, unknown> | null;
  return row ? rowToSshSession(row) : null;
}

export async function countSshSessionsByWorkspace(workspaceId: string): Promise<number> {
  const db = getDatabase();
  const row = db.query("SELECT COUNT(*) AS count FROM ssh_sessions WHERE workspace_id = ? AND user_id = ?").get(workspaceId, requirePersistenceUserId()) as {
    count?: number;
  } | null;
  return row?.count ?? 0;
}

export async function deleteSshSession(id: string): Promise<boolean> {
  const db = getDatabase();
  const result = db.run("DELETE FROM ssh_sessions WHERE id = ? AND user_id = ?", [id, requirePersistenceUserId()]);
  return result.changes > 0;
}
