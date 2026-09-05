/**
 * Migration v46: make execution-host bindings the only persisted transport identity.
 */

import type { Database } from "bun:sqlite";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  DEFAULT_SERVER_AGENT_PROVIDER,
  isAgentProvider,
} from "../../shared/settings";

const log = createLogger("persistence:migrations:canonical-execution-hosts");

interface BindingRow {
  id: string;
  user_id: string;
  kind: "local" | "mesh" | "ssh";
  source_id: string;
  target_key: string;
  revision: number;
}

function requireNoRows(
  db: Database,
  query: string,
  message: string,
): void {
  const row = db.query(query).get() as { id: string } | null;
  if (row) {
    throw new Error(`${message}: ${row.id}`);
  }
}

function parseRecord(raw: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch (error) {
    throw new Error(`Cannot migrate invalid ${label} JSON`, { cause: error });
  }
  throw new Error(`Cannot migrate non-object ${label} JSON`);
}

function rewriteWorkspaceSettings(db: Database): void {
  const rows = db.query(`
    SELECT id, server_settings, provider
    FROM workspaces
  `).all() as Array<{
    id: string;
    server_settings: string;
    provider: string | null;
  }>;
  for (const row of rows) {
    const settings = parseRecord(row.server_settings, `workspace ${row.id} settings`);
    const agent = settings["agent"];
    const agentRecord = agent && typeof agent === "object" && !Array.isArray(agent)
      ? agent as Record<string, unknown>
      : {};
    const provider = isAgentProvider(agentRecord["provider"])
      ? agentRecord["provider"]
      : isAgentProvider(row.provider)
        ? row.provider
        : DEFAULT_SERVER_AGENT_PROVIDER;
    db.query("UPDATE workspaces SET server_settings = ? WHERE id = ?")
      .run(JSON.stringify({ agent: { provider } }), row.id);
  }
}

function bindingForHost(db: Database, hostId: string): BindingRow {
  const row = db.query(`
    SELECT id, user_id, kind, source_id, target_key, revision
    FROM execution_hosts
    WHERE id = ?
  `).get(hostId) as BindingRow | null;
  if (!row) {
    throw new Error(`Cannot migrate missing execution host: ${hostId}`);
  }
  return row;
}

function rewriteProvisioningConfigs(db: Database): void {
  const rows = db.query(`
    SELECT id, config_json, execution_host_id, execution_host_revision
    FROM provisioning_jobs
  `).all() as Array<{
    id: string;
    config_json: string;
    execution_host_id: string;
    execution_host_revision: number;
  }>;
  for (const row of rows) {
    const config = parseRecord(row.config_json, `provisioning job ${row.id} config`);
    delete config["sshServerId"];
    delete config["executionNodeId"];
    delete config["executionHost"];
    const host = bindingForHost(db, row.execution_host_id);
    config["executionHostBinding"] = {
      host: host.kind === "ssh"
        ? { kind: "ssh", serverId: host.source_id }
        : { kind: host.kind, nodeId: host.source_id },
      targetKey: host.target_key,
      revision: row.execution_host_revision,
    };
    db.query("UPDATE provisioning_jobs SET config_json = ? WHERE id = ?")
      .run(JSON.stringify(config), row.id);
  }
}

function backfillBindings(db: Database): void {
  db.run(`
    UPDATE terminal_sessions
    SET execution_host_id = (
      SELECT workspace.execution_host_id
      FROM workspaces workspace
      WHERE workspace.id = terminal_sessions.workspace_id
        AND workspace.user_id = terminal_sessions.user_id
    ),
    execution_host_revision = (
      SELECT workspace.execution_host_revision
      FROM workspaces workspace
      WHERE workspace.id = terminal_sessions.workspace_id
        AND workspace.user_id = terminal_sessions.user_id
    )
    WHERE execution_host_id IS NULL AND workspace_id IS NOT NULL
  `);
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
    WHERE execution_host_id IS NULL AND source_kind = 'workspace'
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
    WHERE execution_host_id IS NULL AND source_kind = 'ssh_server'
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
}

