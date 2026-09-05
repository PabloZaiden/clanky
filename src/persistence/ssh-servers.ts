/**
 * Persistence layer for standalone SSH servers and server-owned SSH sessions.
 */

import {
  type SshServer,
  type SshServerConfig,
} from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "./database";
import {
  deleteSshServerKeyPair,
  ensureSshServerKeyPair,
  loadSshServerKeyPair,
} from "./ssh-server-keys";
import { requirePersistenceUserId } from "./ownership";
import {
  ensureExecutionHost,
  getExecutionHostByRef,
  revokeExecutionHost,
} from "./execution-hosts";
import { buildSshTargetKey } from "./workspace-target-key";

const log = createLogger("persistence:ssh-servers");

const ALLOWED_SSH_SERVER_COLUMNS = new Set([
  "id",
  "user_id",
  "name",
  "address",
  "port",
  "username",
  "repositories_base_path",
  "created_at",
  "updated_at",
  "is_private",
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
    user_id: requirePersistenceUserId(),
    name: config.name,
    address: config.address,
    port: config.port ?? 22,
    username: config.username,
    repositories_base_path: config.repositoriesBasePath ?? null,
    created_at: config.createdAt,
    updated_at: config.updatedAt,
    is_private: config.isPrivate ? 1 : 0,
  };
}

function rowToSshServerConfig(row: Record<string, unknown>): SshServerConfig {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    address: row["address"] as string,
    port: typeof row["port"] === "number" ? row["port"] : 22,
    username: row["username"] as string,
    repositoriesBasePath: (row["repositories_base_path"] as string | null) ?? null,
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
    isPrivate: row["is_private"] === 1,
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

function persistSshServerConfig(config: SshServerConfig): void {
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
     ON CONFLICT(id) DO UPDATE SET ${updateClause}
     WHERE ssh_servers.user_id = excluded.user_id`,
    Object.values(row) as Array<string | null>,
  );
}

export async function saveSshServerConfig(config: SshServerConfig): Promise<void> {
  await ensureSshServerKeyPair(config.id);
  persistSshServerConfig(config);
  const userId = requirePersistenceUserId();
  ensureExecutionHost(
    userId,
    { kind: "ssh", serverId: config.id },
    buildSshTargetKey(config.address, config.port ?? 22, config.username),
  );
}

export async function getSshServerConfig(id: string): Promise<SshServerConfig | null> {
  const db = getDatabase();
  const row = db.query("SELECT * FROM ssh_servers WHERE id = ? AND user_id = ?").get(id, requirePersistenceUserId()) as Record<string, unknown> | null;
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
    "SELECT * FROM ssh_servers WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC, created_at ASC",
  ).all(requirePersistenceUserId()) as Record<string, unknown>[];
  return rows.map(rowToSshServerConfig);
}

export async function listSshServers(): Promise<SshServer[]> {
  const configs = await listSshServerConfigs();
  return await Promise.all(configs.map(async (config) => await hydrateSshServer(config)));
}

export async function deleteSshServer(id: string): Promise<boolean> {
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const result = db.run("DELETE FROM ssh_servers WHERE id = ? AND user_id = ?", [id, userId]);
  const deleted = result.changes > 0;
  if (deleted) {
    const host = getExecutionHostByRef(userId, { kind: "ssh", serverId: id });
    if (host) {
      revokeExecutionHost(userId, host.id);
    }
    await deleteSshServerKeyPair(id);
    log.debug("Deleted SSH server", { id });
  }
  return deleted;
}
