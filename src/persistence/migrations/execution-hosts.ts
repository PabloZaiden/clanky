/**
 * Migration helpers for canonical execution-host identity.
 */

import type { Database } from "bun:sqlite";
import { createLogger } from "@pablozaiden/webapp/server";
import { parseServerSettings } from "../../shared/settings";
import {
  buildLocalTargetKey,
  buildMeshTargetKey,
  buildSshTargetKey,
} from "../workspace-target-key";

const log = createLogger("persistence:migrations:execution-hosts");

type ExecutionHostKind = "local" | "mesh" | "ssh";

interface ExecutionHostRow {
  id: string;
  revision: number;
}

function isLocalExecutionNode(db: Database, nodeId: string): boolean {
  const row = db.query(`
    SELECT 1 AS matches
    FROM mesh_node_identity
    WHERE singleton = 1 AND node_id = ?
  `).get(nodeId) as { matches: number } | null;
  return row?.matches === 1;
}

function getColumns(db: Database, tableName: string): string[] {
  const allowed = new Set([
    "workspaces",
    "terminal_sessions",
    "chats",
    "provisioning_jobs",
    "vnc_sessions",
    "ssh_servers",
    "mesh_node_identity",
    "mesh_nodes",
  ]);
  if (!allowed.has(tableName)) {
    throw new Error(`Unsupported execution-host migration table: ${tableName}`);
  }
  return (db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function addBindingColumns(db: Database, tableName: string): void {
  const columns = getColumns(db, tableName);
  if (!columns.includes("execution_host_id")) {
    db.run(
      `ALTER TABLE ${tableName} ADD COLUMN execution_host_id TEXT REFERENCES execution_hosts(id) ON DELETE SET NULL`,
    );
  }
  if (!columns.includes("execution_host_revision")) {
    db.run(`ALTER TABLE ${tableName} ADD COLUMN execution_host_revision INTEGER`);
  }
}

function ensureExecutionHost(
  db: Database,
  input: {
    userId: string;
    kind: ExecutionHostKind;
    sourceId: string;
    targetKey: string;
    revision?: number;
    createdAt?: string;
  },
): ExecutionHostRow {
  const existing = db.query(`
    SELECT id, revision
    FROM execution_hosts
    WHERE user_id = ? AND kind = ? AND source_id = ?
  `).get(input.userId, input.kind, input.sourceId) as ExecutionHostRow | null;
  if (existing) {
    return existing;
  }

  const id = crypto.randomUUID();
  const now = input.createdAt ?? new Date().toISOString();
  const revision = Math.max(1, Math.floor(input.revision ?? 1));
  db.run(`
    INSERT INTO execution_hosts (
      id, user_id, kind, source_id, target_key, revision,
      revoked_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `, [
    id,
    input.userId,
    input.kind,
    input.sourceId,
    input.targetKey,
    revision,
    now,
    now,
  ]);
  return { id, revision };
}

function createRegistry(db: Database): void {
  const sshColumns = getColumns(db, "ssh_servers");
  if (!sshColumns.includes("port")) {
    db.run("ALTER TABLE ssh_servers ADD COLUMN port INTEGER NOT NULL DEFAULT 22");
  }
  for (const tableName of ["mesh_node_identity", "mesh_nodes"]) {
    const columns = getColumns(db, tableName);
    if (!columns.includes("execution_config_json")) {
      db.run(`ALTER TABLE ${tableName} ADD COLUMN execution_config_json TEXT`);
    }
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS execution_hosts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('local', 'mesh', 'ssh')),
      source_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, kind, source_id)
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_execution_hosts_user_kind
    ON execution_hosts(user_id, kind, created_at ASC)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_execution_hosts_user_revoked
    ON execution_hosts(user_id, revoked_at)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_execution_hosts_user_target
    ON execution_hosts(user_id, target_key)
  `);

  for (const tableName of [
    "workspaces",
    "terminal_sessions",
    "chats",
    "provisioning_jobs",
    "vnc_sessions",
  ]) {
    addBindingColumns(db, tableName);
  }
}

function backfillRegisteredHosts(db: Database): void {
  const sshRows = db.query(`
    SELECT id, user_id, address, username, port, created_at
    FROM ssh_servers
  `).all() as Array<{
    id: string;
    user_id: string;
    address: string;
    username: string;
    port: number;
    created_at: string;
  }>;
  for (const row of sshRows) {
    ensureExecutionHost(db, {
      userId: row.user_id,
      kind: "ssh",
      sourceId: row.id,
      targetKey: buildSshTargetKey(row.address, row.port, row.username),
      createdAt: row.created_at,
    });
  }

  const meshRows = db.query(`
    SELECT DISTINCT member.local_user_id, member.node_id, node.created_at
    FROM mesh_link_members member
    JOIN mesh_nodes node ON node.node_id = member.node_id
    WHERE member.node_id != (
      SELECT identity.node_id
      FROM mesh_node_identity identity
      WHERE identity.singleton = 1
    )
  `).all() as Array<{
    local_user_id: string;
    node_id: string;
    created_at: string;
  }>;
  for (const row of meshRows) {
    ensureExecutionHost(db, {
      userId: row.local_user_id,
      kind: "mesh",
      sourceId: row.node_id,
      targetKey: buildMeshTargetKey(row.node_id),
      createdAt: row.created_at,
    });
  }
}

function bindByTargetKey(db: Database, tableName: string): void {
  db.run(`
    UPDATE ${tableName}
    SET execution_host_id = (
      SELECT host.id
      FROM execution_hosts host
      WHERE host.user_id = ${tableName}.user_id
        AND host.target_key = ${tableName}.target_key
      ORDER BY host.revoked_at IS NULL DESC, host.created_at DESC
      LIMIT 1
    ),
    execution_host_revision = (
      SELECT host.revision
      FROM execution_hosts host
      WHERE host.user_id = ${tableName}.user_id
        AND host.target_key = ${tableName}.target_key
      ORDER BY host.revoked_at IS NULL DESC, host.created_at DESC
      LIMIT 1
    )
    WHERE execution_host_id IS NULL
      AND target_key != ''
  `);
}

function bindWorkspaceHost(
  db: Database,
  workspaceId: string,
  host: ExecutionHostRow,
): void {
  db.run(`
    UPDATE workspaces
    SET execution_host_id = ?, execution_host_revision = ?
    WHERE id = ?
  `, [host.id, host.revision, workspaceId]);
}

function backfillWorkspaceHosts(db: Database): void {
  const rows = db.query(`
    SELECT
      id, user_id, name, execution_node_id, execution_target_revision,
      server_settings, ssh_server_id, created_at
    FROM workspaces
    WHERE execution_host_id IS NULL
  `).all() as Array<{
    id: string;
    user_id: string;
    name: string;
    execution_node_id: string | null;
    execution_target_revision: number;
    server_settings: string;
    ssh_server_id: string | null;
    created_at: string;
  }>;

  for (const row of rows) {
    if (row.ssh_server_id) {
      const host = db.query(`
        SELECT id, revision
        FROM execution_hosts
        WHERE user_id = ? AND kind = 'ssh' AND source_id = ?
      `).get(row.user_id, row.ssh_server_id) as ExecutionHostRow | null;
      if (host) {
        bindWorkspaceHost(db, row.id, host);
      }
      continue;
    }

    let settings;
    try {
      settings = parseServerSettings(row.server_settings);
    } catch (error) {
      log.warn("Skipping execution-host backfill for invalid workspace settings", {
        workspaceId: row.id,
        error: String(error),
      });
      continue;
    }

    if (settings.agent.transport === "stdio") {
      if (!row.execution_node_id) {
        continue;
      }
      const kind: ExecutionHostKind = isLocalExecutionNode(db, row.execution_node_id)
        ? "local"
        : "mesh";
      const host = ensureExecutionHost(db, {
        userId: row.user_id,
        kind,
        sourceId: row.execution_node_id,
        targetKey: kind === "local"
          ? buildLocalTargetKey(row.execution_node_id)
          : buildMeshTargetKey(row.execution_node_id),
        revision: row.execution_target_revision,
        createdAt: row.created_at,
      });
      bindWorkspaceHost(db, row.id, host);
      continue;
    }

    const port = settings.agent.port ?? 22;
    const username = settings.agent.username ?? "";
    const targetKey = buildSshTargetKey(settings.agent.hostname, port, username);
    const knownHost = db.query(`
      SELECT id, revision
      FROM execution_hosts
      WHERE user_id = ? AND target_key = ?
    `).get(row.user_id, targetKey) as ExecutionHostRow | null;
    if (knownHost) {
      bindWorkspaceHost(db, row.id, knownHost);
      continue;
    }

    const serverId = crypto.randomUUID();
    db.run(`
      INSERT INTO ssh_servers (
        id, user_id, name, address, username, port,
        created_at, updated_at, repositories_base_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `, [
      serverId,
      row.user_id,
      row.name,
      settings.agent.hostname,
      username,
      port,
      row.created_at,
      row.created_at,
    ]);
    const host = ensureExecutionHost(db, {
      userId: row.user_id,
      kind: "ssh",
      sourceId: serverId,
      targetKey,
      revision: row.execution_target_revision,
      createdAt: row.created_at,
    });
    db.run("UPDATE workspaces SET ssh_server_id = ? WHERE id = ?", [serverId, row.id]);
    bindWorkspaceHost(db, row.id, host);
  }
}

function backfillDependentResources(db: Database): void {
  bindByTargetKey(db, "terminal_sessions");

  db.run(`
    UPDATE chats
    SET execution_host_id = (
      SELECT workspace.execution_host_id
      FROM workspaces workspace
      WHERE workspace.id = chats.workspace_id
        AND workspace.user_id = chats.user_id
    ),
    execution_host_revision = (
      SELECT workspace.execution_host_revision
      FROM workspaces workspace
      WHERE workspace.id = chats.workspace_id
        AND workspace.user_id = chats.user_id
    )
    WHERE execution_host_id IS NULL
      AND source_kind = 'workspace'
  `);
  db.run(`
    UPDATE chats
    SET execution_host_id = (
      SELECT host.id
      FROM execution_hosts host
      WHERE host.user_id = chats.user_id
        AND host.kind = 'ssh'
        AND host.source_id = chats.ssh_server_id
    ),
    execution_host_revision = (
      SELECT host.revision
      FROM execution_hosts host
      WHERE host.user_id = chats.user_id
        AND host.kind = 'ssh'
        AND host.source_id = chats.ssh_server_id
    )
    WHERE execution_host_id IS NULL
      AND source_kind = 'ssh_server'
  `);
  db.run(`
    UPDATE vnc_sessions
    SET execution_host_id = (
      SELECT host.id
      FROM execution_hosts host
      WHERE host.user_id = vnc_sessions.user_id
        AND host.kind = 'ssh'
        AND host.source_id = vnc_sessions.ssh_server_id
    ),
    execution_host_revision = (
      SELECT host.revision
      FROM execution_hosts host
      WHERE host.user_id = vnc_sessions.user_id
        AND host.kind = 'ssh'
        AND host.source_id = vnc_sessions.ssh_server_id
    )
    WHERE execution_host_id IS NULL
  `);

  const jobs = db.query(`
    SELECT id, user_id, config_json
    FROM provisioning_jobs
    WHERE execution_host_id IS NULL
  `).all() as Array<{
    id: string;
    user_id: string;
    config_json: string;
  }>;
  for (const job of jobs) {
    let config: unknown;
    try {
      config = JSON.parse(job.config_json);
    } catch (error) {
      log.warn("Skipping execution-host backfill for invalid provisioning config", {
        jobId: job.id,
        error: String(error),
      });
      continue;
    }
    if (!config || typeof config !== "object") {
      continue;
    }
    const record = config as Record<string, unknown>;
    const sshServerId = typeof record["sshServerId"] === "string"
      ? record["sshServerId"]
      : null;
    const executionNodeId = typeof record["executionNodeId"] === "string"
      ? record["executionNodeId"]
      : null;
    const kind: ExecutionHostKind | null = sshServerId
      ? "ssh"
      : executionNodeId
        ? (isLocalExecutionNode(db, executionNodeId) ? "local" : "mesh")
        : null;
    const sourceId = sshServerId ?? executionNodeId;
    if (!kind || !sourceId) {
      continue;
    }
    let host = db.query(`
      SELECT id, revision
      FROM execution_hosts
      WHERE user_id = ? AND kind = ? AND source_id = ?
    `).get(job.user_id, kind, sourceId) as ExecutionHostRow | null;
    if (!host && kind === "local") {
      host = ensureExecutionHost(db, {
        userId: job.user_id,
        kind,
        sourceId,
        targetKey: buildLocalTargetKey(sourceId),
      });
    }
    if (host) {
      db.run(`
        UPDATE provisioning_jobs
        SET execution_host_id = ?, execution_host_revision = ?
        WHERE id = ?
      `, [host.id, host.revision, job.id]);
    }
  }
}

function createBindingIndexes(db: Database): void {
  for (const tableName of [
    "workspaces",
    "terminal_sessions",
    "chats",
    "provisioning_jobs",
    "vnc_sessions",
  ]) {
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_${tableName}_execution_host
      ON ${tableName}(execution_host_id)
    `);
  }
}

