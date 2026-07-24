/**
 * SQLite database layer for Clanky Tasks Management System.
 * Provides centralized database connection and schema management.
 * Uses Bun's native SQLite support.
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdir, rm, unlink } from "fs/promises";
import { runMigrations } from "./migrations";
import { createLogger } from "@pablozaiden/webapp/server";
import { DatabaseNotInitializedError } from "./errors";

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
    throw new DatabaseNotInitializedError();
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
  
  // Create tables and indexes for the current baseline.
  createTables(db);
  log.trace("Tables created");
  
  // Run any pending migrations
  runMigrations(db);
  log.trace("Migrations completed");

  log.info("Database initialized", { path: dbPath });
}

/**
 * Create all database tables if they don't exist.
 * Uses a transaction to ensure atomicity of schema creation.
 *
 * This base schema is the Clanky reset baseline. Historical migrations and
 * Historical migrations remain separate from this current baseline.
 */
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

    // Workspaces table - stores workspace identity and execution context
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
        pending_permission_requests TEXT,
        queued_messages TEXT,
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

    // Preview sessions table - CLI-owned workspace live previews
    database.run(`
      CREATE TABLE IF NOT EXISTS preview_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        remote_host TEXT NOT NULL,
        remote_port INTEGER NOT NULL,
        local_host TEXT NOT NULL,
        local_port INTEGER NOT NULL,
        local_url TEXT NOT NULL,
        initial_path TEXT NOT NULL,
        cli_client_id TEXT,
        cli_hostname TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        connected_at TEXT,
        closed_at TEXT,
        error_message TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
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

    // Drop the redundant single-column index now covered by the composite index.
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

    // Preview session indexes
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_preview_sessions_workspace_created
      ON preview_sessions(user_id, workspace_id, created_at DESC)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_preview_sessions_status_updated
      ON preview_sessions(user_id, status, updated_at DESC)
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
    db!.run("DROP TABLE IF EXISTS preview_sessions");
    db!.run("DROP TABLE IF EXISTS agent_run_transcript_meta");
    db!.run("DROP TABLE IF EXISTS agent_run_transcript_entries");
    db!.run("DROP TABLE IF EXISTS agent_runs");
    db!.run("DROP TABLE IF EXISTS agents");
    db!.run("DROP TABLE IF EXISTS review_comments");
    db!.run("DROP TABLE IF EXISTS ssh_server_sessions");
    db!.run("DROP TABLE IF EXISTS ssh_sessions");
    db!.run("DROP TABLE IF EXISTS task_transcript_meta");
    db!.run("DROP TABLE IF EXISTS task_transcript_entries");
    db!.run("DROP TABLE IF EXISTS tasks");
    db!.run("DROP TABLE IF EXISTS chat_transcript_meta");
    db!.run("DROP TABLE IF EXISTS chat_transcript_entries");
    db!.run("DROP TABLE IF EXISTS chats");
    db!.run("DROP TABLE IF EXISTS vnc_sessions");
    db!.run("DROP TABLE IF EXISTS ssh_servers");
    db!.run("DROP TABLE IF EXISTS workspaces");
    db!.run("DROP TABLE IF EXISTS sessions");
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
