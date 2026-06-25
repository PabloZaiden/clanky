/**
 * SQLite database layer for Clanky Tasks Management System.
 * Provides centralized database connection and schema management.
 * Uses Bun's native SQLite support.
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdir, rm, unlink } from "fs/promises";
import { runMigrations } from "./migrations";
import { createLogger } from "../core/logger";
import {
  TEMPORARY_FRAMEWORK_OWNER_USER_ID,
  TEMPORARY_FRAMEWORK_OWNER_USERNAME,
} from "./ownership";

const log = createLogger("database");

let db: Database | null = null;

/**
 * Get the root data directory path.
 * Can be overridden via CLANKY_DATA_DIR environment variable.
 */
export function getDataDir(): string {
  return process.env["CLANKY_DATA_DIR"] ?? "./data";
}

/**
 * Get the path to the SQLite database file.
 */
export function getDatabasePath(): string {
  return join(getDataDir(), "clanky.db");
}

function getSshServerKeyStorePath(): string {
  return join(getDataDir(), "ssh-server-keys");
}

/**
 * Get the database instance, initializing if needed.
 * This is a singleton pattern to avoid multiple connections.
 */
export function getDatabase(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }
  return db;
}

/**
 * Initialize the database connection and create tables.
 * Must be called before any database operations.
 * If already initialized with the same path, returns early.
 * If initialized with a different path, closes the old connection first.
 */
export async function initializeDatabase(): Promise<void> {
  const dbPath = getDatabasePath();
  log.debug("Initializing database", { path: dbPath });
  
  // If already initialized with the same path, return early
  if (db) {
    // Check if it's the same database path - if so, nothing to do
    // Note: db.filename returns the path of the open database
    if (db.filename === dbPath) {
      log.trace("Database already initialized with same path");
      return;
    }
    // Different path - close the old connection to prevent resource leak
    log.debug("Closing existing database connection for different path");
    db.close();
    db = null;
  }
  
  // Ensure data directory exists
  await mkdir(getDataDir(), { recursive: true });

  db = new Database(dbPath);
  log.trace("Database connection opened");
  
  // Enable foreign key constraints
  // This must be set for every connection to enforce FK constraints and cascades
  db.run("PRAGMA foreign_keys = ON");
  log.trace("PRAGMA foreign_keys = ON");
  
  // Enable WAL mode for better concurrency
  db.run("PRAGMA journal_mode = WAL");
  log.trace("PRAGMA journal_mode = WAL");
  
  // Set busy timeout to wait up to 5 seconds for locks
  // This prevents spurious failures under concurrent load
  db.run("PRAGMA busy_timeout = 5000");
  log.trace("PRAGMA busy_timeout = 5000");
  
  // Existing single-user databases need user_id columns before createTables()
  // reaches indexes that reference those columns. This is temporary one-time
  // migration support and should be removed after the production backfill.
  runTemporaryPersistenceOwnershipMigration(db);
  log.trace("Temporary persistence ownership pre-migration completed");

  // Create tables and indexes for the current baseline.
  createTables(db);
  log.trace("Tables created");
  
  // Run any pending migrations
  runMigrations(db);
  log.trace("Migrations completed");

  runTemporaryPersistenceOwnershipMigration(db);
  log.trace("Temporary persistence ownership post-migration completed");
  
  log.info("Database initialized", { path: dbPath });
}

/**
 * Create all database tables if they don't exist.
 * Uses a transaction to ensure atomicity of schema creation.
 *
 * This base schema is the Clanky reset baseline. Historical migrations and
 * legacy compatibility repairs are intentionally not preserved.
 */
const APP_OWNED_USER_TABLES = [
  "workspaces",
  "tasks",
  "chats",
  "agents",
  "agent_runs",
  "ssh_servers",
  "ssh_server_sessions",
  "ssh_sessions",
  "vnc_sessions",
  "forwarded_ports",
  "review_comments",
] as const;

const TEMPORARY_OLD_AUTH_SUBJECT = "clanky-user";

type AppOwnedUserTable = (typeof APP_OWNED_USER_TABLES)[number] | "preferences";