function discardUnresolvedVncSessions(db: Database): void {
  const result = db.run(`
    DELETE FROM vnc_sessions
    WHERE NOT EXISTS (
      SELECT 1
      FROM execution_hosts host
      WHERE host.id = vnc_sessions.execution_host_id
        AND host.user_id = vnc_sessions.user_id
        AND host.revision = vnc_sessions.execution_host_revision
    )
  `);
  if (result.changes > 0) {
    log.warn("Discarded VNC sessions without a canonical execution host", {
      count: result.changes,
    });
  }
}

function validateBindings(db: Database): void {
  for (const table of [
    "workspaces",
    "terminal_sessions",
    "chats",
    "vnc_sessions",
    "provisioning_jobs",
  ]) {
    requireNoRows(
      db,
      `SELECT resource.id
       FROM ${table} resource
       LEFT JOIN execution_hosts host
         ON host.id = resource.execution_host_id
        AND host.user_id = resource.user_id
       WHERE host.id IS NULL
          OR resource.execution_host_revision IS NULL
          OR resource.execution_host_revision != host.revision
       LIMIT 1`,
      `Cannot canonicalize ${table} with an unresolved execution host`,
    );
  }
  requireNoRows(
    db,
    `SELECT session.id
     FROM ssh_server_sessions session
     LEFT JOIN execution_hosts host
       ON host.user_id = session.user_id
      AND host.kind = 'ssh'
      AND host.source_id = session.ssh_server_id
     WHERE host.id IS NULL
     LIMIT 1`,
    "Cannot canonicalize an SSH terminal with an unresolved execution host",
  );
}

function rebuildWorkspaces(db: Database): void {
  db.run(`
    CREATE TABLE workspaces_canonical (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      directory TEXT NOT NULL,
      workspace_type TEXT NOT NULL DEFAULT 'git',
      execution_target_revision INTEGER NOT NULL DEFAULT 1,
      execution_host_id TEXT NOT NULL REFERENCES execution_hosts(id) ON DELETE RESTRICT,
      execution_host_revision INTEGER NOT NULL,
      server_settings TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_private INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      allow_clanky_context INTEGER NOT NULL DEFAULT 0,
      source_directory TEXT,
      repo_url TEXT,
      base_path TEXT,
      devcontainer_subpath TEXT
    )
  `);
  db.run(`
    INSERT INTO workspaces_canonical (
      id, user_id, name, directory, workspace_type,
      execution_target_revision, execution_host_id, execution_host_revision,
      server_settings, created_at, updated_at, is_private, archived,
      allow_clanky_context, source_directory, repo_url, base_path,
      devcontainer_subpath
    )
    SELECT
      id, user_id, name, directory, workspace_type,
      execution_target_revision, execution_host_id, execution_host_revision,
      server_settings, created_at, updated_at, is_private, archived,
      allow_clanky_context, source_directory, repo_url, base_path,
      devcontainer_subpath
    FROM workspaces
  `);
  db.run("DROP TABLE workspaces");
  db.run("ALTER TABLE workspaces_canonical RENAME TO workspaces");
  db.run("CREATE INDEX idx_workspaces_user_updated ON workspaces(user_id, updated_at DESC)");
  db.run("CREATE INDEX idx_workspaces_execution_host ON workspaces(execution_host_id)");
}

