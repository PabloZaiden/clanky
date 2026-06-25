/**
 * Database migration system for Clanky.
 *
 * Migrations allow the database schema to evolve over time. The Clanky reset
 * starts with the complete current schema in `database.ts` and no historical
 * migrations.
 *
 * ## Adding a New Migration
 *
 * 1. Add a new entry to the `migrations` array with:
 *    - `version`: Next sequential integer starting from 1
 *    - `name`: Descriptive snake_case name (e.g., "add_user_preferences")
 *    - `up`: Function that applies the migration
 *
 * 2. The `up` function receives the Database instance and should:
 *    - Use `ALTER TABLE ... ADD COLUMN` for new columns
 *    - Use `CREATE TABLE IF NOT EXISTS` for new tables
 *    - Handle the case where the change already exists (idempotent)
 *
 * 3. Add a test in `tests/unit/migrations.test.ts`
 *
 * ## Example Migration
 *
 * ```typescript
 * {
 *   version: 1,
 *   name: "add_user_avatar",
 *   up: (db) => {
 *     const columns = getTableColumns(db, "users");
 *     if (!columns.includes("avatar_url")) {
 *       db.run("ALTER TABLE users ADD COLUMN avatar_url TEXT");
 *     }
 *   },
 * }
 * ```
 */

import type { Database } from "bun:sqlite";
import { createLogger } from "../../core/logger";

const log = createLogger("persistence:migrations");

/**
 * A database migration definition.
 */
export interface Migration {
  /** Unique version number (sequential integer starting from 1) */
  version: number;
  /** Descriptive name in snake_case */
  name: string;
  /** Function to apply the migration */
  up: (db: Database) => void;
  /** Whether the migration should be wrapped in the default transaction */
  transactional?: boolean;
}

/**
 * Known table names that are used in migrations.
 * Used to validate tableName before interpolation into PRAGMA queries,
 * since PRAGMA does not support parameterized queries.
 */
const KNOWN_TABLE_NAMES = new Set([
  "agents",
  "agent_runs",
  "chats",
  "tasks",
  "ssh_sessions",
  "ssh_servers",
  "ssh_server_sessions",
  "vnc_sessions",
  "forwarded_ports",
  "workspaces",
  "preferences",
  "review_comments",
  "schema_migrations",
]);

/**
 * Get the column names for a table.
 * Useful for checking if a column already exists before adding it.
 *
 * @throws Error if tableName is not in the KNOWN_TABLE_NAMES whitelist.
 */
export function getTableColumns(db: Database, tableName: string): string[] {
  // Validate table name against whitelist to prevent SQL injection.
  // PRAGMA queries do not support parameterized values, so we must
  // ensure the table name is safe before interpolation.
  if (!KNOWN_TABLE_NAMES.has(tableName)) {
    throw new Error(`Unknown table name: "${tableName}". Add it to KNOWN_TABLE_NAMES if it is a valid table.`);
  }
  const result = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return result.map((row) => row.name);
}

/**
 * Check if a table exists in the database.
 */
export function tableExists(db: Database, tableName: string): boolean {
  const result = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(tableName) as { name: string } | null;
  return result !== null;
}