function createFrameworkAuthTables(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS webapp_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      auth_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      disabled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS webapp_passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL,
      device_type TEXT NOT NULL,
      backed_up INTEGER NOT NULL,
      transports TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES webapp_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS webapp_api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      expires_at TEXT,
      FOREIGN KEY (user_id) REFERENCES webapp_users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS webapp_device_auth_requests (
      device_code_hash TEXT PRIMARY KEY,
      user_code TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      status TEXT NOT NULL,
      approved_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (approved_by_user_id) REFERENCES webapp_users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS webapp_refresh_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      family_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES webapp_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_webapp_users_username ON webapp_users(username);
    CREATE INDEX IF NOT EXISTS idx_webapp_passkeys_user ON webapp_passkeys(user_id);
    CREATE INDEX IF NOT EXISTS idx_webapp_api_keys_user ON webapp_api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_webapp_refresh_user ON webapp_refresh_sessions(user_id);
  `);
}

function createTables(database: Database): void {
  // Wrap all schema creation in a transaction
  const createAllTables = database.transaction(() => {
    createFrameworkAuthTables(database);

    // Workspaces table - groups tasks by workspace/directory
    database.run(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        directory TEXT NOT NULL,
        server_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        server_settings TEXT NOT NULL DEFAULT '{}',
        source_directory TEXT,
        ssh_server_id TEXT,
        repo_url TEXT,
        base_path TEXT,
        devcontainer_subpath TEXT,
        provider TEXT
      )
    `);

    // Tasks table - stores both config and state
    database.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        -- Config fields
        name TEXT NOT NULL,
        directory TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        model_provider_id TEXT,
        model_model_id TEXT,
        model_variant TEXT,
        max_iterations INTEGER,
        max_consecutive_errors INTEGER,
        activity_timeout_seconds INTEGER,
        stop_pattern TEXT NOT NULL,
        git_branch_prefix TEXT NOT NULL,
        git_commit_scope TEXT NOT NULL DEFAULT 'clanky',
        base_branch TEXT,
        clear_planning_folder INTEGER DEFAULT 0,
        plan_mode INTEGER DEFAULT 0,
        auto_accept_plan INTEGER NOT NULL DEFAULT 0,
        mode TEXT DEFAULT 'task',
        workspace_id TEXT REFERENCES workspaces(id),
        cheap_model TEXT,
        -- State fields
        status TEXT NOT NULL DEFAULT 'idle',
        current_iteration INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT,
        last_activity_at TEXT,
        session_id TEXT,
        session_server_url TEXT,
        error_message TEXT,
        error_iteration INTEGER,
        error_timestamp TEXT,
        git_original_branch TEXT,
        git_working_branch TEXT,
        git_worktree_path TEXT,
        git_commits TEXT,
        recent_iterations TEXT,
        logs TEXT,
        messages TEXT,
        tool_calls TEXT,
        consecutive_errors TEXT,
        pending_prompt TEXT,
        pending_prompt_mode TEXT,
        pending_model_provider_id TEXT,
        pending_model_model_id TEXT,
        pending_model_variant TEXT,
        -- Plan mode state
        plan_mode_active INTEGER DEFAULT 0,
        plan_session_id TEXT,
        plan_server_url TEXT,
        plan_feedback_rounds INTEGER DEFAULT 0,
        plan_content TEXT,
        planning_folder_cleared INTEGER DEFAULT 0,
        plan_is_ready INTEGER DEFAULT 0,
        -- Review mode state
        review_mode TEXT,
        pull_request_monitoring TEXT,
        automatic_pr_flow TEXT,
        fully_autonomous INTEGER NOT NULL DEFAULT 0,
        fully_autonomous_pending INTEGER NOT NULL DEFAULT 0,
        -- Worktree setting
        use_worktree INTEGER NOT NULL DEFAULT 1,
        -- Plan question persistence
        plan_mode_auto_reply INTEGER NOT NULL DEFAULT 1,
        pending_plan_question TEXT
      )
    `);

    // Chats table - stores long-lived ACP-backed chat sessions.
    database.run(`
      CREATE TABLE IF NOT EXISTS chats (
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
        messages TEXT,
        logs TEXT,
        tool_calls TEXT,
        pending_permission_requests TEXT,
        active_message_id TEXT,
        interrupt_requested INTEGER NOT NULL DEFAULT 0,
        connection_status TEXT NOT NULL DEFAULT 'disconnected',
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
        )
      )
    `);

    // Sessions table - maps tasks to backend sessions
    // Uses composite primary key (backend_name, task_id) since id was unused
    // and this combination is already unique
    database.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        backend_name TEXT NOT NULL,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        server_url TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (backend_name, task_id)
      )
    `);

    // Preferences table - key-value store for user preferences
    database.run(`
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (key, user_id)
      )
    `);

    // Review comments table - stores reviewer feedback for tasks
    database.run(`
      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        review_cycle INTEGER NOT NULL,
        comment_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        addressed_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `);

    // SSH sessions table - workspace-level SSH sessions
    database.run(`
      CREATE TABLE IF NOT EXISTS ssh_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        remote_session_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        last_connected_at TEXT,
        error_message TEXT,
        task_id TEXT,
        connection_mode TEXT NOT NULL DEFAULT 'dtach',
        use_tmux INTEGER NOT NULL DEFAULT 0,
        runtime_connection_mode TEXT,
        notice_message TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      )
    `);

    // SSH servers table - standalone SSH server definitions
    database.run(`
      CREATE TABLE IF NOT EXISTS ssh_servers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        repositories_base_path TEXT
      )
    `);

    // SSH server sessions table - sessions on standalone SSH servers
    database.run(`
      CREATE TABLE IF NOT EXISTS ssh_server_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        ssh_server_id TEXT NOT NULL,
        name TEXT NOT NULL,
        remote_session_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        last_connected_at TEXT,
        error_message TEXT,
        connection_mode TEXT NOT NULL DEFAULT 'dtach',
        use_tmux INTEGER NOT NULL DEFAULT 0,
        runtime_connection_mode TEXT,
        notice_message TEXT,
        FOREIGN KEY (ssh_server_id) REFERENCES ssh_servers(id) ON DELETE CASCADE
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS vnc_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        ssh_server_id TEXT NOT NULL,
        remote_host TEXT NOT NULL DEFAULT '127.0.0.1',
        remote_port INTEGER NOT NULL,
        local_port INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        connected_at TEXT,
        error_message TEXT,
        FOREIGN KEY (ssh_server_id) REFERENCES ssh_servers(id) ON DELETE CASCADE
      )
    `);
    database.run(`
      DROP INDEX IF EXISTS idx_vnc_sessions_active_server_port
    `);
    database.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vnc_sessions_active_server_port
      ON vnc_sessions(user_id, ssh_server_id, remote_port)
      WHERE status IN ('starting', 'active', 'stopping')
    `);
    database.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vnc_sessions_active_local_port
      ON vnc_sessions(local_port)
      WHERE status IN ('starting', 'active', 'stopping')
    `);

    // Forwarded ports table - port forwarding for SSH sessions
    database.run(`
      CREATE TABLE IF NOT EXISTS forwarded_ports (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        ssh_session_id TEXT,
        remote_host TEXT NOT NULL,
        remote_port INTEGER NOT NULL,
        local_port INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'starting',
        pid INTEGER,
        connected_at TEXT,
        error_message TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (ssh_session_id) REFERENCES ssh_sessions(id) ON DELETE CASCADE
      )
    `);

    database.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model_provider_id TEXT NOT NULL,
        model_model_id TEXT NOT NULL,
        model_variant TEXT,
        base_branch TEXT,
        use_worktree INTEGER NOT NULL DEFAULT 1,
        schedule_start_at_local TEXT NOT NULL,
        schedule_timezone TEXT NOT NULL,
        schedule_interval_value INTEGER NOT NULL,
        schedule_interval_unit TEXT NOT NULL,
        schedule_next_run_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        mode TEXT NOT NULL DEFAULT 'agent',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        last_run_at TEXT,
        next_run_at TEXT,
        last_skipped_at TEXT,
        last_error_message TEXT,
        last_error_timestamp TEXT,
        last_error_code TEXT,
        active_run_id TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      )
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        chat_id TEXT,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        skip_reason TEXT,
        error_message TEXT,
        error_timestamp TEXT,
        error_code TEXT,
        session_id TEXT,
        session_server_url TEXT,
        worktree_original_branch TEXT,
        worktree_working_branch TEXT,
        worktree_path TEXT,
        messages TEXT NOT NULL DEFAULT '[]',
        logs TEXT NOT NULL DEFAULT '[]',
        tool_calls TEXT NOT NULL DEFAULT '[]',
        pending_permission_requests TEXT NOT NULL DEFAULT '[]',
        attachments TEXT NOT NULL DEFAULT '[]',
        config_snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);

    // Create index for faster task listing
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(user_id, created_at DESC)
    `);

    // Create composite index for workspace lookups by directory and server_fingerprint.
    // The leftmost prefix also covers single-column directory lookups.
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_workspaces_directory_server_fingerprint
      ON workspaces(user_id, directory, server_fingerprint)
    `);

    // Drop legacy single-column index that is now redundant with the composite index.
    database.run(`
      DROP INDEX IF EXISTS idx_workspaces_directory
    `);

    // Create index for tasks by workspace
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks(workspace_id)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_tasks_user_workspace_id ON tasks(user_id, workspace_id)
    `);

    // Create indexes for review comments
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_review_comments_task_id ON review_comments(task_id)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_review_comments_task_cycle ON review_comments(task_id, review_cycle)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_review_comments_user_task_id ON review_comments(user_id, task_id)
    `);

    // Chat indexes
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats(user_id, created_at DESC)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_chats_workspace_created_at
      ON chats(user_id, workspace_id, created_at DESC)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_chats_ssh_server_created_at
      ON chats(user_id, ssh_server_id, created_at DESC)
    `);
    database.run(`
      DROP INDEX IF EXISTS idx_chats_task_id_unique
    `);
    database.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_task_id_unique
      ON chats(user_id, task_id)
      WHERE task_id IS NOT NULL
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_chats_directory_workspace_status
      ON chats(user_id, directory, workspace_id, status)
    `);
    database.run(`
      DROP INDEX IF EXISTS idx_chats_workspace_id
    `);
    database.run(`
      DROP INDEX IF EXISTS idx_chats_directory
    `);

    // SSH sessions indexes
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_ssh_sessions_workspace_id
      ON ssh_sessions(user_id, workspace_id)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_ssh_sessions_created_at
      ON ssh_sessions(user_id, created_at DESC)
    `);
    database.run(`
      DROP INDEX IF EXISTS idx_ssh_sessions_task_id_unique
    `);
    database.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ssh_sessions_task_id_unique
      ON ssh_sessions(user_id, task_id)
      WHERE task_id IS NOT NULL
    `);

    // SSH servers indexes
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_ssh_servers_name
      ON ssh_servers(user_id, name COLLATE NOCASE, created_at ASC)
    `);

    // SSH server sessions indexes
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_ssh_server_sessions_server_id
      ON ssh_server_sessions(user_id, ssh_server_id, created_at DESC)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_ssh_server_sessions_created_at
      ON ssh_server_sessions(user_id, created_at DESC)
    `);

    // Forwarded ports indexes
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_forwarded_ports_task_id
      ON forwarded_ports(user_id, task_id, created_at DESC)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_forwarded_ports_ssh_session_id
      ON forwarded_ports(user_id, ssh_session_id)
    `);
    database.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_forwarded_ports_local_port_active
      ON forwarded_ports(local_port)
      WHERE status IN ('starting', 'active', 'stopping')
    `);
    database.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_forwarded_ports_workspace_remote_port_active
      ON forwarded_ports(user_id, workspace_id, remote_port)
      WHERE status IN ('starting', 'active', 'stopping')
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_agents_workspace_created_at ON agents(user_id, workspace_id, created_at DESC)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_agents_enabled_next_run ON agents(user_id, enabled, next_run_at)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_created_at ON agent_runs(user_id, agent_id, created_at DESC)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(user_id, status)
    `);

    // Note: No index needed for sessions - composite primary key (backend_name, task_id)
    // already provides efficient lookup
  });
  
  createAllTables();
}

const TEMPORARY_MIGRATION_TABLE_NAMES = new Set<string>([
  ...APP_OWNED_USER_TABLES,
  "preferences",
  "passkey_credentials",
  "auth_device_requests",
  "auth_refresh_sessions",
  "webapp_users",
  "webapp_passkeys",
  "webapp_device_auth_requests",
  "webapp_refresh_sessions",
]);

function tableExists(database: Database, tableName: string): boolean {
  const row = database
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | null;
  return row !== null;
}

function getTableColumns(database: Database, tableName: string): string[] {
  if (!TEMPORARY_MIGRATION_TABLE_NAMES.has(tableName)) {
    throw new Error(`Unknown migration table name: ${tableName}`);
  }
  const rows = database.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function ensureTemporaryFrameworkOwner(database: Database): void {
  const now = new Date().toISOString();
  const byUsername = database
    .query("SELECT id, role FROM webapp_users WHERE username = ?")
    .get(TEMPORARY_FRAMEWORK_OWNER_USERNAME) as { id: string; role: string } | null;
  const byId = database
    .query("SELECT username, role FROM webapp_users WHERE id = ?")
    .get(TEMPORARY_FRAMEWORK_OWNER_USER_ID) as { username: string; role: string } | null;

  if (byUsername && byUsername.id !== TEMPORARY_FRAMEWORK_OWNER_USER_ID) {
    throw new Error(
      `Temporary webapp auth migration expected admin owner id "${TEMPORARY_FRAMEWORK_OWNER_USER_ID}" but username "${TEMPORARY_FRAMEWORK_OWNER_USERNAME}" has id "${byUsername.id}"`,
    );
  }
  if (byId && byId.username !== TEMPORARY_FRAMEWORK_OWNER_USERNAME) {
    throw new Error(
      `Temporary webapp auth migration expected user id "${TEMPORARY_FRAMEWORK_OWNER_USER_ID}" to have username "${TEMPORARY_FRAMEWORK_OWNER_USERNAME}" but found "${byId.username}"`,
    );
  }
  if ((byUsername?.role ?? byId?.role) && (byUsername?.role ?? byId?.role) !== "owner") {
    throw new Error("Temporary webapp auth migration requires framework user admin to have owner role");
  }

  database
    .query(`
      INSERT INTO webapp_users (id, username, role, auth_version, created_at, updated_at, last_login_at, disabled_at)
      VALUES (?, ?, 'owner', 1, ?, ?, NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        role = excluded.role,
        updated_at = excluded.updated_at
    `)
    .run(TEMPORARY_FRAMEWORK_OWNER_USER_ID, TEMPORARY_FRAMEWORK_OWNER_USERNAME, now, now);
}

function assertTemporaryAuthMappingCompatible(database: Database): void {
  if (tableExists(database, "passkey_credentials")) {
    const row = database.query("SELECT COUNT(*) AS count FROM passkey_credentials").get() as { count: number };
    if (row.count > 1) {
      throw new Error("Temporary webapp auth migration expected at most one legacy Clanky passkey");
    }
  }

  if (tableExists(database, "auth_device_requests")) {
    const row = database
      .query(`
        SELECT subject FROM auth_device_requests
        WHERE subject IS NOT NULL AND subject != ?
        LIMIT 1
      `)
      .get(TEMPORARY_OLD_AUTH_SUBJECT) as { subject: string } | null;
    if (row) {
      throw new Error(`Temporary webapp auth migration cannot map legacy device auth subject "${row.subject}"`);
    }
  }

  if (tableExists(database, "auth_refresh_sessions")) {
    const row = database
      .query(`
        SELECT subject FROM auth_refresh_sessions
        WHERE subject IS NOT NULL AND subject != ?
        LIMIT 1
      `)
      .get(TEMPORARY_OLD_AUTH_SUBJECT) as { subject: string } | null;
    if (row) {
      throw new Error(`Temporary webapp auth migration cannot map legacy refresh subject "${row.subject}"`);
    }
  }
}

function migrateTemporaryLegacyAuth(database: Database): void {
  if (tableExists(database, "passkey_credentials")) {
    database
      .query(`
        INSERT OR IGNORE INTO webapp_passkeys (
          id, user_id, name, credential_id, public_key, counter, device_type,
          backed_up, transports, created_at, updated_at, last_used_at
        )
        SELECT
          id, ?, name, credential_id, public_key, counter, device_type,
          backed_up, COALESCE(transports, '[]'), created_at, updated_at, last_used_at
        FROM passkey_credentials
        ORDER BY created_at ASC
        LIMIT 1
      `)
      .run(TEMPORARY_FRAMEWORK_OWNER_USER_ID);
  }

  if (tableExists(database, "auth_device_requests")) {
    database
      .query(`
        INSERT OR IGNORE INTO webapp_device_auth_requests (
          device_code_hash, user_code, client_id, scope, status,
          approved_by_user_id, created_at, updated_at, expires_at
        )
        SELECT
          device_code_hash, user_code, client_id, scope, status,
          CASE WHEN status IN ('approved', 'consumed') THEN ? ELSE NULL END,
          created_at, updated_at, expires_at
        FROM auth_device_requests
      `)
      .run(TEMPORARY_FRAMEWORK_OWNER_USER_ID);
  }

  if (tableExists(database, "auth_refresh_sessions")) {
    database
      .query(`
        INSERT OR IGNORE INTO webapp_refresh_sessions (
          id, user_id, family_id, client_id, scope, refresh_token_hash,
          created_at, updated_at, expires_at, last_used_at, revoked_at
        )
        SELECT
          id, ?, family_id, client_id, scope, refresh_token_hash,
          created_at, updated_at, refresh_expires_at, last_used_at, revoked_at
        FROM auth_refresh_sessions
      `)
      .run(TEMPORARY_FRAMEWORK_OWNER_USER_ID);
  }
}

function dropTemporaryLegacyAuthTables(database: Database): void {
  database.run("DROP TABLE IF EXISTS auth_refresh_sessions");
  database.run("DROP TABLE IF EXISTS auth_device_requests");
  database.run("DROP TABLE IF EXISTS passkey_credentials");
}

function ensureTemporaryUserIdColumn(database: Database, tableName: AppOwnedUserTable): void {
  if (!tableExists(database, tableName)) {
    return;
  }
  const columns = getTableColumns(database, tableName);
  if (!columns.includes("user_id")) {
    database.run(`ALTER TABLE ${tableName} ADD COLUMN user_id TEXT`);
  }
  database
    .query(`UPDATE ${tableName} SET user_id = ? WHERE user_id IS NULL`)
    .run(TEMPORARY_FRAMEWORK_OWNER_USER_ID);
}

function ensureTemporaryPreferencesOwnership(database: Database): void {
  if (!tableExists(database, "preferences")) {
    return;
  }

  const columns = getTableColumns(database, "preferences");
  const tableInfo = database.query("PRAGMA table_info(preferences)").all() as Array<{ name: string; pk: number }>;
  const primaryKeyColumns = tableInfo
    .filter((row) => row.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((row) => row.name);
  const needsRebuild =
    !columns.includes("user_id") ||
    primaryKeyColumns.length !== 2 ||
    primaryKeyColumns[0] !== "key" ||
    primaryKeyColumns[1] !== "user_id";

  if (!needsRebuild) {
    database
      .query("UPDATE preferences SET user_id = ? WHERE user_id IS NULL")
      .run(TEMPORARY_FRAMEWORK_OWNER_USER_ID);
    return;
  }

  database.run("DROP TABLE IF EXISTS preferences_temporary_webapp_ownership");
  database.run(`
    CREATE TABLE preferences_temporary_webapp_ownership (
      key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (key, user_id)
    )
  `);
  const userIdExpression = columns.includes("user_id") ? "COALESCE(user_id, ?)" : "?";
  database
    .query(`
      INSERT OR REPLACE INTO preferences_temporary_webapp_ownership (key, user_id, value)
      SELECT key, ${userIdExpression}, value FROM preferences
    `)
    .run(TEMPORARY_FRAMEWORK_OWNER_USER_ID);
  database.run("DROP TABLE preferences");
  database.run("ALTER TABLE preferences_temporary_webapp_ownership RENAME TO preferences");
}

function runTemporaryPersistenceOwnershipMigration(database: Database): void {
  // TEMPORARY webapp migration/backfill: remove after the one-time production
  // deployment data has been assigned to the framework owner user "admin".
  const migrate = database.transaction(() => {
    createFrameworkAuthTables(database);
    ensureTemporaryFrameworkOwner(database);
    assertTemporaryAuthMappingCompatible(database);
    migrateTemporaryLegacyAuth(database);
    dropTemporaryLegacyAuthTables(database);
    for (const tableName of APP_OWNED_USER_TABLES) {
      ensureTemporaryUserIdColumn(database, tableName);
    }
    ensureTemporaryPreferencesOwnership(database);
  });

  migrate();
}

/**
 * Close the database connection.
 * Should be called when the application shuts down.
 */
export function closeDatabase(): void {
  if (db) {
    log.debug("Closing database connection");
    db.close();
    db = null;
    log.info("Database connection closed");
  }
}

/**
 * Check if the database is initialized and ready.
 */
export function isDatabaseReady(): boolean {
  return db !== null;
}

/**
 * Reset the database for testing purposes.
 * Drops all tables and recreates them.
 * Uses a transaction to ensure atomicity of DROP operations.
 */
export function resetDatabase(): void {
  if (!db) {
    throw new Error("Database not initialized");
  }
  
  log.warn("Resetting database - dropping all tables");
  
  // Wrap DROP operations in a transaction.
  // FK dependency order: review_comments → tasks/chats → workspaces.
  // review_comments references tasks(id), and tasks/chats reference
  // workspaces(id), so we must drop in reverse dependency order to satisfy
  // FK constraints.
  const dropAllTables = db.transaction(() => {
    db!.run("DROP TABLE IF EXISTS forwarded_ports");
    db!.run("DROP TABLE IF EXISTS agent_runs");
    db!.run("DROP TABLE IF EXISTS agents");
    db!.run("DROP TABLE IF EXISTS review_comments");
    db!.run("DROP TABLE IF EXISTS ssh_server_sessions");
    db!.run("DROP TABLE IF EXISTS ssh_sessions");
    db!.run("DROP TABLE IF EXISTS tasks");
    db!.run("DROP TABLE IF EXISTS chats");
    db!.run("DROP TABLE IF EXISTS vnc_sessions");
    db!.run("DROP TABLE IF EXISTS ssh_servers");
    db!.run("DROP TABLE IF EXISTS workspaces");
    db!.run("DROP TABLE IF EXISTS sessions");
    db!.run("DROP TABLE IF EXISTS auth_refresh_sessions");
    db!.run("DROP TABLE IF EXISTS auth_device_requests");
    db!.run("DROP TABLE IF EXISTS passkey_credentials");
    db!.run("DROP TABLE IF EXISTS preferences");
    db!.run("DROP TABLE IF EXISTS webapp_refresh_sessions");
    db!.run("DROP TABLE IF EXISTS webapp_device_auth_requests");
    db!.run("DROP TABLE IF EXISTS webapp_api_keys");
    db!.run("DROP TABLE IF EXISTS webapp_passkeys");
    db!.run("DROP TABLE IF EXISTS webapp_users");
    db!.run("DROP TABLE IF EXISTS schema_migrations");
  });
  
  dropAllTables();
  log.trace("All tables dropped");
  
  createTables(db);
  log.trace("Tables recreated");
  
  runMigrations(db);
  runTemporaryPersistenceOwnershipMigration(db);
  log.info("Database reset complete");
}

/**
 * Delete the database file completely and reinitialize.
 * This is a destructive operation - all data will be lost.
 * Use for "Reset all settings" functionality.
 */
export async function deleteAndReinitializeDatabase(): Promise<void> {
  const dbPath = getDatabasePath();
  
  log.warn("Deleting database file and reinitializing", { path: dbPath });
  
  // Close existing connection
  closeDatabase();
  
  // Delete the database file and related WAL files
  try {
    await unlink(dbPath);
    log.trace("Deleted database file");
  } catch {
    // File might not exist, that's ok
    log.trace("Database file did not exist");
  }
  try {
    await unlink(`${dbPath}-wal`);
    log.trace("Deleted WAL file");
  } catch {
    // WAL file might not exist
  }
  try {
    await unlink(`${dbPath}-shm`);
    log.trace("Deleted SHM file");
  } catch {
    // SHM file might not exist
  }

  await rm(getSshServerKeyStorePath(), { recursive: true, force: true });
   
  // Reinitialize
  await initializeDatabase();
  log.info("Database deleted and reinitialized");
}

// Aliases for backward compatibility (previously in paths.ts)
export { initializeDatabase as ensureDataDirectories };
export { isDatabaseReady as isDataDirectoryReady };
