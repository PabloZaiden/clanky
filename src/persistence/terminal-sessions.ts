/**
 * Workspace terminal session persistence layer.
 */

import {
  DEFAULT_TERMINAL_CONNECTION_MODE,
  normalizeTerminalUseTmux,
  normalizeTerminalConnectionMode,
  type TerminalSession,
} from "@/shared";
import { getDatabase } from "./database";
import { createLogger } from "@pablozaiden/webapp/server";
import { filterWorkspacePersistenceRows, requireResourcePersistenceUserId, workspacePersistenceParameters } from "./ownership";
import { recordWorkspaceResourceCreation } from "./collaboration-creation";
import { getWorkspaceAccessAuthority } from "../context/user-context";
import { isSqliteUniqueConstraintError, uniqueConstraintError } from "./errors";
import {
  EXECUTION_HOST_JOIN_COLUMNS,
  executionHostBindingFromRow,
  resolveExecutionHostBindingId,
} from "./execution-hosts";

const log = createLogger("persistence:terminal-sessions");

export function resetTerminalConnections(): number {
  return getDatabase().run(
    "UPDATE terminal_sessions SET status = 'disconnected' WHERE user_id = ? AND (? IS NULL OR workspace_id = ?) AND status IN ('connected', 'connecting')",
    [requireResourcePersistenceUserId("terminal"), ...workspacePersistenceParameters()],
  ).changes;
}

const ALLOWED_TERMINAL_SESSION_COLUMNS = new Set([
  "id",
  "user_id",
  "name",
  "workspace_id",
  "task_id",
  "collaboration_principal_id",
  "directory",
  "connection_mode",
  "use_tmux",
  "remote_session_name",
  "workspace_execution_target_revision",
  "created_at",
  "updated_at",
  "is_private",
  "status",
  "last_connected_at",
  "error_message",
  "runtime_connection_mode",
  "notice_message",
  "execution_host_id",
  "execution_host_revision",
]);

const TERMINAL_SESSION_SELECT = `
  SELECT terminal_session.*, ${EXECUTION_HOST_JOIN_COLUMNS}
  FROM terminal_sessions terminal_session
  LEFT JOIN execution_hosts execution_host
    ON execution_host.id = terminal_session.execution_host_id
    AND execution_host.user_id = terminal_session.user_id
`;

function validateColumnNames(columns: string[]): void {
  for (const column of columns) {
    if (!ALLOWED_TERMINAL_SESSION_COLUMNS.has(column)) {
      throw new Error(`Invalid terminal session column name: ${column}`);
    }
  }
}

function terminalSessionToRow(session: TerminalSession): Record<string, unknown> {
  const userId = requireResourcePersistenceUserId("terminal", session.config.id, session.config.workspaceId ?? null);
  const existing = getDatabase().query("SELECT collaboration_principal_id FROM terminal_sessions WHERE id = ? AND user_id = ?")
    .get(session.config.id, userId) as { collaboration_principal_id: string } | null;
  return {
    id: session.config.id,
    user_id: userId,
    name: session.config.name,
    workspace_id: session.config.workspaceId ?? null,
    task_id: session.config.taskId ?? null,
    collaboration_principal_id: existing?.collaboration_principal_id ?? getWorkspaceAccessAuthority()?.guestId ?? "owner",
    directory: session.config.directory,
    connection_mode: session.config.connectionMode,
    use_tmux: session.config.useTmux ? 1 : 0,
    remote_session_name: session.config.remoteSessionName,
    workspace_execution_target_revision:
      session.config.workspaceExecutionTargetRevision ?? null,
    created_at: session.config.createdAt,
    updated_at: session.config.updatedAt,
    is_private: session.config.isPrivate ? 1 : 0,
    status: session.state.status,
    last_connected_at: session.state.lastConnectedAt ?? null,
    error_message: session.state.error ?? null,
    runtime_connection_mode: session.state.runtimeConnectionMode ?? null,
    notice_message: session.state.notice ?? null,
    execution_host_id: resolveExecutionHostBindingId(
      userId,
      session.config.executionHostBinding,
    ),
    execution_host_revision: session.config.executionHostBinding.revision,
  };
}

function rowToTerminalSession(row: Record<string, unknown>): TerminalSession {
  return {
    config: {
      id: row["id"] as string,
      name: row["name"] as string,
      workspaceId: (row["workspace_id"] as string | null) ?? undefined,
      taskId: (row["task_id"] as string | null) ?? undefined,
      directory: row["directory"] as string,
      connectionMode: normalizeTerminalConnectionMode(
        (row["connection_mode"] as string | null) ?? DEFAULT_TERMINAL_CONNECTION_MODE,
      ),
      useTmux: normalizeTerminalUseTmux(row["use_tmux"]),
      remoteSessionName: row["remote_session_name"] as string,
      workspaceExecutionTargetRevision:
        (row["workspace_execution_target_revision"] as number | null) ?? undefined,
      executionHostBinding: requireExecutionHostBinding(row),
      createdAt: row["created_at"] as string,
      updatedAt: row["updated_at"] as string,
      isPrivate: row["is_private"] === 1,
    },
    state: {
      status: row["status"] as TerminalSession["state"]["status"],
      lastConnectedAt: (row["last_connected_at"] as string | null) ?? undefined,
      error: (row["error_message"] as string | null) ?? undefined,
      runtimeConnectionMode: (row["runtime_connection_mode"] as string | null)
        ? normalizeTerminalConnectionMode(row["runtime_connection_mode"])
        : undefined,
      notice: (row["notice_message"] as string | null) ?? undefined,
    },
  };
}