/**
 * All migrations in order. Version numbers restart from 1 for future schema
 * changes after the Clanky reset. The current baseline has schema version 0.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: "add_chat_source_fields",
    up: (db) => {
      if (!tableExists(db, "chats")) {
        return;
      }
      const columns = getTableColumns(db, "chats");
      if (columns.includes("source_kind")) {
        return;
      }

      db.run(`
        CREATE TABLE chats_new (
          id TEXT PRIMARY KEY,
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
          connection_status TEXT NOT NULL DEFAULT 'disconnected',
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

      db.run(`
        INSERT INTO chats_new (
          id, name, source_kind, workspace_id, ssh_server_id, ssh_server_session_id,
          scope, task_id, directory, created_at, updated_at, model_provider_id,
          model_model_id, model_variant, use_worktree, auto_approve_permissions,
          skip_base_branch_sync, base_branch, mode, status, connection_status,
          started_at, completed_at, last_activity_at, session_id, session_server_url,
          error_message, error_timestamp, error_code, worktree_original_branch,
          worktree_working_branch, worktree_path, messages, logs, tool_calls,
          pending_permission_requests, active_message_id, interrupt_requested
        )
        SELECT
          id, name, 'workspace', workspace_id, NULL, NULL,
          scope, task_id, directory, created_at, updated_at, model_provider_id,
          model_model_id, model_variant, use_worktree, auto_approve_permissions,
          skip_base_branch_sync, base_branch, mode, status, 'disconnected',
          started_at, completed_at, last_activity_at, session_id, session_server_url,
          error_message, error_timestamp, error_code, worktree_original_branch,
          worktree_working_branch, worktree_path, messages, logs, tool_calls,
          pending_permission_requests, active_message_id, interrupt_requested
        FROM chats
      `);

      db.run("DROP TABLE chats");
      db.run("ALTER TABLE chats_new RENAME TO chats");
      db.run("CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats(created_at DESC)");
      db.run("CREATE INDEX IF NOT EXISTS idx_chats_workspace_created_at ON chats(workspace_id, created_at DESC)");
      db.run("CREATE INDEX IF NOT EXISTS idx_chats_ssh_server_created_at ON chats(ssh_server_id, created_at DESC)");
      db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_task_id_unique ON chats(task_id) WHERE task_id IS NOT NULL");
      db.run("CREATE INDEX IF NOT EXISTS idx_chats_directory_workspace_status ON chats(directory, workspace_id, status)");
    },
  },
  {
    version: 2,
    name: "add_vnc_sessions",
    up: (db) => {
      db.run(`
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
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vnc_sessions_active_server_port
        ON vnc_sessions(ssh_server_id, remote_port)
        WHERE status IN ('starting', 'active', 'stopping')
      `);
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vnc_sessions_active_local_port
        ON vnc_sessions(local_port)
        WHERE status IN ('starting', 'active', 'stopping')
      `);
    },
  },
  {
    version: 3,
    name: "add_agents",
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
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
      db.run(`
        CREATE TABLE IF NOT EXISTS agent_runs (
          id TEXT PRIMARY KEY,
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
      db.run("CREATE INDEX IF NOT EXISTS idx_agents_workspace_created_at ON agents(workspace_id, created_at DESC)");
      db.run("CREATE INDEX IF NOT EXISTS idx_agents_enabled_next_run ON agents(enabled, next_run_at)");
      db.run("CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_created_at ON agent_runs(agent_id, created_at DESC)");
      db.run("CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status)");
    },
  },
  {
    version: 4,
    name: "add_agent_run_chat_id",
    up: (db) => {
      if (!tableExists(db, "agent_runs")) {
        return;
      }
      const columns = getTableColumns(db, "agent_runs");
      if (columns.includes("chat_id")) {
        return;
      }
      db.run("ALTER TABLE agent_runs ADD COLUMN chat_id TEXT");
    },
  },
];

/**
 * Create the schema_migrations table if it doesn't exist.
 */
function ensureMigrationsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

/**
 * Get the list of already-applied migration versions.
 */
function getAppliedVersions(db: Database): Set<number> {
  const rows = db.query("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
  return new Set(rows.map((row) => row.version));
}

/**
 * Record a migration as applied.
 */
function recordMigration(db: Database, migration: Migration): void {
  db.run(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    [migration.version, migration.name, new Date().toISOString()]
  );
}

/**
 * Run all pending migrations.
 * 
 * This function is idempotent - it only runs migrations that haven't been applied yet.
 * Each migration is run in its own transaction for safety.
 * 
 * @param db The database instance
 * @returns The number of migrations applied
 */
export function runMigrations(db: Database): number {
  ensureMigrationsTable(db);
  
  const appliedVersions = getAppliedVersions(db);
  const pendingMigrations = migrations.filter((m) => !appliedVersions.has(m.version));
  
  if (pendingMigrations.length === 0) {
    log.debug("No pending migrations");
    return 0;
  }
  
  // Sort by version to ensure correct order
  pendingMigrations.sort((a, b) => a.version - b.version);
  
  log.info(`Running ${pendingMigrations.length} pending migration(s)...`);
  
  let appliedCount = 0;
  for (const migration of pendingMigrations) {
    log.info(`Applying migration ${migration.version}: ${migration.name}`);
    
    try {
      // Run each migration in a transaction
      if (migration.transactional === false) {
        migration.up(db);
        recordMigration(db, migration);
      } else {
        const runMigration = db.transaction(() => {
          migration.up(db);
          recordMigration(db, migration);
        });

        runMigration();
      }
      appliedCount++;
      log.info(`Migration ${migration.version} applied successfully`);
    } catch (error) {
      log.error(`Failed to apply migration ${migration.version}: ${String(error)}`);
      throw error;
    }
  }
  
  log.info(`Applied ${appliedCount} migration(s)`);
  return appliedCount;
}

/**
 * Get the current schema version (highest applied migration version).
 * Returns 0 if no migrations have been applied.
 */
export function getSchemaVersion(db: Database): number {
  if (!tableExists(db, "schema_migrations")) {
    return 0;
  }
  
  const result = db.query("SELECT MAX(version) as version FROM schema_migrations").get() as { version: number | null };
  return result.version ?? 0;
}
