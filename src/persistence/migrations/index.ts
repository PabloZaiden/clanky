/**
 * Database migration bookkeeping for the consolidated Clanky schema.
 *
 * The schema created by `base-schema.ts` is promoted from the consolidated
 * version-56 production baseline. Versions 1-56 remain as no-op markers so a
 * new database has the same history as the existing production database. New
 * schema changes must append a real migration after `BASELINE_SCHEMA_VERSION`.
 * Table names accepted by `getTableColumns` are derived from
 * `schema-inventory.ts`.
 */

import type { Database } from "bun:sqlite";
import { createLogger } from "@pablozaiden/webapp/server";
import { isIntrospectableTableName } from "../schema-inventory";
import { repairConsolidatedSchema } from "./consolidated-schema-repair";

const log = createLogger("persistence:migrations");

export const BASELINE_SCHEMA_VERSION = 56;
const MULTI_RELAY_PAIRING_MIGRATION_VERSION = BASELINE_SCHEMA_VERSION + 7;

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

export const migrations: Migration[] = [
  ...HISTORICAL_MIGRATION_NAMES.map(
    (name, index) => ({
      version: index + 1,
      name,
      up: () => {},
    }),
  ),
  {
    version: BASELINE_SCHEMA_VERSION + 1,
    name: "remove_vnc_sessions",
    up: (db) => {
      db.run("DROP TABLE IF EXISTS vnc_sessions");
    },
  },
  {
    version: BASELINE_SCHEMA_VERSION + 2,
    name: "remove_obsolete_mesh_and_ssh_tables",
    transactional: false,
    up: (db) => {
      db.run("PRAGMA foreign_keys = OFF");
      try {
        for (const tableName of [
          "mesh_sync_conflicts",
          "mesh_link_claims",
          "mesh_sync_cursors",
          "mesh_sync_outbox",
          "mesh_sync_checkpoints",
          "mesh_pairing_approvals",
          "mesh_pairing_requests",
          "mesh_links",
          "mesh_link_members",
          "mesh_nodes",
          "ssh_server_sessions",
        ]) {
          db.run(`DROP TABLE IF EXISTS ${tableName}`);
        }
      } finally {
        db.run("PRAGMA foreign_keys = ON");
      }
    },
  },
  {
    version: BASELINE_SCHEMA_VERSION + 3,
    name: "remove_mesh_grants_without_encryption_keys",
    up: (db) => {
      db.run(`
        DELETE FROM mesh_controller_grants
        WHERE controller_encryption_public_key IS NULL
          OR trim(controller_encryption_public_key) = ''
      `);
      db.run(`
        DELETE FROM mesh_worker_registrations
        WHERE worker_encryption_public_key IS NULL
          OR trim(worker_encryption_public_key) = ''
      `);
      db.run(`
        DELETE FROM mesh_node_identity
        WHERE encryption_public_key IS NULL
          OR trim(encryption_public_key) = ''
      `);
    },
  },
  {
    version: BASELINE_SCHEMA_VERSION + 4,
    name: "add_mesh_protocol_v5_metadata",
    up: (db) => {
      const addColumn = (tableName: string, columnName: string, definition: string): void => {
        if (
          tableExists(db, tableName)
          && !getMigrationTableColumns(db, tableName).includes(columnName)
        ) {
          db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
        }
      };

      addColumn("mesh_worker_registrations", "worker_binary_version", "TEXT");
      addColumn(
        "mesh_worker_registrations",
        "worker_supported_protocol_versions_json",
        "TEXT NOT NULL DEFAULT '[1]'",
      );
      addColumn(
        "mesh_worker_registrations",
        "worker_preferred_protocol_version",
        "INTEGER NOT NULL DEFAULT 1",
      );
      addColumn(
        "mesh_worker_registrations",
        "worker_negotiated_protocol_version",
        "INTEGER NOT NULL DEFAULT 1",
      );
      addColumn(
        "mesh_worker_registrations",
        "worker_protocol_updated_at",
        "TEXT",
      );

      addColumn("mesh_controller_grants", "controller_binary_version", "TEXT");
      addColumn(
        "mesh_controller_grants",
        "controller_supported_protocol_versions_json",
        "TEXT NOT NULL DEFAULT '[1]'",
      );
      addColumn(
        "mesh_controller_grants",
        "controller_preferred_protocol_version",
        "INTEGER NOT NULL DEFAULT 1",
      );
      addColumn(
        "mesh_controller_grants",
        "controller_negotiated_protocol_version",
        "INTEGER NOT NULL DEFAULT 1",
      );
      addColumn(
        "mesh_controller_grants",
        "controller_protocol_updated_at",
        "TEXT",
      );

      addColumn("mesh_controller_relay_pairing", "relay_binary_version", "TEXT");
      addColumn(
        "mesh_controller_relay_pairing",
        "relay_supported_protocol_versions_json",
        "TEXT NOT NULL DEFAULT '[1]'",
      );
      addColumn(
        "mesh_controller_relay_pairing",
        "relay_preferred_protocol_version",
        "INTEGER NOT NULL DEFAULT 1",
      );
      addColumn(
        "mesh_controller_relay_pairing",
        "relay_negotiated_protocol_version",
        "INTEGER NOT NULL DEFAULT 1",
      );
      addColumn(
        "mesh_controller_relay_pairing",
        "relay_protocol_updated_at",
        "TEXT",
      );

      const hasRows = (tableName: string): boolean => {
        if (!tableExists(db, tableName)) {
          return false;
        }
        switch (tableName) {
          case "mesh_node_identity":
            return (db.query(
              "SELECT COUNT(*) AS count FROM mesh_node_identity",
            ).get() as { count: number }).count > 0;
          case "mesh_worker_registrations":
            return (db.query(
              "SELECT COUNT(*) AS count FROM mesh_worker_registrations",
            ).get() as { count: number }).count > 0;
          case "mesh_controller_grants":
            return (db.query(
              "SELECT COUNT(*) AS count FROM mesh_controller_grants",
            ).get() as { count: number }).count > 0;
          default:
            throw new Error(`Unknown Mesh state table: "${tableName}"`);
        }
      };
      const hadExistingMeshState = (
        hasRows("mesh_node_identity")
        || hasRows("mesh_worker_registrations")
        || hasRows("mesh_controller_grants")
      );
      db.run(`
        CREATE TABLE IF NOT EXISTS mesh_protocol_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          current_version INTEGER NOT NULL,
          migrated_from_version INTEGER,
          migrated_at TEXT,
          updated_at TEXT NOT NULL
        )
      `);
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO mesh_protocol_state (
          singleton, current_version, migrated_from_version, migrated_at, updated_at
        ) VALUES (1, 5, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          current_version = 5,
          updated_at = excluded.updated_at
      `, [
        hadExistingMeshState ? 1 : null,
        hadExistingMeshState ? now : null,
        now,
      ]);
    },
  },
  {
    version: BASELINE_SCHEMA_VERSION + 5,
    name: "repair_consolidated_schema",
    up: repairConsolidatedSchema,
    transactional: false,
  },
  {
    version: BASELINE_SCHEMA_VERSION + 6,
    name: "normalize_mesh_protocol_v5_metadata",
    up: (db) => {
      const now = new Date().toISOString();
      const addColumn = (
        tableName: string,
        columnName: string,
        definition: string,
      ): void => {
        if (
          tableExists(db, tableName)
          && !getMigrationTableColumns(db, tableName).includes(columnName)
        ) {
          db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
        }
      };
      if (tableExists(db, "mesh_worker_registrations")) {
        addColumn("mesh_worker_registrations", "worker_binary_version", "TEXT");
        addColumn(
          "mesh_worker_registrations",
          "worker_supported_protocol_versions_json",
          "TEXT NOT NULL DEFAULT '[5]'",
        );
        addColumn(
          "mesh_worker_registrations",
          "worker_preferred_protocol_version",
          "INTEGER NOT NULL DEFAULT 5",
        );
        addColumn(
          "mesh_worker_registrations",
          "worker_negotiated_protocol_version",
          "INTEGER NOT NULL DEFAULT 5",
        );
        addColumn(
          "mesh_worker_registrations",
          "worker_protocol_updated_at",
          "TEXT",
        );
        db.run(`
          UPDATE mesh_worker_registrations
          SET worker_supported_protocol_versions_json = '[5]',
              worker_preferred_protocol_version = 5,
              worker_negotiated_protocol_version = 5,
              worker_protocol_updated_at = COALESCE(
                worker_protocol_updated_at,
                ?
              )
        `, [now]);
      }
      if (tableExists(db, "mesh_controller_grants")) {
        addColumn("mesh_controller_grants", "controller_binary_version", "TEXT");
        addColumn(
          "mesh_controller_grants",
          "controller_supported_protocol_versions_json",
          "TEXT NOT NULL DEFAULT '[5]'",
        );
        addColumn(
          "mesh_controller_grants",
          "controller_preferred_protocol_version",
          "INTEGER NOT NULL DEFAULT 5",
        );
        addColumn(
          "mesh_controller_grants",
          "controller_negotiated_protocol_version",
          "INTEGER NOT NULL DEFAULT 5",
        );
        addColumn(
          "mesh_controller_grants",
          "controller_protocol_updated_at",
          "TEXT",
        );
        db.run(`
          UPDATE mesh_controller_grants
          SET controller_supported_protocol_versions_json = '[5]',
              controller_preferred_protocol_version = 5,
              controller_negotiated_protocol_version = 5,
              controller_protocol_updated_at = COALESCE(
                controller_protocol_updated_at,
                ?
              )
        `, [now]);
      }
      if (tableExists(db, "mesh_controller_relay_pairing")) {
        addColumn("mesh_controller_relay_pairing", "relay_binary_version", "TEXT");
        addColumn(
          "mesh_controller_relay_pairing",
          "relay_supported_protocol_versions_json",
          "TEXT NOT NULL DEFAULT '[5]'",
        );
        addColumn(
          "mesh_controller_relay_pairing",
          "relay_preferred_protocol_version",
          "INTEGER NOT NULL DEFAULT 5",
        );
        addColumn(
          "mesh_controller_relay_pairing",
          "relay_negotiated_protocol_version",
          "INTEGER NOT NULL DEFAULT 5",
        );
        addColumn(
          "mesh_controller_relay_pairing",
          "relay_protocol_updated_at",
          "TEXT",
        );
        db.run(`
          UPDATE mesh_controller_relay_pairing
          SET relay_supported_protocol_versions_json = '[5]',
              relay_preferred_protocol_version = 5,
              relay_negotiated_protocol_version = 5,
              relay_protocol_updated_at = COALESCE(
                relay_protocol_updated_at,
                ?
              )
          WHERE singleton = 1
        `, [now]);
      }
      if (tableExists(db, "mesh_protocol_state")) {
        db.run(`
          UPDATE mesh_protocol_state
          SET current_version = 5,
              updated_at = ?
          WHERE singleton = 1
        `, [now]);
      }
    },
  },
  {
    version: MULTI_RELAY_PAIRING_MIGRATION_VERSION,
    name: "add_named_controller_relays",
    up: migrateControllerRelays,
  },
];

function getMigrationTableColumns(db: Database, tableName: string): string[] {
  if (tableName === "mesh_controller_relay_pairing") {
    // The retired singleton table is intentionally absent from the current inventory.
    const rows = db.query("PRAGMA table_info(mesh_controller_relay_pairing)").all() as Array<{
      name: string;
    }>;
    return rows.map((row) => row.name);
  }
  return getTableColumns(db, tableName);
}

function migrateControllerRelays(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS mesh_controller_relays (
      name TEXT PRIMARY KEY COLLATE NOCASE NOT NULL CHECK (length(trim(name)) > 0),
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
      relay_url TEXT NOT NULL UNIQUE,
      relay_public_key TEXT NOT NULL,
      relay_fingerprint TEXT NOT NULL UNIQUE,
      controller_node_id TEXT NOT NULL,
      controller_fingerprint TEXT NOT NULL,
      paired_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      relay_binary_version TEXT,
      relay_supported_protocol_versions_json TEXT NOT NULL DEFAULT '[5]',
      relay_preferred_protocol_version INTEGER NOT NULL DEFAULT 5,
      relay_negotiated_protocol_version INTEGER NOT NULL DEFAULT 5,
      relay_protocol_updated_at TEXT
    )
  `);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mesh_controller_relays_primary
      ON mesh_controller_relays(is_primary) WHERE is_primary = 1
  `);

  if (tableExists(db, "mesh_controller_relay_pairing")) {
    if (db.query("SELECT 1 FROM mesh_controller_relay_pairing LIMIT 1").get()) {
      const columns = getMigrationTableColumns(db, "mesh_controller_relay_pairing");
      for (const [columnName, definition] of [
        ["relay_binary_version", "TEXT"],
        ["relay_supported_protocol_versions_json", "TEXT NOT NULL DEFAULT '[5]'"],
        ["relay_preferred_protocol_version", "INTEGER NOT NULL DEFAULT 5"],
        ["relay_negotiated_protocol_version", "INTEGER NOT NULL DEFAULT 5"],
        ["relay_protocol_updated_at", "TEXT"],
      ] as const) {
        if (!columns.includes(columnName)) {
          db.run(`ALTER TABLE mesh_controller_relay_pairing ADD COLUMN ${columnName} ${definition}`);
        }
      }
      db.run(`
        INSERT INTO mesh_controller_relays (
          name, is_primary, relay_url, relay_public_key, relay_fingerprint,
          controller_node_id, controller_fingerprint, paired_at, updated_at,
          relay_binary_version, relay_supported_protocol_versions_json,
          relay_preferred_protocol_version, relay_negotiated_protocol_version,
          relay_protocol_updated_at
        )
        SELECT
          'default', 1, relay_url, relay_public_key, relay_fingerprint,
          controller_node_id, controller_fingerprint, paired_at, updated_at,
          relay_binary_version, relay_supported_protocol_versions_json,
          relay_preferred_protocol_version, relay_negotiated_protocol_version,
          relay_protocol_updated_at
        FROM mesh_controller_relay_pairing
      `);
    }
    db.run("DROP TABLE mesh_controller_relay_pairing");
  }

  if (tableExists(db, "mesh_enrollment_tokens")) {
    const columns = getTableColumns(db, "mesh_enrollment_tokens");
    if (!columns.includes("relay_url")) {
      db.run("ALTER TABLE mesh_enrollment_tokens ADD COLUMN relay_url TEXT");
    }
    if (!columns.includes("relay_fingerprint")) {
      db.run("ALTER TABLE mesh_enrollment_tokens ADD COLUMN relay_fingerprint TEXT");
    }
  }
}

export function tableExists(db: Database, tableName: string): boolean {
  const result = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | null;
  return result !== null;
}

export function getTableColumns(db: Database, tableName: string): string[] {
  if (!isIntrospectableTableName(tableName)) {
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
 * production baseline.
 */
export function assertSchemaBaseline(db: Database): void {
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

export function runMigrations(
  db: Database,
): number {
  assertMigrationDefinitions();
  assertSchemaBaseline(db);
  ensureMigrationsTable(db);

  const appliedVersions = getAppliedVersions(db);
  if (
    appliedVersions.has(MULTI_RELAY_PAIRING_MIGRATION_VERSION)
    && tableExists(db, "mesh_controller_relay_pairing")
  ) {
    // The unchanged baseline schema recreates the retired table on startup.
    db.transaction(() => migrateControllerRelays(db))();
  }
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
