/**
 * Database migration system for Clanky.
 *
 * Migrations allow the database schema to evolve over time. The Clanky reset
 * starts with the complete current schema in `database.ts`. Historical
 * migrations are retained as no-op version markers so clean databases and
 * already-deployed databases keep the same schema version.
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
  "preview_sessions",
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
 * All migrations in order. Versions 1-4 are historical markers for the clean
 * Clanky reset baseline. Future schema changes should append version 5+.
 */
export const migrations: Migration[] = [
  { version: 1, name: "add_chat_source_fields", up: () => {} },
  { version: 2, name: "add_vnc_sessions", up: () => {} },
  { version: 3, name: "add_agents", up: () => {} },
  { version: 4, name: "add_agent_run_chat_id", up: () => {} },
  {
    version: 5,
    name: "replace_port_forwards_with_previews",
    up: (db) => {
      db.run("DROP TABLE IF EXISTS forwarded_ports");
      db.run(`
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
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_preview_sessions_workspace_created
        ON preview_sessions(user_id, workspace_id, created_at DESC)
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_preview_sessions_status_updated
        ON preview_sessions(user_id, status, updated_at DESC)
      `);
    },
  },
  {
    version: 6,
    name: "add_private_sidebar_items",
    up: (db) => {
      const privateTables = [
        "workspaces",
        "tasks",
        "chats",
        "agents",
        "ssh_servers",
        "ssh_sessions",
        "ssh_server_sessions",
      ] as const;

      for (const tableName of privateTables) {
        const columns = getTableColumns(db, tableName);
        if (columns.includes("is_private")) {
          continue;
        }
        db.run(`ALTER TABLE ${tableName} ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    version: 7,
    name: "add_chat_queued_messages",
    up: (db) => {
      const columns = getTableColumns(db, "chats");
      if (!columns.includes("queued_messages")) {
        db.run("ALTER TABLE chats ADD COLUMN queued_messages TEXT");
      }
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
