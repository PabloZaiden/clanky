/**
 * SQLite database layer for Ralph Loops Management System.
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
 * Can be overridden via RALPHER_DATA_DIR environment variable.
 */
export function getDataDir(): string {
  return process.env["RALPHER_DATA_DIR"] ?? "./data";
}

/**
 * Get the path to the SQLite database file.
 */
export function getDatabasePath(): string {
  return join(getDataDir(), "ralpher.db");
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
 * This base schema is the frozen baseline after the latest clean-cut reset.
 * All legacy migrations (v1-v16, then v1-v13) have been folded into it.
 *
 * The current database schema = this baseline + any migrations in migrations/index.ts.
 *
 * New columns and tables should be added ONLY as migrations. The base schema
 * here should only be updated during future clean-cut resets that fold
 * accumulated migrations back in.
 *
 * Exception: the chats and passkey_credentials tables, plus the workspaces and
 * loops compatibility repairs for devcontainer_subpath, auto_accept_plan, and
 * pull_request_monitoring,
 * intentionally remain here because older databases can already contain reused
 * schema_migrations version numbers from pre-reset eras. Recreating or
 * repairing these schema objects during baseline startup is the repair path
 * that keeps the app working even when newer migration IDs collide with legacy
 * history.
 */
function createTables(database: Database): void {
  // Wrap all schema creation in a transaction
  const createAllTables = database.transaction(() => {
    // Workspaces table - groups loops by workspace/directory
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
    ensureWorkspaceSchema(database);

    // Loops table - stores both config and state
    database.run(`
      CREATE TABLE IF NOT EXISTS loops (
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
        git_commit_scope TEXT NOT NULL DEFAULT 'ralph',
        base_branch TEXT,
        clear_planning_folder INTEGER DEFAULT 0,
        plan_mode INTEGER DEFAULT 0,
        mode TEXT DEFAULT 'loop',
        workspace_id TEXT REFERENCES workspaces(id),
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
        -- Worktree setting
        use_worktree INTEGER NOT NULL DEFAULT 1,
        -- Plan question persistence
        plan_mode_auto_reply INTEGER NOT NULL DEFAULT 1,
        pending_plan_question TEXT
      )
    `);
    ensureLoopSchema(database);

    // Chats table - stores long-lived ACP-backed chat sessions.
    // Keep this in the base schema so startup repairs legacy databases whose
    // schema_migrations versions collide with earlier clean-cut resets.
    database.run(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        model_provider_id TEXT,
        model_model_id TEXT,
        model_variant TEXT,
        use_worktree INTEGER NOT NULL DEFAULT 1,
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
        active_message_id TEXT,
        interrupt_requested INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      )
    `);

    // Sessions table - maps loops to backend sessions
    // Uses composite primary key (backend_name, loop_id) since id was unused
    // and this combination is already unique
    database.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        backend_name TEXT NOT NULL,
        loop_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        server_url TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (backend_name, loop_id)
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
    // Keep this in the base schema so startup repairs legacy databases whose
    // schema_migrations versions may already include the passkey migration ID.
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

    // Review comments table - stores reviewer feedback for loops
    database.run(`
      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL,
        review_cycle INTEGER NOT NULL,
        comment_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        addressed_at TEXT,
        FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE
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
        loop_id TEXT,
        connection_mode TEXT NOT NULL DEFAULT 'dtach',
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
        runtime_connection_mode TEXT,
        notice_message TEXT,
        FOREIGN KEY (ssh_server_id) REFERENCES ssh_servers(id) ON DELETE CASCADE
      )
    `);

    // Forwarded ports table - port forwarding for SSH sessions
    database.run(`
      CREATE TABLE IF NOT EXISTS forwarded_ports (
        id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL,
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
        FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (ssh_session_id) REFERENCES ssh_sessions(id) ON DELETE CASCADE
      )
    `);

    // Create index for faster loop listing
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_loops_created_at ON loops(created_at DESC)
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

    // Create index for loops by workspace
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_loops_workspace_id ON loops(workspace_id)
    `);

    // Create indexes for review comments
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_review_comments_loop_id ON review_comments(loop_id)
    `);
    database.run(`
      CREATE INDEX IF NOT EXISTS idx_review_comments_loop_cycle ON review_comments(loop_id, review_cycle)
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ssh_sessions_loop_id_unique
      ON ssh_sessions(loop_id)
      WHERE loop_id IS NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_forwarded_ports_loop_id
      ON forwarded_ports(loop_id, created_at DESC)
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

    // Note: No index needed for sessions - composite primary key (backend_name, loop_id)
    // already provides efficient lookup
  });
  
  createAllTables();
}

function ensureWorkspaceSchema(database: Database): void {
  const columns = database.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "devcontainer_subpath")) {
    return;
  }
  database.run("ALTER TABLE workspaces ADD COLUMN devcontainer_subpath TEXT");
}

function ensureLoopSchema(database: Database): void {
  const columns = database.query("PRAGMA table_info(loops)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "auto_accept_plan")) {
    database.run("ALTER TABLE loops ADD COLUMN auto_accept_plan INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((column) => column.name === "pull_request_monitoring")) {
    database.run("ALTER TABLE loops ADD COLUMN pull_request_monitoring TEXT");
  }
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
  // FK dependency order: review_comments → loops/chats → workspaces.
  // review_comments references loops(id), and loops/chats reference
  // workspaces(id), so we must drop in reverse dependency order to satisfy
  // FK constraints.
  const dropAllTables = db.transaction(() => {
    db!.run("DROP TABLE IF EXISTS forwarded_ports");
    db!.run("DROP TABLE IF EXISTS review_comments");
    db!.run("DROP TABLE IF EXISTS ssh_server_sessions");
    db!.run("DROP TABLE IF EXISTS ssh_sessions");
    db!.run("DROP TABLE IF EXISTS loops");
    db!.run("DROP TABLE IF EXISTS chats");
    db!.run("DROP TABLE IF EXISTS ssh_servers");
    db!.run("DROP TABLE IF EXISTS workspaces");
    db!.run("DROP TABLE IF EXISTS sessions");
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
