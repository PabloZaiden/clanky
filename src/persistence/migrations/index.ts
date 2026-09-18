/**
 * Database migration bookkeeping for the consolidated Clanky schema.
 *
 * The schema created by `base-schema.ts` is the production schema at version
 * 56. Versions 1-56 remain as no-op markers so a new database has the same
 * history as the existing production database. New schema changes must append
 * a real migration after `BASELINE_SCHEMA_VERSION`.
 */

import type { Database } from "bun:sqlite";
import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("persistence:migrations");

export const BASELINE_SCHEMA_VERSION = 56;

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
  transactional?: boolean;
}

const HISTORICAL_MIGRATION_NAMES = [
  "add_chat_source_fields",
  "add_vnc_sessions",
  "add_agents",
  "add_agent_run_chat_id",
  "replace_port_forwards_with_previews",
  "add_private_sidebar_items",
  "add_chat_queued_messages",
  "add_archived_workspaces",
  "add_task_issue_number",
  "normalize_legacy_persisted_formats",
  "add_workspace_clanky_context",
  "add_clanky_context_api_keys",
  "add_agent_code",
  "add_chat_transcript_entries",
  "add_unified_transcript_payloads",
  "optimize_transcript_page_indexes",
  "remove_legacy_transcript_columns",
  "compact_database_after_transcript_cleanup",
  "add_agent_generation_chat",
  "add_mesh_identity_and_membership",
  "add_mesh_pairing_direction",
  "add_mesh_pairing_approvals",
  "add_mesh_sync_state",
  "add_mesh_pairing_member_snapshot",
  "add_mesh_takeover_claims",
  "add_mesh_takeover_signatures",
  "add_mesh_pairing_authority",
  "add_mesh_encryption_keys",
  "add_mesh_pairing_encryption_key",
  "add_mesh_pairing_request_encryption_key",
  "add_mesh_pairing_target_link",
  "add_mesh_instance_names",
  "add_workspace_execution_node",
  "add_chat_startup_stage",
  "simplify_mesh_transport_control_plane",
  "add_workspace_type",
  "add_mesh_endpoint_routing",
  "add_terminal_sessions",
  "normalize_legacy_managed_context_types",
  "add_provisioning_jobs",
  "add_execution_host_registry",
  "add_direct_execution_host_terminal_sessions",
  "make_vnc_sessions_execution_host_backed",
  "add_mesh_enrollment_tokens",
  "mesh_controller_worker_clean_break",
  "canonical_execution_host_bindings",
  "workspace_execution_targets",
  "mesh_worker_kill_nonces",
  "workspace_worker_enrollments",
  "add_mesh_worker_tls_identity",
  "add_workspace_worktree_capability",
  "add_mesh_peer_routes",
  "add_controller_relay_pairing",
  "add_execution_host_runtime_snapshots",
  "add_transcript_message_roles",
  "make_preview_sessions_execution_host_backed",
] as const;

const KNOWN_TABLE_NAMES = new Set([
  "agent_run_transcript_entries",
  "agent_run_transcript_meta",
  "agent_runs",
  "agents",
  "chat_transcript_entries",
  "chat_transcript_meta",
  "chats",
  "clanky_context_api_keys",
  "execution_hosts",
  "mesh_controller_grants",
  "mesh_controller_relay_pairing",
  "mesh_enrollment_tokens",
  "mesh_node_identity",
  "mesh_worker_kill_nonces",
  "mesh_worker_registrations",
  "preferences",
  "preview_sessions",
  "provisioning_job_logs",
  "provisioning_jobs",
  "review_comments",
  "schema_migrations",
  "sessions",
  "ssh_servers",
  "task_transcript_entries",
  "task_transcript_meta",
  "tasks",
  "terminal_sessions",
  "vnc_sessions",
  "webapp_api_keys",
  "webapp_device_auth_requests",
  "webapp_passkeys",
  "webapp_refresh_sessions",
  "webapp_users",
  "workspace_execution_targets",
  "workspace_worker_enrollments",
  "workspaces",
]);

export const migrations: Migration[] = HISTORICAL_MIGRATION_NAMES.map(
  (name, index) => ({
    version: index + 1,
    name,
    up: () => {},
  }),
);

export function tableExists(db: Database, tableName: string): boolean {
  const result = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | null;
  return result !== null;
}

export function getTableColumns(db: Database, tableName: string): string[] {
  if (!KNOWN_TABLE_NAMES.has(tableName)) {
    throw new Error(`Unknown table name: "${tableName}"`);
  }
  const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

function ensureMigrationsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

function getAppliedVersions(db: Database): Set<number> {
  const rows = db
    .query("SELECT version FROM schema_migrations")
    .all() as Array<{ version: number }>;
  return new Set(rows.map((row) => row.version));
}

function getKnownMaximumVersion(): number {
  return migrations.reduce(
    (maximum, migration) => Math.max(maximum, migration.version),
    BASELINE_SCHEMA_VERSION,
  );
}

function assertMigrationDefinitions(): void {
  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate database migration version: ${migration.version}`);
    }
    versions.add(migration.version);
  }
  if (getKnownMaximumVersion() < BASELINE_SCHEMA_VERSION) {
    throw new Error("The migration list is below the consolidated schema baseline");
  }
}

/**
 * Rejects databases that cannot safely be treated as the consolidated
 * production baseline. The application must not mark old, incomplete schemas
 * as current merely because the historical transformation code was removed.
 */
export function assertBaselineCompatibility(db: Database): void {
  if (!tableExists(db, "schema_migrations")) {
    const applicationTableCount = db
      .query(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
      `)
      .get() as { count: number };
    if (applicationTableCount.count > 0) {
      throw new Error(
        "Database has application tables but no schema_migrations table; " +
          "it predates the consolidated schema baseline and must be upgraded separately",
      );
    }
    return;
  }

  const version = getSchemaVersion(db);
  if (version > getKnownMaximumVersion()) {
    throw new Error(
      `Database schema version ${version} is newer than this application supports`,
    );
  }
  if (version > 0 && version < BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${version} is below the consolidated baseline ` +
        `${BASELINE_SCHEMA_VERSION}; refusing to mark an incomplete schema as current`,
    );
  }
}

function recordMigration(db: Database, migration: Migration): void {
  db.run(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    [migration.version, migration.name, new Date().toISOString()],
  );
}

export function runMigrations(db: Database): number {
  assertMigrationDefinitions();
  assertBaselineCompatibility(db);
  ensureMigrationsTable(db);

  const appliedVersions = getAppliedVersions(db);
  const pendingMigrations = migrations
    .filter((migration) => !appliedVersions.has(migration.version))
    .sort((left, right) => left.version - right.version);

  if (pendingMigrations.length === 0) {
    log.debug("No pending migrations");
    return 0;
  }

  log.info(`Running ${pendingMigrations.length} pending migration(s)...`);
  let appliedCount = 0;

  for (const migration of pendingMigrations) {
    log.info(`Applying migration ${migration.version}: ${migration.name}`);
    try {
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

export function getSchemaVersion(db: Database): number {
  if (!tableExists(db, "schema_migrations")) {
    return 0;
  }
  const result = db
    .query("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  return result.version ?? 0;
}
