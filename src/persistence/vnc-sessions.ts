import type { VncSession } from "@/shared";
import { getDatabase } from "./database";
import { requirePersistenceUserId } from "./ownership";
import {
  EXECUTION_HOST_JOIN_COLUMNS,
  executionHostBindingFromRow,
  resolveExecutionHostBindingId,
} from "./execution-hosts";

const RESUMABLE_STATUSES = ["starting", "active"];

const ALLOWED_VNC_SESSION_COLUMNS = new Set([
  "id",
  "user_id",
  "remote_host",
  "remote_port",
  "local_port",
  "created_at",
  "updated_at",
  "status",
  "pid",
  "connected_at",
  "error_message",
  "execution_host_id",
  "execution_host_revision",
]);

const VNC_SESSION_SELECT = `
  SELECT vnc_session.*, ${EXECUTION_HOST_JOIN_COLUMNS}
  FROM vnc_sessions vnc_session
  LEFT JOIN execution_hosts execution_host
    ON execution_host.id = vnc_session.execution_host_id
    AND execution_host.user_id = vnc_session.user_id
`;

function validateColumnNames(columns: string[]): void {
  for (const column of columns) {
    if (!ALLOWED_VNC_SESSION_COLUMNS.has(column)) {
      throw new Error(`Invalid VNC session column name: ${column}`);
    }
  }
}

function rowToVncSession(row: Record<string, unknown>): VncSession {
  return {
    config: {
      id: row["id"] as string,
      executionHostBinding: executionHostBindingFromRow(row)!,
      remoteHost: "127.0.0.1",
      remotePort: row["remote_port"] as number,
      localPort: row["local_port"] as number,
      createdAt: row["created_at"] as string,
      updatedAt: row["updated_at"] as string,
    },
    state: {
      status: row["status"] as VncSession["state"]["status"],
      pid: (row["pid"] as number | null) ?? undefined,
      connectedAt: (row["connected_at"] as string | null) ?? undefined,
      error: (row["error_message"] as string | null) ?? undefined,
    },
  };
}

function vncSessionToRow(session: VncSession): Record<string, string | number | null> {
  const userId = requirePersistenceUserId();
  return {
    id: session.config.id,
    user_id: userId,
    remote_host: session.config.remoteHost,
    remote_port: session.config.remotePort,
    local_port: session.config.localPort,
    created_at: session.config.createdAt,
    updated_at: session.config.updatedAt,
    status: session.state.status,
    pid: session.state.pid ?? null,
    connected_at: session.state.connectedAt ?? null,
    error_message: session.state.error ?? null,
    execution_host_id: resolveExecutionHostBindingId(userId, session.config.executionHostBinding),
    execution_host_revision: session.config.executionHostBinding.revision,
  };
}

export async function saveVncSession(session: VncSession): Promise<void> {
  const row = vncSessionToRow(session);
  const columns = Object.keys(row);
  validateColumnNames(columns);
  const placeholders = columns.map(() => "?").join(", ");
  const updateClause = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  getDatabase().run(
    `INSERT INTO vnc_sessions (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updateClause}
     WHERE vnc_sessions.user_id = excluded.user_id`,
    Object.values(row),
  );
}

export async function getVncSession(id: string): Promise<VncSession | null> {
  const row = getDatabase().query(
    `${VNC_SESSION_SELECT}
     WHERE vnc_session.id = ? AND vnc_session.user_id = ?`,
  ).get(id, requirePersistenceUserId()) as Record<string, unknown> | null;
  return row ? rowToVncSession(row) : null;
}

export async function listVncSessionsByExecutionHostId(
  executionHostId: string,
): Promise<VncSession[]> {
  const rows = getDatabase().query(
    `${VNC_SESSION_SELECT}
     WHERE vnc_session.execution_host_id = ? AND vnc_session.user_id = ?
     ORDER BY vnc_session.created_at DESC`,
  ).all(executionHostId, requirePersistenceUserId()) as Record<string, unknown>[];
  return rows.map(rowToVncSession);
}

export async function findActiveVncSessionByExecutionHost(
  executionHostId: string,
  remotePort: number,
): Promise<VncSession | null> {
  const row = getDatabase().query(
    `${VNC_SESSION_SELECT}
     WHERE vnc_session.execution_host_id = ? AND vnc_session.remote_port = ?
       AND vnc_session.user_id = ?
       AND vnc_session.status IN (${RESUMABLE_STATUSES.map(() => "?").join(", ")})
     ORDER BY vnc_session.created_at DESC LIMIT 1`,
  ).get(
    executionHostId,
    remotePort,
    requirePersistenceUserId(),
    ...RESUMABLE_STATUSES,
  ) as Record<string, unknown> | null;
  return row ? rowToVncSession(row) : null;
}

export async function listVncSessionsByStatuses(statuses: VncSession["state"]["status"][]): Promise<VncSession[]> {
  if (statuses.length === 0) {
    return [];
  }
  const userId = requirePersistenceUserId();
  const rows = getDatabase().query(
    `${VNC_SESSION_SELECT}
     WHERE vnc_session.user_id = ?
       AND vnc_session.status IN (${statuses.map(() => "?").join(", ")})`,
  ).all(userId, ...statuses) as Record<string, unknown>[];
  return rows.map(rowToVncSession);
}

export async function listReservedVncLocalPortsForMaintenance(statuses: VncSession["state"]["status"][]): Promise<Set<number>> {
  if (statuses.length === 0) {
    return new Set();
  }
  const rows = getDatabase().query(
    `SELECT DISTINCT local_port FROM vnc_sessions WHERE status IN (${statuses.map(() => "?").join(", ")})`,
  ).all(...statuses) as Array<{ local_port: number }>;
  return new Set(rows.map((row) => row.local_port));
}

export async function deleteVncSession(id: string): Promise<boolean> {
  const result = getDatabase().run("DELETE FROM vnc_sessions WHERE id = ? AND user_id = ?", [id, requirePersistenceUserId()]);
  return result.changes > 0;
}
