/**
 * Workspace terminal session persistence layer.
 */

import {
  DEFAULT_TERMINAL_CONNECTION_MODE,
  normalizeTerminalUseTmux,
  normalizeTerminalConnectionMode,
  type WorkspaceTerminalSession,
  type TerminalTargetBinding,
} from "@/shared";
import { getDatabase } from "./database";
import { createLogger } from "@pablozaiden/webapp/server";
import { requirePersistenceUserId } from "./ownership";
import { isSqliteUniqueConstraintError, uniqueConstraintError } from "./errors";
import {
  EXECUTION_HOST_JOIN_COLUMNS,
  executionHostBindingFromRow,
  resolveExecutionHostBindingId,
} from "./execution-hosts";

const log = createLogger("persistence:terminal-sessions");

const ALLOWED_TERMINAL_SESSION_COLUMNS = new Set([
  "id",
  "user_id",
  "name",
  "workspace_id",
  "task_id",
  "directory",
  "connection_mode",
  "use_tmux",
  "remote_session_name",
  "target_transport",
  "target_key",
  "target_revision",
  "target_hostname",
  "target_port",
  "target_username",
  "target_execution_node_id",
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

function serializeTargetBinding(binding: TerminalTargetBinding): Record<string, unknown> {
  return {
    target_transport: binding.transport,
    target_key: binding.targetKey,
    target_revision: binding.workspaceRevision,
    target_hostname: binding.hostname ?? null,
    target_port: binding.port ?? null,
    target_username: binding.username ?? null,
    target_execution_node_id: binding.executionNodeId ?? null,
  };
}

function deserializeTargetBinding(row: Record<string, unknown>): TerminalTargetBinding {
  const transport = (row["target_transport"] as string) === "ssh" ? "ssh" as const : "stdio" as const;
  const targetKey = typeof row["target_key"] === "string" ? row["target_key"] : "";
  const targetRevision = typeof row["target_revision"] === "number"
    ? Math.max(1, Math.floor(row["target_revision"] as number))
    : 1;
  const binding: TerminalTargetBinding = {
    transport,
    targetKey,
    workspaceRevision: targetRevision,
  };
  if (transport === "ssh") {
    const hostname = row["target_hostname"] as string | null;
    if (hostname) binding.hostname = hostname;
    const port = row["target_port"] as number | null;
    if (port !== null && port !== undefined) binding.port = port;
    const username = row["target_username"] as string | null;
    if (username) binding.username = username;
  } else {
    const executionNodeId = row["target_execution_node_id"] as string | null;
    if (executionNodeId) binding.executionNodeId = executionNodeId;
  }
  return binding;
}

function terminalSessionToRow(session: WorkspaceTerminalSession): Record<string, unknown> {
  const userId = requirePersistenceUserId();
  return {
    id: session.config.id,
    user_id: userId,
    name: session.config.name,
    workspace_id: session.config.workspaceId ?? null,
    task_id: session.config.taskId ?? null,
    directory: session.config.directory,
    connection_mode: session.config.connectionMode,
    use_tmux: session.config.useTmux ? 1 : 0,
    remote_session_name: session.config.remoteSessionName,
    ...serializeTargetBinding(session.config.targetBinding),
    created_at: session.config.createdAt,
    updated_at: session.config.updatedAt,
    is_private: session.config.isPrivate ? 1 : 0,
    status: session.state.status,
    last_connected_at: session.state.lastConnectedAt ?? null,
    error_message: session.state.error ?? null,
    runtime_connection_mode: session.state.runtimeConnectionMode ?? null,
    notice_message: session.state.notice ?? null,
    execution_host_id: session.config.executionHostBinding
      ? resolveExecutionHostBindingId(userId, session.config.executionHostBinding)
      : null,
    execution_host_revision: session.config.executionHostBinding?.revision ?? null,
  };
}

function rowToTerminalSession(row: Record<string, unknown>): WorkspaceTerminalSession {
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
      targetBinding: deserializeTargetBinding(row),
      executionHostBinding: executionHostBindingFromRow(row),
      createdAt: row["created_at"] as string,
      updatedAt: row["updated_at"] as string,
      isPrivate: row["is_private"] === 1,
    },
    state: {
      status: row["status"] as WorkspaceTerminalSession["state"]["status"],
      lastConnectedAt: (row["last_connected_at"] as string | null) ?? undefined,
      error: (row["error_message"] as string | null) ?? undefined,
      runtimeConnectionMode: (row["runtime_connection_mode"] as string | null)
        ? normalizeTerminalConnectionMode(row["runtime_connection_mode"])
        : undefined,
      notice: (row["notice_message"] as string | null) ?? undefined,
    },
  };
}

export async function saveTerminalSession(session: WorkspaceTerminalSession): Promise<void> {
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
    db.run(
      `INSERT INTO terminal_sessions (${columns.join(", ")}) VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updateClause}
       WHERE terminal_sessions.user_id = excluded.user_id`,
      values,
    );
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

export async function getTerminalSession(id: string): Promise<WorkspaceTerminalSession | null> {
  const db = getDatabase();
  const row = db.query(
    `${TERMINAL_SESSION_SELECT}
     WHERE terminal_session.id = ? AND terminal_session.user_id = ?`,
  ).get(id, requirePersistenceUserId()) as Record<string, unknown> | null;
  return row ? rowToTerminalSession(row) : null;
}

export async function listTerminalSessions(): Promise<WorkspaceTerminalSession[]> {
  const db = getDatabase();
  const rows = db.query(
    `${TERMINAL_SESSION_SELECT}
     WHERE terminal_session.user_id = ?
     ORDER BY terminal_session.created_at DESC`,
  ).all(requirePersistenceUserId()) as Record<string, unknown>[];
  return rows.map(rowToTerminalSession);
}

export async function listTerminalSessionsByWorkspace(workspaceId: string): Promise<WorkspaceTerminalSession[]> {
  const db = getDatabase();
  const rows = db.query(
    `${TERMINAL_SESSION_SELECT}
     WHERE terminal_session.workspace_id = ? AND terminal_session.user_id = ?
     ORDER BY terminal_session.created_at DESC`,
  ).all(workspaceId, requirePersistenceUserId()) as Record<string, unknown>[];
  return rows.map(rowToTerminalSession);
}

export async function getTerminalSessionByTaskId(taskId: string): Promise<WorkspaceTerminalSession | null> {
  const db = getDatabase();
  const row = db.query(
    `${TERMINAL_SESSION_SELECT}
     WHERE terminal_session.task_id = ? AND terminal_session.user_id = ?
     LIMIT 1`,
  ).get(taskId, requirePersistenceUserId()) as Record<string, unknown> | null;
  return row ? rowToTerminalSession(row) : null;
}

export async function countTerminalSessionsByWorkspace(workspaceId: string): Promise<number> {
  const db = getDatabase();
  const row = db.query(
    "SELECT COUNT(*) AS count FROM terminal_sessions WHERE workspace_id = ? AND user_id = ?",
  ).get(workspaceId, requirePersistenceUserId()) as { count?: number } | null;
  return row?.count ?? 0;
}

export async function deleteTerminalSession(id: string): Promise<boolean> {
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const result = db.run(
    "DELETE FROM terminal_sessions WHERE id = ? AND user_id = ?",
    [id, userId],
  );
  return result.changes > 0;
}