function requireExecutionHostBinding(
  row: Record<string, unknown>,
): TerminalSession["config"]["executionHostBinding"] {
  const binding = executionHostBindingFromRow(row);
  if (!binding) {
    throw new Error(`Terminal session ${String(row["id"])} has no execution-host binding`);
  }
  return binding;
}

export async function saveTerminalSession(session: TerminalSession): Promise<void> {
  const db = getDatabase();
  const row = terminalSessionToRow(session);
  const columns = Object.keys(row);
  validateColumnNames(columns);

  const placeholders = columns.map(() => "?").join(", ");
  const values = Object.values(row) as Array<string | number | null>;
  const updateClause = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");

  try {
    db.transaction(() => {
      const exists = db.query("SELECT 1 FROM terminal_sessions WHERE id = ?").get(session.config.id);
      db.run(
      `INSERT INTO terminal_sessions (${columns.join(", ")}) VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updateClause}
       WHERE terminal_sessions.user_id = excluded.user_id`,
      values,
      );
      if (!exists) recordWorkspaceResourceCreation({ kind: "terminal", id: session.config.id,
        ownerUserId: String(row["user_id"]), workspaceId: session.config.workspaceId });
    })();
  } catch (error) {
    if (isSqliteUniqueConstraintError(error)) {
      throw uniqueConstraintError(
        "Terminal session task uniqueness constraint violated",
        { table: "terminal_sessions", constraint: "task_id" },
        error,
      );
    }
    throw error;
  }
  log.debug("Saved terminal session", {
    id: session.config.id,
    workspaceId: session.config.workspaceId,
    status: session.state.status,
  });
}

export async function getTerminalSession(id: string): Promise<TerminalSession | null> {
  const db = getDatabase();
  const row = db.query(
    `${TERMINAL_SESSION_SELECT}
     WHERE terminal_session.id = ? AND terminal_session.user_id = ?`,
  ).get(id, requireResourcePersistenceUserId("terminal", id)) as Record<string, unknown> | null;
  return row ? rowToTerminalSession(row) : null;
}

export async function listTerminalSessions(): Promise<TerminalSession[]> {
  const db = getDatabase();
  const rows = db.query(
    `${TERMINAL_SESSION_SELECT}
     WHERE terminal_session.user_id = ? AND (? IS NULL OR terminal_session.workspace_id = ?)
     ORDER BY terminal_session.created_at DESC`,
  ).all(requireResourcePersistenceUserId("terminal"), ...workspacePersistenceParameters()) as Record<string, unknown>[];
  return filterWorkspacePersistenceRows(rows, "terminal").map(rowToTerminalSession);
}

export async function listTerminalSessionsByWorkspace(workspaceId: string): Promise<TerminalSession[]> {
  const db = getDatabase();
  const rows = db.query(
    `${TERMINAL_SESSION_SELECT}
     WHERE terminal_session.workspace_id = ? AND terminal_session.user_id = ?
     ORDER BY terminal_session.created_at DESC`,
  ).all(workspaceId, requireResourcePersistenceUserId("terminal", undefined, workspaceId)) as Record<string, unknown>[];
  return filterWorkspacePersistenceRows(rows, "terminal").map(rowToTerminalSession);
}

export async function getTerminalSessionByTaskId(taskId: string): Promise<TerminalSession | null> {
  const db = getDatabase();
  const row = db.query(
    `${TERMINAL_SESSION_SELECT}
     WHERE terminal_session.task_id = ? AND terminal_session.user_id = ? AND terminal_session.collaboration_principal_id = ?
     LIMIT 1`,
  ).get(taskId, requireResourcePersistenceUserId("task", taskId), getWorkspaceAccessAuthority()?.guestId ?? "owner") as Record<string, unknown> | null;
  if (row) requireResourcePersistenceUserId("terminal", String(row["id"]));
  return row ? rowToTerminalSession(row) : null;
}

export async function listTerminalSessionsByTaskId(taskId: string): Promise<TerminalSession[]> {
  const rows = getDatabase().query(
    `${TERMINAL_SESSION_SELECT}
     WHERE terminal_session.task_id = ? AND terminal_session.user_id = ?
       AND (? IS NULL OR terminal_session.workspace_id = ?)`,
  ).all(taskId, requireResourcePersistenceUserId("task", taskId), ...workspacePersistenceParameters()) as Record<string, unknown>[];
  return filterWorkspacePersistenceRows(rows, "terminal").map(rowToTerminalSession);
}

export async function countTerminalSessionsByWorkspace(workspaceId: string): Promise<number> {
  const db = getDatabase();
  const row = db.query(
    "SELECT COUNT(*) AS count FROM terminal_sessions WHERE workspace_id = ? AND user_id = ?",
  ).get(workspaceId, requireResourcePersistenceUserId("terminal", undefined, workspaceId)) as { count?: number } | null;
  return row?.count ?? 0;
}

export async function deleteTerminalSession(id: string): Promise<boolean> {
  const db = getDatabase();
  const userId = requireResourcePersistenceUserId("terminal", id);
  const result = db.run(
    "DELETE FROM terminal_sessions WHERE id = ? AND user_id = ?",
    [id, userId],
  );
  return result.changes > 0;
}