function rebuildChatsForExecutionHostSources(db: Database): void {
  db.run("DROP TABLE IF EXISTS chats_execution_host");
  db.run(`
    CREATE TABLE chats_execution_host (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'workspace',
      workspace_id TEXT,
      ssh_server_id TEXT,
      ssh_server_session_id TEXT,
      scope TEXT NOT NULL DEFAULT 'workspace',
      task_id TEXT,
      directory TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_provider_id TEXT,
      model_model_id TEXT,
      model_variant TEXT,
      use_worktree INTEGER NOT NULL DEFAULT 1,
      auto_approve_permissions INTEGER NOT NULL DEFAULT 1,
      skip_base_branch_sync INTEGER NOT NULL DEFAULT 0,
      base_branch TEXT,
      mode TEXT NOT NULL DEFAULT 'chat',
      status TEXT NOT NULL DEFAULT 'idle',
      started_at TEXT,
      completed_at TEXT,
      last_activity_at TEXT,
      session_id TEXT,
      session_server_url TEXT,
      error_message TEXT,
      error_timestamp TEXT,
      error_code TEXT,
      worktree_original_branch TEXT,
      worktree_working_branch TEXT,
      worktree_path TEXT,
      pending_permission_requests TEXT,
      queued_messages TEXT,
      active_message_id TEXT,
      interrupt_requested INTEGER NOT NULL DEFAULT 0,
      connection_status TEXT NOT NULL DEFAULT 'disconnected',
      is_private INTEGER NOT NULL DEFAULT 0,
      startup_stage TEXT,
      execution_host_id TEXT REFERENCES execution_hosts(id) ON DELETE SET NULL,
      execution_host_revision INTEGER,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (ssh_server_id) REFERENCES ssh_servers(id) ON DELETE CASCADE,
      FOREIGN KEY (ssh_server_session_id) REFERENCES ssh_server_sessions(id) ON DELETE CASCADE,
      CHECK (
        (
          source_kind = 'workspace'
          AND workspace_id IS NOT NULL
          AND ssh_server_id IS NULL
          AND ssh_server_session_id IS NULL
        )
        OR (
          source_kind = 'ssh_server'
          AND workspace_id IS NULL
          AND ssh_server_id IS NOT NULL
          AND ssh_server_session_id IS NOT NULL
        )
        OR (
          source_kind = 'execution_host'
          AND workspace_id IS NULL
          AND ssh_server_id IS NULL
          AND ssh_server_session_id IS NULL
          AND execution_host_id IS NOT NULL
        )
      )
    )
  `);
  db.run(`
    INSERT INTO chats_execution_host (
      id,
      user_id,
      name,
      source_kind,
      workspace_id,
      ssh_server_id,
      ssh_server_session_id,
      scope,
      task_id,
      directory,
      created_at,
      updated_at,
      model_provider_id,
      model_model_id,
      model_variant,
      use_worktree,
      auto_approve_permissions,
      skip_base_branch_sync,
      base_branch,
      mode,
      status,
      started_at,
      completed_at,
      last_activity_at,
      session_id,
      session_server_url,
      error_message,
      error_timestamp,
      error_code,
      worktree_original_branch,
      worktree_working_branch,
      worktree_path,
      pending_permission_requests,
      queued_messages,
      active_message_id,
      interrupt_requested,
      connection_status,
      is_private,
      startup_stage,
      execution_host_id,
      execution_host_revision
    )
    SELECT
      id,
      user_id,
      name,
      source_kind,
      workspace_id,
      ssh_server_id,
      ssh_server_session_id,
      COALESCE(scope, 'workspace'),
      task_id,
      directory,
      created_at,
      updated_at,
      model_provider_id,
      model_model_id,
      model_variant,
      use_worktree,
      auto_approve_permissions,
      skip_base_branch_sync,
      base_branch,
      mode,
      status,
      started_at,
      completed_at,
      last_activity_at,
      session_id,
      session_server_url,
      error_message,
      error_timestamp,
      error_code,
      worktree_original_branch,
      worktree_working_branch,
      worktree_path,
      pending_permission_requests,
      queued_messages,
      active_message_id,
      interrupt_requested,
      connection_status,
      is_private,
      startup_stage,
      execution_host_id,
      execution_host_revision
    FROM chats
  `);
  db.run("DROP TABLE chats");
  db.run("ALTER TABLE chats_execution_host RENAME TO chats");
  db.run("CREATE INDEX idx_chats_created_at ON chats(user_id, created_at DESC)");
  db.run(`
    CREATE INDEX idx_chats_workspace_created_at
    ON chats(user_id, workspace_id, created_at DESC)
  `);
  db.run(`
    CREATE INDEX idx_chats_ssh_server_created_at
    ON chats(user_id, ssh_server_id, created_at DESC)
  `);
  db.run(`
    CREATE UNIQUE INDEX idx_chats_task_id_unique
    ON chats(user_id, task_id)
    WHERE task_id IS NOT NULL
  `);
  db.run(`
    CREATE INDEX idx_chats_directory_workspace_status
    ON chats(user_id, directory, workspace_id, status)
  `);
}

export function migrateExecutionHostRegistry(db: Database): void {
  db.run("PRAGMA foreign_keys = OFF");
  try {
    const migrate = db.transaction(() => {
      createRegistry(db);
      backfillRegisteredHosts(db);
      backfillWorkspaceHosts(db);
      backfillDependentResources(db);
      rebuildChatsForExecutionHostSources(db);
      createBindingIndexes(db);
    });
    migrate();
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }

  const violations = db.query("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(
      `Execution-host migration introduced ${violations.length} foreign key violation(s)`,
    );
  }
}