function rebuildTerminalSessions(db: Database): void {
  db.run(`
    CREATE TABLE terminal_sessions_canonical (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      workspace_id TEXT,
      task_id TEXT,
      directory TEXT NOT NULL,
      remote_session_name TEXT NOT NULL,
      connection_mode TEXT NOT NULL DEFAULT 'dtach',
      use_tmux INTEGER NOT NULL DEFAULT 0,
      workspace_execution_target_revision INTEGER,
      execution_host_id TEXT NOT NULL REFERENCES execution_hosts(id) ON DELETE CASCADE,
      execution_host_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_private INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ready',
      last_connected_at TEXT,
      error_message TEXT,
      runtime_connection_mode TEXT,
      notice_message TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    INSERT INTO terminal_sessions_canonical (
      id, user_id, name, workspace_id, task_id, directory,
      remote_session_name, connection_mode, use_tmux,
      workspace_execution_target_revision, execution_host_id,
      execution_host_revision, created_at, updated_at, is_private, status,
      last_connected_at, error_message, runtime_connection_mode, notice_message
    )
    SELECT
      id, user_id, name, workspace_id, task_id, directory,
      remote_session_name, connection_mode, use_tmux,
      CASE WHEN workspace_id IS NULL THEN NULL ELSE target_revision END,
      execution_host_id, execution_host_revision, created_at, updated_at,
      is_private, status, last_connected_at, error_message,
      runtime_connection_mode, notice_message
    FROM terminal_sessions
  `);
  db.run(`
    INSERT INTO terminal_sessions_canonical (
      id, user_id, name, workspace_id, task_id, directory,
      remote_session_name, connection_mode, use_tmux,
      workspace_execution_target_revision, execution_host_id,
      execution_host_revision, created_at, updated_at, is_private, status,
      last_connected_at, error_message, runtime_connection_mode, notice_message
    )
    SELECT
      session.id, session.user_id, session.name, NULL, NULL,
      COALESCE(server.repositories_base_path, '.'),
      session.remote_session_name, session.connection_mode, session.use_tmux,
      NULL, host.id, host.revision, session.created_at, session.updated_at,
      session.is_private, session.status, session.last_connected_at,
      session.error_message, session.runtime_connection_mode,
      session.notice_message
    FROM ssh_server_sessions session
    JOIN ssh_servers server ON server.id = session.ssh_server_id
    JOIN execution_hosts host
      ON host.user_id = session.user_id
     AND host.kind = 'ssh'
     AND host.source_id = session.ssh_server_id
    WHERE NOT EXISTS (
      SELECT 1 FROM chats WHERE chats.ssh_server_session_id = session.id
    )
  `);
  db.run("DROP TABLE terminal_sessions");
  db.run("ALTER TABLE terminal_sessions_canonical RENAME TO terminal_sessions");
  db.run("CREATE INDEX idx_terminal_sessions_workspace_id ON terminal_sessions(user_id, workspace_id)");
  db.run("CREATE INDEX idx_terminal_sessions_created_at ON terminal_sessions(user_id, created_at DESC)");
  db.run(`
    CREATE UNIQUE INDEX idx_terminal_sessions_task_id_unique
    ON terminal_sessions(user_id, task_id)
    WHERE task_id IS NOT NULL
  `);
  db.run("CREATE INDEX idx_terminal_sessions_execution_host ON terminal_sessions(execution_host_id)");
}

