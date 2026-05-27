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
  
  // Create tables
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
 * legacy compatibility repairs are intentionally not preserved.
 */
function createTables(database: Database): void {
  // Wrap all schema creation in a transaction
  const createAllTables = database.transaction(() => {
    // Workspaces table - groups tasks by workspace/directory
    database.run(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
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
        name TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
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
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
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
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Passkey credentials table - stores the app-wide WebAuthn credential.
    database.run(`
      CREATE TABLE IF NOT EXISTS passkey_credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      )
    `);

    // Device authorization requests - stores RFC 8628-style device flow state.
    database.run(`
      CREATE TABLE IF NOT EXISTS auth_device_requests (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        device_code_hash TEXT NOT NULL UNIQUE,
        user_code TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        denied_at TEXT,
        last_polled_at TEXT,
        poll_count INTEGER NOT NULL DEFAULT 0,
        subject TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // Refresh sessions - stores revocable rotating refresh-token chains.
    database.run(`
      CREATE TABLE IF NOT EXISTS auth_refresh_sessions (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        refresh_token_hash TEXT NOT NULL UNIQUE,
        refresh_expires_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        revocation_reason TEXT,
        replaced_by_session_id TEXT,
        parent_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Review comments table - stores reviewer feedback for tasks
    database.run(`
      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vnc_sessions_active_server_port
      ON vnc_sessions(ssh_server_id, remote_port)
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

    // Create index for faster task listing
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC)
    `);

    // Create composite index for workspace lookups by directory and server_fingerprint.
    // The leftmost prefix also covers single-column directory lookups.
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_workspaces_directory_server_fingerprint
      ON workspaces(directory, server_fingerprint)
    `);

    // Drop legacy single-column index that is now redundant with the composite index.
    database.run(`
      DROP INDEX IF EXISTS idx_workspaces_directory
    `);

    // Create index for tasks by workspace
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks(workspace_id)
    `);

    // Create indexes for review comments
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_review_comments_task_id ON review_comments(task_id)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_review_comments_task_cycle ON review_comments(task_id, review_cycle)
    `);

    // Chat indexes
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats(created_at DESC)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_chats_workspace_created_at
      ON chats(workspace_id, created_at DESC)
    `);
    database.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_task_id_unique
      ON chats(task_id)
      WHERE task_id IS NOT NULL
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_chats_directory_workspace_status
      ON chats(directory, workspace_id, status)
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
      ON ssh_sessions(workspace_id)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_ssh_sessions_created_at
      ON ssh_sessions(created_at DESC)
    `);
    database.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ssh_sessions_task_id_unique
      ON ssh_sessions(task_id)
      WHERE task_id IS NOT NULL
    `);

    // SSH servers indexes
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_ssh_servers_name
      ON ssh_servers(name COLLATE NOCASE, created_at ASC)
    `);

    // SSH server sessions indexes
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_ssh_server_sessions_server_id
      ON ssh_server_sessions(ssh_server_id, created_at DESC)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_ssh_server_sessions_created_at
      ON ssh_server_sessions(created_at DESC)
    `);

    // Forwarded ports indexes
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_forwarded_ports_task_id
      ON forwarded_ports(task_id, created_at DESC)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_forwarded_ports_ssh_session_id
      ON forwarded_ports(ssh_session_id)
    `);
    database.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_forwarded_ports_local_port_active
      ON forwarded_ports(local_port)
      WHERE status IN ('starting', 'active', 'stopping')
    `);
    database.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_forwarded_ports_workspace_remote_port_active
      ON forwarded_ports(workspace_id, remote_port)
      WHERE status IN ('starting', 'active', 'stopping')
    `);

    // Passkey credentials index
    database.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_passkey_credentials_credential_id
      ON passkey_credentials(credential_id)
    `);

    database.run(`
      DROP INDEX IF EXISTS idx_auth_device_requests_device_code_hash
    `);
    database.run(`
      DROP INDEX IF EXISTS idx_auth_device_requests_user_code
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_auth_device_requests_status_expires_at
      ON auth_device_requests(status, expires_at)
    `);

    database.run(`
      DROP INDEX IF EXISTS idx_auth_refresh_sessions_token_hash
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_auth_refresh_sessions_family_id
      ON auth_refresh_sessions(family_id, created_at DESC)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_auth_refresh_sessions_subject_created_at
      ON auth_refresh_sessions(subject, created_at DESC)
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
    db!.run("DROP TABLE IF EXISTS forwarded_ports");
    db!.run("DROP TABLE IF EXISTS review_comments");
    db!.run("DROP TABLE IF EXISTS ssh_server_sessions");
    db!.run("DROP TABLE IF EXISTS ssh_sessions");
    db!.run("DROP TABLE IF EXISTS tasks");
    db!.run("DROP TABLE IF EXISTS chats");
    db!.run("DROP TABLE IF EXISTS ssh_servers");
    db!.run("DROP TABLE IF EXISTS workspaces");
    db!.run("DROP TABLE IF EXISTS sessions");
    db!.run("DROP TABLE IF EXISTS auth_refresh_sessions");
    db!.run("DROP TABLE IF EXISTS auth_device_requests");
    db!.run("DROP TABLE IF EXISTS passkey_credentials");
    db!.run("DROP TABLE IF EXISTS preferences");
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

// Aliases for backward compatibility (previously in paths.ts)
export { initializeDatabase as ensureDataDirectories };
export { isDatabaseReady as isDataDirectoryReady };
