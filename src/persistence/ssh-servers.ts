/**
 * Persistence layer for standalone SSH servers and server-owned SSH sessions.
 */

import {
  DEFAULT_SSH_CONNECTION_MODE,
  normalizeSshConnectionMode,
  type SshServer,
  type SshServerConfig,
  type SshServerSession,
} from "../types";
import { createLogger } from "../core/logger";
import { getDatabase } from "./database";
import {
  deleteSshServerKeyPair,
  loadSshServerKeyPair,
} from "./ssh-server-keys";

const log = createLogger("persistence:ssh-servers");

const ALLOWED_SSH_SERVER_COLUMNS = new Set([
  "id",
  "name",
  "address",
  "username",
  "repositories_base_path",
  "created_at",
  "updated_at",
]);

const ALLOWED_SSH_SERVER_SESSION_COLUMNS = new Set([
  "id",
  "ssh_server_id",
  "name",
  "connection_mode",
  "remote_session_name",
  "created_at",
  "updated_at",
  "status",
  "last_connected_at",
  "error_message",
  "runtime_connection_mode",
  "notice_message",
]);

function validateColumnNames(columns: string[], allowedColumns: Set<string>, label: string): void {
  for (const column of columns) {
    if (!allowedColumns.has(column)) {
      throw new Error(`Invalid ${label} column name: ${column}`);
    }
  }
}

function sshServerConfigToRow(config: SshServerConfig): Record<string, unknown> {
  return {
    id: config.id,
    name: config.name,
    address: config.address,
    username: config.username,
    repositories_base_path: config.repositoriesBasePath ?? null,
    created_at: config.createdAt,
    updated_at: config.updatedAt,
  };
}

function rowToSshServerConfig(row: Record<string, unknown>): SshServerConfig {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    address: row["address"] as string,
    username: row["username"] as string,
    repositoriesBasePath: (row["repositories_base_path"] as string | null) ?? null,
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
  };
}

function sshServerSessionToRow(session: SshServerSession): Record<string, unknown> {
  return {
    id: session.config.id,
    ssh_server_id: session.config.sshServerId,
    name: session.config.name,
    connection_mode: session.config.connectionMode,
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

function rowToSshServerSession(row: Record<string, unknown>): SshServerSession {
  return {
      config: {
        id: row["id"] as string,
        sshServerId: row["ssh_server_id"] as string,
        name: row["name"] as string,
        connectionMode: normalizeSshConnectionMode(
          (row["connection_mode"] as SshServerSession["config"]["connectionMode"] | null) ?? DEFAULT_SSH_CONNECTION_MODE,
        ),
        remoteSessionName: row["remote_session_name"] as string,
        createdAt: row["created_at"] as string,
        updatedAt: row["updated_at"] as string,
    },
    state: {
      status: row["status"] as SshServerSession["state"]["status"],
      lastConnectedAt: (row["last_connected_at"] as string | null) ?? undefined,
      error: (row["error_message"] as string | null) ?? undefined,
      runtimeConnectionMode: (row["runtime_connection_mode"] as string | null)
        ? normalizeSshConnectionMode(row["runtime_connection_mode"])
        : undefined,
      notice: (row["notice_message"] as string | null) ?? undefined,
    },
  };
}

async function hydrateSshServer(config: SshServerConfig): Promise<SshServer> {
  const keyPair = await loadSshServerKeyPair(config.id);
  if (!keyPair) {
    throw new Error(`SSH server key pair not found for server ${config.id}`);
  }

  return {
    config,
    publicKey: {
      algorithm: keyPair.algorithm,
      publicKey: keyPair.publicKey,
      fingerprint: keyPair.fingerprint,
      version: keyPair.version,
      createdAt: keyPair.createdAt,
    },
  };
}

export async function saveSshServerConfig(config: SshServerConfig): Promise<void> {
  const db = getDatabase();
  const row = sshServerConfigToRow(config);
  const columns = Object.keys(row);
  validateColumnNames(columns, ALLOWED_SSH_SERVER_COLUMNS, "SSH server");

  const placeholders = columns.map(() => "?").join(", ");
  const updateClause = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");

  db.run(
    `INSERT INTO ssh_servers (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updateClause}`,
    Object.values(row) as Array<string | null>,
  );
}

export async function getSshServerConfig(id: string): Promise<SshServerConfig | null> {
  const db = getDatabase();
  const row = db.query("SELECT * FROM ssh_servers WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? rowToSshServerConfig(row) : null;
}

export async function getSshServer(id: string): Promise<SshServer | null> {
  const config = await getSshServerConfig(id);
  if (!config) {
    return null;
  }
  return await hydrateSshServer(config);
}

export async function listSshServerConfigs(): Promise<SshServerConfig[]> {
  const db = getDatabase();
  const rows = db.query(
    "SELECT * FROM ssh_servers ORDER BY name COLLATE NOCASE ASC, created_at ASC",
  ).all() as Record<string, unknown>[];
  return rows.map(rowToSshServerConfig);
}

export async function listSshServers(): Promise<SshServer[]> {
  const configs = await listSshServerConfigs();
  return await Promise.all(configs.map(async (config) => await hydrateSshServer(config)));
}

export async function deleteSshServer(id: string): Promise<boolean> {
  const db = getDatabase();
  const result = db.run("DELETE FROM ssh_servers WHERE id = ?", [id]);
  const deleted = result.changes > 0;
  if (deleted) {
    await deleteSshServerKeyPair(id);
    log.debug("Deleted SSH server", { id });
  }
  return deleted;
}

export async function saveSshServerSession(session: SshServerSession): Promise<void> {
  const db = getDatabase();
  const row = sshServerSessionToRow(session);
  const columns = Object.keys(row);
  validateColumnNames(columns, ALLOWED_SSH_SERVER_SESSION_COLUMNS, "SSH server session");

  const placeholders = columns.map(() => "?").join(", ");
  const updateClause = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");

  db.run(
    `INSERT INTO ssh_server_sessions (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updateClause}`,
    Object.values(row) as Array<string | null>,
  );
}

export async function getSshServerSession(id: string): Promise<SshServerSession | null> {
  const db = getDatabase();
  const row = db.query("SELECT * FROM ssh_server_sessions WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? rowToSshServerSession(row) : null;
}

export async function listSshServerSessionsByServerId(sshServerId: string): Promise<SshServerSession[]> {
  const db = getDatabase();
  const rows = db.query(
    "SELECT * FROM ssh_server_sessions WHERE ssh_server_id = ? ORDER BY created_at DESC",
  ).all(sshServerId) as Record<string, unknown>[];
  return rows.map(rowToSshServerSession);
}

export async function countSshServerSessionsByServerId(sshServerId: string): Promise<number> {
  const db = getDatabase();
  const row = db.query(
    "SELECT COUNT(*) AS count FROM ssh_server_sessions WHERE ssh_server_id = ?",
  ).get(sshServerId) as { count?: number } | null;
  return row?.count ?? 0;
}

export async function deleteSshServerSession(id: string): Promise<boolean> {
  const db = getDatabase();
  const result = db.run("DELETE FROM ssh_server_sessions WHERE id = ?", [id]);
  return result.changes > 0;
}