function rebuildChats(db: Database): void {
  db.run(`
    CREATE TABLE chats_canonical (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('workspace', 'execution_host')),
      workspace_id TEXT,
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
      execution_host_id TEXT NOT NULL REFERENCES execution_hosts(id) ON DELETE CASCADE,
      execution_host_revision INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CHECK (
        (source_kind = 'workspace' AND workspace_id IS NOT NULL)
        OR (source_kind = 'execution_host' AND workspace_id IS NULL)
      )
    )
  `);
  db.run(`
    INSERT INTO chats_canonical (
      id, user_id, name, source_kind, workspace_id, scope, task_id, directory,
      created_at, updated_at, model_provider_id, model_model_id, model_variant,
      use_worktree, auto_approve_permissions, skip_base_branch_sync,
      base_branch, mode, status, started_at, completed_at, last_activity_at,
      session_id, session_server_url, error_message, error_timestamp,
      error_code, worktree_original_branch, worktree_working_branch,
      worktree_path, pending_permission_requests, queued_messages,
      active_message_id, interrupt_requested, connection_status, is_private,
      startup_stage, execution_host_id, execution_host_revision
    )
    SELECT
      id, user_id, name,
      CASE WHEN source_kind = 'workspace' THEN 'workspace' ELSE 'execution_host' END,
      CASE WHEN source_kind = 'workspace' THEN workspace_id ELSE NULL END,
      scope, task_id, directory, created_at, updated_at, model_provider_id,
      model_model_id, model_variant, use_worktree, auto_approve_permissions,
      skip_base_branch_sync, base_branch, mode, status, started_at,
      completed_at, last_activity_at, session_id, session_server_url,
      error_message, error_timestamp, error_code, worktree_original_branch,
      worktree_working_branch, worktree_path, pending_permission_requests,
      queued_messages, active_message_id, interrupt_requested,
      connection_status, is_private, startup_stage, execution_host_id,
      execution_host_revision
    FROM chats
  `);
  db.run("DROP TABLE chats");
  db.run("ALTER TABLE chats_canonical RENAME TO chats");
  db.run("CREATE INDEX idx_chats_created_at ON chats(user_id, created_at DESC)");
  db.run("CREATE INDEX idx_chats_workspace_created_at ON chats(user_id, workspace_id, created_at DESC)");
  db.run("CREATE INDEX idx_chats_execution_host ON chats(execution_host_id)");
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

function rebuildVncSessions(db: Database): void {
  db.run(`
    CREATE TABLE vnc_sessions_canonical (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      remote_host TEXT NOT NULL DEFAULT '127.0.0.1',
      remote_port INTEGER NOT NULL,
      local_port INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      pid INTEGER,
      connected_at TEXT,
      error_message TEXT,
      execution_host_id TEXT NOT NULL REFERENCES execution_hosts(id) ON DELETE CASCADE,
      execution_host_revision INTEGER NOT NULL
    )
  `);
  db.run(`
    INSERT INTO vnc_sessions_canonical
    SELECT
      id, user_id, remote_host, remote_port, local_port, created_at,
      updated_at, status, pid, connected_at, error_message,
      execution_host_id, execution_host_revision
    FROM vnc_sessions
  `);
  db.run("DROP TABLE vnc_sessions");
  db.run("ALTER TABLE vnc_sessions_canonical RENAME TO vnc_sessions");
  db.run(`
    CREATE UNIQUE INDEX idx_vnc_sessions_active_host_port
    ON vnc_sessions(user_id, execution_host_id, remote_port)
    WHERE status IN ('starting', 'active', 'stopping')
  `);
  db.run(`
    CREATE UNIQUE INDEX idx_vnc_sessions_active_local_port
    ON vnc_sessions(local_port)
    WHERE status IN ('starting', 'active', 'stopping')
  `);
  db.run("CREATE INDEX idx_vnc_sessions_execution_host ON vnc_sessions(execution_host_id)");
}

function rebuildProvisioningJobs(db: Database): void {
  db.run(`
    CREATE TABLE provisioning_jobs_canonical (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      config_json TEXT NOT NULL,
      state_json TEXT NOT NULL,
      status TEXT NOT NULL,
      workspace_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      execution_host_id TEXT NOT NULL REFERENCES execution_hosts(id) ON DELETE CASCADE,
      execution_host_revision INTEGER NOT NULL
    )
  `);
  db.run(`
    INSERT INTO provisioning_jobs_canonical
    SELECT
      id, user_id, config_json, state_json, status, workspace_id,
      created_at, updated_at, execution_host_id, execution_host_revision
    FROM provisioning_jobs
  `);
  db.run("DROP TABLE provisioning_jobs");
  db.run("ALTER TABLE provisioning_jobs_canonical RENAME TO provisioning_jobs");
  db.run("CREATE INDEX idx_provisioning_jobs_execution_host ON provisioning_jobs(execution_host_id)");
}

export function migrateCanonicalExecutionHosts(db: Database): void {
  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN IMMEDIATE");
  try {
    backfillBindings(db);
    discardUnresolvedVncSessions(db);
    validateBindings(db);
    rewriteWorkspaceSettings(db);
    rewriteProvisioningConfigs(db);
    rebuildWorkspaces(db);
    rebuildTerminalSessions(db);
    rebuildChats(db);
    rebuildVncSessions(db);
    rebuildProvisioningJobs(db);
    db.run("DROP TABLE ssh_server_sessions");
    db.run("COMMIT");
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {
      // SQLite may have already rolled back the transaction.
    }
    throw error;
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }

  const violations = db.query("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(
      `Canonical execution-host migration left ${String(violations.length)} foreign-key violations.`,
    );
  }
}
