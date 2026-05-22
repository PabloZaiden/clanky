/**
 * Forwarded-port persistence layer.
 */

import type { PortForward } from "../types";
import { getDatabase } from "./database";
import { createLogger } from "../core/logger";

const log = createLogger("persistence:forwarded-ports");

const ALLOWED_FORWARDED_PORT_COLUMNS = new Set([
  "id",
  "task_id",
  "workspace_id",
  "ssh_session_id",
  "remote_host",
  "remote_port",
  "local_port",
  "created_at",
  "updated_at",
  "status",
  "pid",
  "connected_at",
  "error_message",
]);

function validateColumnNames(columns: string[]): void {
  for (const column of columns) {
    if (!ALLOWED_FORWARDED_PORT_COLUMNS.has(column)) {
      throw new Error(`Invalid forwarded port column name: ${column}`);
    }
  }
}

function portForwardToRow(forward: PortForward): Record<string, number | string | null> {
  return {
    id: forward.config.id,
    task_id: forward.config.taskId,
    workspace_id: forward.config.workspaceId,
    ssh_session_id: forward.config.sshSessionId ?? null,
    remote_host: forward.config.remoteHost,
    remote_port: forward.config.remotePort,
    local_port: forward.config.localPort,
    created_at: forward.config.createdAt,
    updated_at: forward.config.updatedAt,
    status: forward.state.status,
    pid: forward.state.pid ?? null,
    connected_at: forward.state.connectedAt ?? null,
    error_message: forward.state.error ?? null,
  };
}

function rowToPortForward(row: Record<string, unknown>): PortForward {
  return {
    config: {
      id: row["id"] as string,
      taskId: row["task_id"] as string,
      workspaceId: row["workspace_id"] as string,
      sshSessionId: (row["ssh_session_id"] as string | null) ?? undefined,
      remoteHost: row["remote_host"] as string,
      remotePort: row["remote_port"] as number,
      localPort: row["local_port"] as number,
      createdAt: row["created_at"] as string,
      updatedAt: row["updated_at"] as string,
    },
    state: {
      status: row["status"] as PortForward["state"]["status"],
      pid: (row["pid"] as number | null) ?? undefined,
      connectedAt: (row["connected_at"] as string | null) ?? undefined,
      error: (row["error_message"] as string | null) ?? undefined,
    },
  };
}

export async function savePortForward(forward: PortForward): Promise<void> {
  const db = getDatabase();
  const row = portForwardToRow(forward);
  const columns = Object.keys(row);
  validateColumnNames(columns);

  const placeholders = columns.map(() => "?").join(", ");
  const values = Object.values(row) as Array<number | string | null>;
  const updateClause = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");

  db.run(
    `INSERT INTO forwarded_ports (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updateClause}`,
    values,
  );
  log.debug("Saved forwarded port", {
    id: forward.config.id,
    taskId: forward.config.taskId,
    status: forward.state.status,
  });
}

export async function getPortForward(id: string): Promise<PortForward | null> {
  const db = getDatabase();
  const row = db.query("SELECT * FROM forwarded_ports WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? rowToPortForward(row) : null;
}

export async function listPortForwardsByTaskId(taskId: string): Promise<PortForward[]> {
  const db = getDatabase();
  const rows = db.query(
    "SELECT * FROM forwarded_ports WHERE task_id = ? ORDER BY created_at DESC",
  ).all(taskId) as Record<string, unknown>[];
  return rows.map(rowToPortForward);
}

export async function listPortForwardsBySshSessionId(sshSessionId: string): Promise<PortForward[]> {
  const db = getDatabase();
  const rows = db.query(
    "SELECT * FROM forwarded_ports WHERE ssh_session_id = ? ORDER BY created_at DESC",
  ).all(sshSessionId) as Record<string, unknown>[];
  return rows.map(rowToPortForward);
}

export async function listPortForwardsByStatuses(
  statuses: Array<PortForward["state"]["status"]>,
): Promise<PortForward[]> {
  if (statuses.length === 0) {
    return [];
  }

  const db = getDatabase();
  const placeholders = statuses.map(() => "?").join(", ");
  const rows = db.query(
    `SELECT * FROM forwarded_ports WHERE status IN (${placeholders}) ORDER BY created_at DESC`,
  ).all(...statuses) as Record<string, unknown>[];
  return rows.map(rowToPortForward);
}

export async function findPortForwardByWorkspaceAndRemotePort(
  workspaceId: string,
  remotePort: number,
  statuses: Array<PortForward["state"]["status"]>,
): Promise<PortForward | null> {
  if (statuses.length === 0) {
    return null;
  }

  const db = getDatabase();
  const placeholders = statuses.map(() => "?").join(", ");
  const row = db.query(
    `SELECT * FROM forwarded_ports
     WHERE workspace_id = ?
       AND remote_port = ?
       AND status IN (${placeholders})
     ORDER BY created_at DESC
     LIMIT 1`,
  ).get(workspaceId, remotePort, ...statuses) as Record<string, unknown> | null;
  return row ? rowToPortForward(row) : null;
}

export async function deletePortForward(id: string): Promise<boolean> {
  const db = getDatabase();
  const result = db.run("DELETE FROM forwarded_ports WHERE id = ?", [id]);
  return result.changes > 0;
}
