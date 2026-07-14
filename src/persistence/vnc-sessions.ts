import type { VncSession } from "@/shared";
import { getDatabase } from "./database";
import { requirePersistenceUserId } from "./ownership";

const RESUMABLE_STATUSES = ["starting", "active"];

const ALLOWED_VNC_SESSION_COLUMNS = new Set([
  "id",
  "user_id",
  "ssh_server_id",
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
    if (!ALLOWED_VNC_SESSION_COLUMNS.has(column)) {
      throw new Error(`Invalid VNC session column name: ${column}`);
    }
  }
}

function rowToVncSession(row: Record<string, unknown>): VncSession {
  return {
    config: {
      id: row["id"] as string,
      sshServerId: row["ssh_server_id"] as string,
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
  return {
    id: session.config.id,
    user_id: requirePersistenceUserId(),
    ssh_server_id: session.config.sshServerId,
    remote_host: session.config.remoteHost,
    remote_port: session.config.remotePort,
    local_port: session.config.localPort,
    created_at: session.config.createdAt,
    updated_at: session.config.updatedAt,
    status: session.state.status,
    pid: session.state.pid ?? null,
    connected_at: session.state.connectedAt ?? null,
    error_message: session.state.error ?? null,
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
  const row = getDatabase().query("SELECT * FROM vnc_sessions WHERE id = ? AND user_id = ?").get(id, requirePersistenceUserId()) as Record<string, unknown> | null;
  return row ? rowToVncSession(row) : null;
}

export async function listVncSessionsBySshServerId(sshServerId: string): Promise<VncSession[]> {
  const rows = getDatabase().query(
    "SELECT * FROM vnc_sessions WHERE ssh_server_id = ? AND user_id = ? ORDER BY created_at DESC",
  ).all(sshServerId, requirePersistenceUserId()) as Record<string, unknown>[];
  return rows.map(rowToVncSession);
}

export async function findActiveVncSession(sshServerId: string, remotePort: number): Promise<VncSession | null> {
  const rows = getDatabase().query(
    `SELECT * FROM vnc_sessions
     WHERE ssh_server_id = ? AND remote_port = ? AND user_id = ? AND status IN (${RESUMABLE_STATUSES.map(() => "?").join(", ")})
     ORDER BY created_at DESC LIMIT 1`,
  ).all(sshServerId, remotePort, requirePersistenceUserId(), ...RESUMABLE_STATUSES) as Record<string, unknown>[];
  return rows[0] ? rowToVncSession(rows[0]) : null;
}

export async function listVncSessionsByStatuses(statuses: VncSession["state"]["status"][]): Promise<VncSession[]> {
  if (statuses.length === 0) {
    return [];
  }
  const userId = requirePersistenceUserId();
  const rows = getDatabase().query(
    `SELECT * FROM vnc_sessions WHERE user_id = ? AND status IN (${statuses.map(() => "?").join(", ")})`,
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
