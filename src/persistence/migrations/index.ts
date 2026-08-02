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
 *    - Set `transactional: false` for operations such as `VACUUM` that
 *      cannot run inside a transaction
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
import { createLogger } from "@pablozaiden/webapp/server";
import { AGENT_PROVIDER_IDS, getDefaultServerSettings, parseServerSettings } from "../../shared/settings";

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
  "chat_transcript_entries",
  "chat_transcript_meta",
  "task_transcript_entries",
  "task_transcript_meta",
  "agent_run_transcript_entries",
  "agent_run_transcript_meta",
  "mesh_node_identity",
  "mesh_nodes",
  "mesh_links",
  "mesh_link_members",
  "mesh_pairing_requests",
  "mesh_pairing_approvals",
  "mesh_sync_checkpoints",
  "mesh_sync_outbox",
  "mesh_sync_cursors",
  "mesh_sync_conflicts",
  "mesh_link_claims",
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
 * All migrations in order. Versions 1-10 are historical markers or upgrades
 * for the clean Clanky reset baseline. Future schema changes append to this
 * list.
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
  {
    version: 8,
    name: "add_archived_workspaces",
    up: (db) => {
      const columns = getTableColumns(db, "workspaces");
      if (!columns.includes("archived")) {
        db.run("ALTER TABLE workspaces ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    version: 9,
    name: "add_task_issue_number",
    up: (db) => {
      const columns = getTableColumns(db, "tasks");
      if (!columns.includes("issue_number")) {
        db.run("ALTER TABLE tasks ADD COLUMN issue_number INTEGER");
      }
    },
  },
  {
    version: 10,
    name: "normalize_legacy_persisted_formats",
    up: (db) => {
      migrateWorkspaceSettings(db);
      migrateTaskModes(db);
    },
  },
  {
    version: 11,
    name: "add_workspace_clanky_context",
    up: (db) => {
      const columns = getTableColumns(db, "workspaces");
      if (!columns.includes("allow_clanky_context")) {
        db.run("ALTER TABLE workspaces ADD COLUMN allow_clanky_context INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    version: 12,
    name: "add_clanky_context_api_keys",
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS clanky_context_api_keys (
          user_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          context_type TEXT NOT NULL,
          context_id TEXT NOT NULL,
          api_key_id TEXT NOT NULL UNIQUE,
          generation INTEGER NOT NULL CHECK (generation > 0),
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          PRIMARY KEY (user_id, workspace_id, context_type, context_id, generation)
        )
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_clanky_context_api_keys_context
        ON clanky_context_api_keys(user_id, workspace_id, context_type, context_id)
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_clanky_context_api_keys_workspace
        ON clanky_context_api_keys(user_id, workspace_id)
      `);
    },
  },
  {
    version: 13,
    name: "add_agent_code",
    up: (db) => {
      const columns = getTableColumns(db, "agents");
      if (!columns.includes("code")) {
        db.run("ALTER TABLE agents ADD COLUMN code TEXT");
      }
    },
  },
  {
    version: 14,
    name: "add_chat_transcript_entries",
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS chat_transcript_entries (
          chat_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('message', 'tool', 'log')),
          timestamp TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (chat_id, entry_id),
          FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_chat_transcript_entries_page
        ON chat_transcript_entries(user_id, chat_id, timestamp DESC, kind DESC, entry_id DESC)
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS chat_transcript_meta (
          chat_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          entry_count INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_chat_transcript_meta_user
        ON chat_transcript_meta(user_id, chat_id)
      `);
    },
  },
  {
    version: 15,
    name: "add_unified_transcript_payloads",
    up: (db) => {
      const chatEntryColumns = getTableColumns(db, "chat_transcript_entries");
      for (const column of ["tool_name", "tool_status", "tool_input", "tool_output", "tool_extras"]) {
        if (!chatEntryColumns.includes(column)) {
          db.run(`ALTER TABLE chat_transcript_entries ADD COLUMN ${column} TEXT`);
        }
      }

      const legacyToolRows = db.query(`
        SELECT chat_id, user_id, entry_id, payload
        FROM chat_transcript_entries
        WHERE kind = 'tool' AND tool_name IS NULL
      `).all() as Array<{ chat_id: string; user_id: string; entry_id: string; payload: string }>;
      const updateLegacyTool = db.prepare(`
        UPDATE chat_transcript_entries
        SET payload = ?, tool_name = ?, tool_status = ?, tool_input = ?, tool_output = ?, tool_extras = ?
        WHERE chat_id = ? AND user_id = ? AND entry_id = ?
      `);
      for (const row of legacyToolRows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.payload);
        } catch (error) {
          throw new Error(`Unable to migrate chat transcript tool ${row.entry_id}`, { cause: error });
        }
        if (
          !isRecord(parsed)
          || typeof parsed["name"] !== "string"
          || !["pending", "running", "completed", "failed"].includes(String(parsed["status"]))
        ) {
          throw new Error(`Invalid chat transcript tool payload: ${row.entry_id}`);
        }
        const toolName = parsed["name"] as string;
        const toolStatus = parsed["status"] as string;
        const serialize = (value: unknown): string | null => {
          const serialized = JSON.stringify(value);
          return serialized === undefined ? null : serialized;
        };
        updateLegacyTool.run(
          "{}",
          toolName,
          toolStatus,
          serialize(parsed["input"]),
          serialize(parsed["output"]),
          serialize(parsed["extras"]),
          row.chat_id,
          row.user_id,
          row.entry_id,
        );
      }

      db.run(`
        CREATE TABLE IF NOT EXISTS task_transcript_entries (
          task_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('message', 'tool', 'log')),
          timestamp TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          payload TEXT NOT NULL,
          tool_name TEXT,
          tool_status TEXT,
          tool_input TEXT,
          tool_output TEXT,
          tool_extras TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (task_id, entry_id),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_task_transcript_entries_page
        ON task_transcript_entries(user_id, task_id, timestamp DESC, kind DESC, entry_id DESC)
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS task_transcript_meta (
          task_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          entry_count INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_task_transcript_meta_user
        ON task_transcript_meta(user_id, task_id)
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS agent_run_transcript_entries (
          agent_run_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('message', 'tool', 'log')),
          timestamp TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          payload TEXT NOT NULL,
          tool_name TEXT,
          tool_status TEXT,
          tool_input TEXT,
          tool_output TEXT,
          tool_extras TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (agent_run_id, entry_id),
          FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_agent_run_transcript_entries_page
        ON agent_run_transcript_entries(user_id, agent_run_id, timestamp DESC, kind DESC, entry_id DESC)
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS agent_run_transcript_meta (
          agent_run_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          entry_count INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_agent_run_transcript_meta_user
        ON agent_run_transcript_meta(user_id, agent_run_id)
      `);
    },
  },
  {
    version: 16,
    name: "optimize_transcript_page_indexes",
    up: (db) => {
      for (const resource of ["chat", "task", "agent_run"] as const) {
        db.run(`DROP INDEX IF EXISTS idx_${resource}_transcript_entries_page`);
        db.run(`
          CREATE INDEX IF NOT EXISTS idx_${resource}_transcript_entries_page
          ON ${resource}_transcript_entries(user_id, ${resource === "agent_run" ? "agent_run_id" : `${resource}_id`}, timestamp DESC, sequence DESC, kind DESC, entry_id DESC)
        `);
      }
    },
  },
  {
    version: 17,
    name: "remove_legacy_transcript_columns",
    up: (db) => {
      const resources = [
        {
          resource: "chat",
          parentTable: "chats",
          metaTable: "chat_transcript_meta",
          entriesTable: "chat_transcript_entries",
          resourceColumn: "chat_id",
        },
        {
          resource: "task",
          parentTable: "tasks",
          metaTable: "task_transcript_meta",
          entriesTable: "task_transcript_entries",
          resourceColumn: "task_id",
        },
        {
          resource: "agent_run",
          parentTable: "agent_runs",
          metaTable: "agent_run_transcript_meta",
          entriesTable: "agent_run_transcript_entries",
          resourceColumn: "agent_run_id",
        },
      ] as const;

      for (const resource of resources) {
        if (
          !tableExists(db, resource.parentTable)
          || !tableExists(db, resource.metaTable)
          || !tableExists(db, resource.entriesTable)
        ) {
          throw new Error(
            `Cannot remove legacy ${resource.resource} transcript columns: normalized tables are missing`,
          );
        }

        const incomplete = db.query(`
          SELECT parent.id, parent.user_id, meta.user_id AS meta_user_id,
            meta.entry_count, COALESCE(entries.actual_count, 0) AS actual_count
          FROM ${resource.parentTable} AS parent
          LEFT JOIN ${resource.metaTable} AS meta
            ON meta.${resource.resourceColumn} = parent.id
          LEFT JOIN (
            SELECT ${resource.resourceColumn}, COUNT(*) AS actual_count
            FROM ${resource.entriesTable}
            GROUP BY ${resource.resourceColumn}
          ) AS entries
            ON entries.${resource.resourceColumn} = parent.id
          WHERE meta.${resource.resourceColumn} IS NULL
            OR meta.user_id <> parent.user_id
            OR meta.entry_count <> COALESCE(entries.actual_count, 0)
          LIMIT 1
        `).get() as {
          id: string;
          user_id: string;
          meta_user_id: string | null;
          entry_count: number | null;
          actual_count: number;
        } | null;

        if (incomplete) {
          throw new Error(
            `Cannot remove legacy ${resource.resource} transcript columns: `
            + `normalized transcript is incomplete for ${incomplete.id} `
            + `(metadata user ${incomplete.meta_user_id ?? "missing"}, `
            + `entry count ${incomplete.entry_count ?? "missing"}, actual ${incomplete.actual_count})`,
          );
        }
      }

      for (const tableName of ["chats", "tasks", "agent_runs"] as const) {
        for (const column of ["messages", "logs", "tool_calls"] as const) {
          if (getTableColumns(db, tableName).includes(column)) {
            db.run(`ALTER TABLE ${tableName} DROP COLUMN ${column}`);
          }
        }
      }
    },
  },
  {
    version: 18,
    name: "compact_database_after_transcript_cleanup",
    // VACUUM cannot run inside the transaction used by normal migrations.
    transactional: false,
    up: (db) => {
      const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (checkpoint.busy !== 0) {
        throw new Error(`SQLite WAL checkpoint was busy before VACUUM (status: ${checkpoint.busy})`);
      }
      db.run("VACUUM");
      const finalCheckpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (finalCheckpoint.busy !== 0) {
        throw new Error(`SQLite WAL checkpoint was busy after VACUUM (status: ${finalCheckpoint.busy})`);
      }
    },
  },
  {
    version: 19,
    name: "add_agent_generation_chat",
    up: (db) => {
      if (!tableExists(db, "agents")) {
        return;
      }
      const columns = getTableColumns(db, "agents");
      if (!columns.includes("generation_chat_id")) {
        db.run("ALTER TABLE agents ADD COLUMN generation_chat_id TEXT");
      }
    },
  },
  {
    version: 20,
    name: "add_mesh_identity_and_membership",
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS mesh_node_identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          node_id TEXT NOT NULL UNIQUE,
          public_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS mesh_nodes (
          node_id TEXT PRIMARY KEY,
          public_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL UNIQUE,
          endpoint TEXT,
          transport TEXT NOT NULL DEFAULT 'https'
            CHECK (transport IN ('https', 'http')),
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('pending', 'active', 'offline', 'revoked', 'rejoining')),
          last_seen_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS mesh_links (
          link_id TEXT PRIMARY KEY,
          local_user_id TEXT NOT NULL UNIQUE,
          active_node_id TEXT,
          takeover_generation INTEGER NOT NULL DEFAULT 0
            CHECK (takeover_generation >= 0),
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'conflict', 'revoked')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (local_user_id) REFERENCES webapp_users(id) ON DELETE CASCADE,
          FOREIGN KEY (active_node_id) REFERENCES mesh_nodes(node_id) ON DELETE SET NULL
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS mesh_link_members (
          link_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          local_user_id TEXT NOT NULL,
          endpoint TEXT,
          transport TEXT NOT NULL DEFAULT 'https'
            CHECK (transport IN ('https', 'http')),
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'active', 'offline', 'revoked', 'rejoining')),
          membership_generation INTEGER NOT NULL DEFAULT 1
            CHECK (membership_generation > 0),
          last_seen_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (link_id, node_id),
          FOREIGN KEY (link_id) REFERENCES mesh_links(link_id) ON DELETE CASCADE,
          FOREIGN KEY (node_id) REFERENCES mesh_nodes(node_id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS mesh_pairing_requests (
          id TEXT PRIMARY KEY,
          link_id TEXT,
          target_local_user_id TEXT,
          requested_node_id TEXT NOT NULL,
          requested_local_user_id TEXT NOT NULL,
          requested_username TEXT,
          endpoint TEXT NOT NULL,
          transport TEXT NOT NULL DEFAULT 'https'
            CHECK (transport IN ('https', 'http')),
          public_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          nonce TEXT NOT NULL UNIQUE,
          signature TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
          expires_at TEXT NOT NULL,
          approved_at TEXT,
          approved_by_user_id TEXT,
          rejection_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (link_id) REFERENCES mesh_links(link_id) ON DELETE SET NULL,
          FOREIGN KEY (requested_node_id) REFERENCES mesh_nodes(node_id) ON DELETE CASCADE,
          FOREIGN KEY (approved_by_user_id) REFERENCES webapp_users(id) ON DELETE SET NULL
        )
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_mesh_nodes_status
        ON mesh_nodes(status, updated_at DESC)
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_mesh_links_user
        ON mesh_links(local_user_id, updated_at DESC)
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_mesh_members_node
        ON mesh_link_members(node_id, status, updated_at DESC)
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_mesh_pairing_target
        ON mesh_pairing_requests(target_local_user_id, status, created_at DESC)
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_mesh_pairing_link
        ON mesh_pairing_requests(link_id, status, created_at DESC)
      `);
    },
  },
  {
    version: 21,
    name: "add_mesh_pairing_direction",
    up: (db) => {
      const columns = getTableColumns(db, "mesh_pairing_requests");
      if (!columns.includes("direction")) {
        db.run(`
          ALTER TABLE mesh_pairing_requests
          ADD COLUMN direction TEXT NOT NULL DEFAULT 'incoming'
          CHECK (direction IN ('incoming', 'outgoing'))
        `);
      }
    },
  },
  {
    version: 22,
    name: "add_mesh_pairing_approvals",
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS mesh_pairing_approvals (
          request_id TEXT PRIMARY KEY,
          link_id TEXT NOT NULL,
          approved_by_node_id TEXT NOT NULL,
          approved_by_local_user_id TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          transport TEXT NOT NULL
            CHECK (transport IN ('https', 'http')),
          public_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          signature TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'accepted', 'rejected')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (request_id) REFERENCES mesh_pairing_requests(id) ON DELETE CASCADE,
          FOREIGN KEY (approved_by_node_id) REFERENCES mesh_nodes(node_id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_mesh_pairing_approvals_status
        ON mesh_pairing_approvals(status, updated_at DESC)
      `);
    },
  },
  {
    version: 23,
    name: "add_mesh_sync_state",
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS mesh_sync_checkpoints (
          checkpoint_id TEXT PRIMARY KEY,
          link_id TEXT NOT NULL,
          aggregate_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          origin_node_id TEXT NOT NULL,
          base_revision INTEGER NOT NULL,
          target_revision INTEGER NOT NULL,
          base_payload TEXT,
          payload TEXT,
          tombstone INTEGER NOT NULL DEFAULT 0 CHECK (tombstone IN (0, 1)),
          created_at TEXT NOT NULL,
          UNIQUE(origin_node_id, aggregate_type, aggregate_id, target_revision),
          FOREIGN KEY (link_id) REFERENCES mesh_links(link_id) ON DELETE CASCADE,
          FOREIGN KEY (origin_node_id) REFERENCES mesh_nodes(node_id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS mesh_sync_outbox (
          peer_node_id TEXT NOT NULL,
          checkpoint_id TEXT NOT NULL,
          link_id TEXT NOT NULL,
          aggregate_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          origin_node_id TEXT NOT NULL,
          target_revision INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'inflight', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (peer_node_id, aggregate_type, aggregate_id, origin_node_id),
          FOREIGN KEY (peer_node_id) REFERENCES mesh_nodes(node_id) ON DELETE CASCADE,
          FOREIGN KEY (checkpoint_id) REFERENCES mesh_sync_checkpoints(checkpoint_id) ON DELETE CASCADE,
          FOREIGN KEY (link_id) REFERENCES mesh_links(link_id) ON DELETE CASCADE,
          FOREIGN KEY (origin_node_id) REFERENCES mesh_nodes(node_id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS mesh_sync_cursors (
          peer_node_id TEXT NOT NULL,
          aggregate_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          origin_node_id TEXT NOT NULL,
          applied_revision INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (peer_node_id, aggregate_type, aggregate_id, origin_node_id),
          FOREIGN KEY (peer_node_id) REFERENCES mesh_nodes(node_id) ON DELETE CASCADE,
          FOREIGN KEY (origin_node_id) REFERENCES mesh_nodes(node_id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS mesh_sync_conflicts (
          conflict_id TEXT PRIMARY KEY,
          link_id TEXT NOT NULL,
          aggregate_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          origin_node_id TEXT NOT NULL,
          remote_revision INTEGER NOT NULL,
          base_payload TEXT,
          local_payload TEXT,
          remote_payload TEXT,
          status TEXT NOT NULL DEFAULT 'open'
            CHECK (status IN ('open', 'resolved', 'dismissed')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(link_id, aggregate_type, aggregate_id, origin_node_id, remote_revision),
          FOREIGN KEY (link_id) REFERENCES mesh_links(link_id) ON DELETE CASCADE,
          FOREIGN KEY (origin_node_id) REFERENCES mesh_nodes(node_id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_mesh_sync_outbox_due
        ON mesh_sync_outbox(status, next_attempt_at, updated_at)
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_mesh_sync_checkpoints_aggregate
        ON mesh_sync_checkpoints(link_id, aggregate_type, aggregate_id, origin_node_id, target_revision DESC)
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_mesh_sync_conflicts_status
        ON mesh_sync_conflicts(link_id, status, updated_at DESC)
      `);
    },
  },
  {
    version: 24,
    name: "add_mesh_pairing_member_snapshot",
    up: (db) => {
      const columns = getTableColumns(db, "mesh_pairing_approvals");
      if (!columns.includes("members_json")) {
        db.run(`
          ALTER TABLE mesh_pairing_approvals
          ADD COLUMN members_json TEXT NOT NULL DEFAULT '[]'
        `);
      }
    },
  },
  {
    version: 25,
    name: "add_mesh_takeover_claims",
    up: (db) => {
      const columns = getTableColumns(db, "mesh_links");
      if (!columns.includes("active_claimed_at")) {
        db.run("ALTER TABLE mesh_links ADD COLUMN active_claimed_at TEXT");
      }
      if (!columns.includes("active_claim_origin")) {
        db.run("ALTER TABLE mesh_links ADD COLUMN active_claim_origin TEXT");
      }
      db.run(`
        CREATE TABLE IF NOT EXISTS mesh_link_claims (
          claim_id TEXT PRIMARY KEY,
          link_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          claimed_at TEXT NOT NULL,
          claim_origin TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'conflict', 'superseded')),
          created_at TEXT NOT NULL,
          UNIQUE(link_id, generation, node_id),
          FOREIGN KEY (link_id) REFERENCES mesh_links(link_id) ON DELETE CASCADE,
          FOREIGN KEY (node_id) REFERENCES mesh_nodes(node_id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_mesh_link_claims_link
        ON mesh_link_claims(link_id, generation DESC, created_at DESC)
      `);
    },
  },
  {
    version: 26,
    name: "add_mesh_takeover_signatures",
    up: (db) => {
      const columns = getTableColumns(db, "mesh_link_claims");
      if (!columns.includes("signature")) {
        db.run("ALTER TABLE mesh_link_claims ADD COLUMN signature TEXT");
      }
    },
  },
  {
    version: 27,
    name: "add_mesh_pairing_authority",
    up: (db) => {
      const columns = getTableColumns(db, "mesh_pairing_approvals");
      if (!columns.includes("active_node_id")) {
        db.run(`
          ALTER TABLE mesh_pairing_approvals
          ADD COLUMN active_node_id TEXT
        `);
      }
      if (!columns.includes("takeover_generation")) {
        db.run(`
          ALTER TABLE mesh_pairing_approvals
          ADD COLUMN takeover_generation INTEGER NOT NULL DEFAULT 0
            CHECK (takeover_generation >= 0)
        `);
      }
    },
  },
  {
    version: 28,
    name: "add_mesh_encryption_keys",
    up: (db) => {
      const identityColumns = getTableColumns(db, "mesh_node_identity");
      if (!identityColumns.includes("encryption_public_key")) {
        db.run(`
          ALTER TABLE mesh_node_identity
          ADD COLUMN encryption_public_key TEXT
        `);
      }
      const nodeColumns = getTableColumns(db, "mesh_nodes");
      if (!nodeColumns.includes("encryption_public_key")) {
        db.run(`
          ALTER TABLE mesh_nodes
          ADD COLUMN encryption_public_key TEXT
        `);
      }
    },
  },
  {
    version: 29,
    name: "add_mesh_pairing_encryption_key",
    up: (db) => {
      const columns = getTableColumns(db, "mesh_pairing_approvals");
      if (!columns.includes("encryption_public_key")) {
        db.run(`
          ALTER TABLE mesh_pairing_approvals
          ADD COLUMN encryption_public_key TEXT
        `);
      }
    },
  },
  {
    version: 30,
    name: "add_mesh_pairing_request_encryption_key",
    up: (db) => {
      const columns = getTableColumns(db, "mesh_pairing_requests");
      if (!columns.includes("encryption_public_key")) {
        db.run(`
          ALTER TABLE mesh_pairing_requests
          ADD COLUMN encryption_public_key TEXT
        `);
      }
    },
  },
  {
    version: 31,
    name: "add_mesh_pairing_target_link",
    up: (db) => {
      const columns = getTableColumns(db, "mesh_pairing_requests");
      if (!columns.includes("target_link_id")) {
        db.run(`
          ALTER TABLE mesh_pairing_requests
          ADD COLUMN target_link_id TEXT
        `);
      }
    },
  },
  {
    version: 32,
    name: "add_mesh_instance_names",
    up: (db) => {
      if (!getTableColumns(db, "mesh_node_identity").includes("instance_name")) {
        db.run("ALTER TABLE mesh_node_identity ADD COLUMN instance_name TEXT");
      }
      if (!getTableColumns(db, "mesh_nodes").includes("instance_name")) {
        db.run("ALTER TABLE mesh_nodes ADD COLUMN instance_name TEXT");
      }
      if (!getTableColumns(db, "mesh_pairing_requests").includes("requested_instance_name")) {
        db.run("ALTER TABLE mesh_pairing_requests ADD COLUMN requested_instance_name TEXT");
      }
      if (!getTableColumns(db, "mesh_pairing_approvals").includes("approved_by_instance_name")) {
        db.run("ALTER TABLE mesh_pairing_approvals ADD COLUMN approved_by_instance_name TEXT");
      }
    },
  },
];

const AGENT_PROVIDERS = new Set<string>(AGENT_PROVIDER_IDS);
const DEFAULT_SERVER_SETTINGS_JSON = JSON.stringify(getDefaultServerSettings());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAgentProvider(value: unknown): value is string {
  return typeof value === "string" && AGENT_PROVIDERS.has(value);
}

function migrateWorkspaceSettings(db: Database): void {
  if (!tableExists(db, "workspaces")) {
    return;
  }

  const rows = db.query("SELECT id, server_settings FROM workspaces").all() as Array<{
    id: string;
    server_settings: string | null;
  }>;
  const update = db.query("UPDATE workspaces SET server_settings = ? WHERE id = ?");

  for (const row of rows) {
    if (typeof row.server_settings !== "string") {
      log.warn("Normalizing missing persisted workspace server settings", { workspaceId: row.id });
      update.run(DEFAULT_SERVER_SETTINGS_JSON, row.id);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.server_settings);
    } catch (error) {
      log.warn("Normalizing invalid persisted workspace server settings", {
        workspaceId: row.id,
        error: String(error),
      });
      update.run(DEFAULT_SERVER_SETTINGS_JSON, row.id);
      continue;
    }
    if (!isRecord(parsed)) {
      log.warn("Normalizing non-object persisted workspace server settings", { workspaceId: row.id });
      update.run(DEFAULT_SERVER_SETTINGS_JSON, row.id);
      continue;
    }

    const mode = parsed["mode"];
    const agent = isRecord(parsed["agent"]) ? parsed["agent"] : undefined;
    const agentRecord = agent ?? {};
    const execution = isRecord(parsed["execution"]) ? parsed["execution"] : undefined;
    let migrated: Record<string, unknown> | undefined;

    if (typeof mode === "string") {
      const transport = mode === "connect" ? "ssh" : "stdio";
      migrated = {
        agent: transport === "ssh"
          ? {
              provider: "opencode",
              transport,
              hostname: typeof parsed["hostname"] === "string" ? parsed["hostname"] : "127.0.0.1",
              ...(typeof parsed["port"] === "number" ? { port: parsed["port"] } : {}),
              ...(typeof parsed["password"] === "string" ? { password: parsed["password"] } : {}),
            }
          : {
              provider: "opencode",
              transport,
            },
      };
    } else if (execution) {
      const transport = agentRecord["transport"] === "ssh" ? "ssh" : "stdio";
      const provider = isAgentProvider(agentRecord["provider"]) ? agentRecord["provider"] : "opencode";
      if (transport === "ssh") {
        migrated = {
          agent: {
            provider,
            transport,
            hostname:
              typeof agentRecord["hostname"] === "string" && agentRecord["hostname"].trim().length > 0
                ? agentRecord["hostname"]
                : typeof execution["host"] === "string" && execution["host"].trim().length > 0
                  ? execution["host"]
                  : "127.0.0.1",
            port:
              typeof execution["port"] === "number"
                ? execution["port"]
                : typeof agentRecord["port"] === "number"
                  ? agentRecord["port"]
                  : 22,
            ...(typeof agentRecord["username"] === "string"
              ? { username: agentRecord["username"] }
              : typeof execution["user"] === "string"
                ? { username: execution["user"] }
                : {}),
            ...(typeof agentRecord["password"] === "string" ? { password: agentRecord["password"] } : {}),
            ...(typeof agentRecord["identityFile"] === "string" && agentRecord["identityFile"].trim().length > 0
              ? { identityFile: agentRecord["identityFile"] }
              : {}),
          },
        };
      } else {
        migrated = {
          agent: {
            provider,
            transport,
          },
        };
      }
    }

    if (migrated) {
      update.run(JSON.stringify(migrated), row.id);
      continue;
    }

    try {
      parseServerSettings(row.server_settings);
    } catch {
      log.warn("Normalizing non-canonical persisted workspace server settings", { workspaceId: row.id });
      update.run(DEFAULT_SERVER_SETTINGS_JSON, row.id);
    }
  }
}

function migrateTaskModes(db: Database): void {
  if (!tableExists(db, "tasks")) {
    return;
  }

  const columns = getTableColumns(db, "tasks");
  if (!columns.includes("mode")) {
    db.run("ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'task'");
  }
  db.run("UPDATE tasks SET mode = 'task' WHERE mode IS NULL OR mode <> 'task'");
}

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
 * Each migration is run in its own transaction for safety unless it opts out
 * with `transactional: false`.
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
