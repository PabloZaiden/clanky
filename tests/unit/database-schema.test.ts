import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createBaseSchema } from "../../src/persistence/base-schema";
import {
  closeDatabase,
  getDatabase,
  initializeDatabase,
  resetDatabase,
} from "../../src/persistence/database";
import {
  BASELINE_SCHEMA_VERSION,
  getTableColumns,
  getSchemaVersion,
  migrations,
  runMigrations,
} from "../../src/persistence/migrations";
import {
  assertSchemaInventory,
  getFreshSchemaTableNames,
  getIntrospectableTableNames,
  getResettableTableNames,
} from "../../src/persistence/schema-inventory";

async function withTempDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "clanky-db-schema-"));
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
  try {
    await run(dataDir);
  } finally {
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
  }
}

function tableNames(): string[] {
  return (
    getDatabase()
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
}

function columnNames(tableName: string): string[] {
  return (
    getDatabase().query(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function indexNames(tableName: string): string[] {
  return (
    getDatabase()
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all(tableName) as Array<{ name: string }>
  ).map((row) => row.name);
}

function createVersionedMigrationDatabase(
  dataDir: string,
  version: number,
): void {
  const database = new Database(join(dataDir, "clanky.db"));
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  database.run(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    [version, `migration_${String(version)}`, "now"],
  );
  database.close();
}

function createLegacyConsolidatedDatabase(): Database {
  const database = new Database(":memory:");
  database.run("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE execution_hosts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE mesh_worker_registrations (
      worker_node_id TEXT NOT NULL,
      local_user_id TEXT NOT NULL,
      worker_capabilities_json TEXT,
      worker_platform_os TEXT,
      worker_platform_architecture TEXT,
      registration_scope TEXT NOT NULL DEFAULT 'global',
      workspace_worker_enrollment_id TEXT,
      workspace_id TEXT,
      grant_status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      execution_host_id TEXT NOT NULL,
      execution_host_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE chat_transcript_entries (
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      tool_name TEXT,
      tool_status TEXT,
      tool_input TEXT,
      tool_output TEXT,
      tool_extras TEXT,
      PRIMARY KEY (chat_id, entry_id)
    );
    CREATE TABLE task_transcript_entries (
      task_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      kind TEXT NOT NULL,
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
      PRIMARY KEY (task_id, entry_id)
    );
    CREATE TABLE agent_run_transcript_entries (
      agent_run_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      kind TEXT NOT NULL,
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
      PRIMARY KEY (agent_run_id, entry_id)
    );
    CREATE TABLE preview_sessions (
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
      error_message TEXT
    );
  `);
  for (let version = 1; version <= 60; version++) {
    database.run(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      [version, `migration_${String(version)}`, "now"],
    );
  }
  database.run(
    `INSERT INTO execution_hosts (
      id, user_id, kind, source_id, target_key, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["host-1", "user-1", "mesh", "worker-1", "mesh:worker-1", 1, "now", "now"],
  );
  database.run(
    `INSERT INTO mesh_worker_registrations (
      worker_node_id, local_user_id, worker_capabilities_json,
      worker_platform_os, worker_platform_architecture,
      registration_scope, grant_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["worker-1", "user-1", "{}", "linux", "x64", "global", "active"],
  );
  database.run(
    `INSERT INTO workspaces (
      id, user_id, execution_host_id, execution_host_revision, updated_at
    ) VALUES (?, ?, ?, ?, ?)`,
    ["workspace-1", "user-1", "host-1", 1, "now"],
  );
  database.run(
    `INSERT INTO chat_transcript_entries (
      chat_id, user_id, entry_id, kind, timestamp, sequence, payload,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "chat-1",
      "user-1",
      "entry-1",
      "message",
      "now",
      1,
      JSON.stringify({ role: "assistant", content: "hello" }),
      "now",
      "now",
    ],
  );
  database.run(
    `INSERT INTO preview_sessions (
      id, user_id, workspace_id, remote_host, remote_port, local_host,
      local_port, local_url, initial_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "preview-valid",
      "user-1",
      "workspace-1",
      "127.0.0.1",
      3000,
      "127.0.0.1",
      4000,
      "http://127.0.0.1:4000",
      "/",
      "now",
      "now",
    ],
  );
  database.run(
    `INSERT INTO preview_sessions (
      id, user_id, workspace_id, remote_host, remote_port, local_host,
      local_port, local_url, initial_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "preview-invalid",
      "user-1",
      "missing-workspace",
      "127.0.0.1",
      3001,
      "127.0.0.1",
      4001,
      "http://127.0.0.1:4001",
      "/",
      "now",
      "now",
    ],
  );
  return database;
}

describe("database schema", () => {
  afterEach(() => {
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
  });

  test("creates the current schema from the authoritative inventory", async () => {
    await withTempDataDir(async () => {
      await initializeDatabase();

      expect(getSchemaVersion(getDatabase())).toBe(migrations.at(-1)!.version);
      expect(
        (getDatabase().query("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
          count: number;
        }).count,
      ).toBe(migrations.length);
      expect(tableNames()).toEqual([...getFreshSchemaTableNames()].sort());
      expect(() => assertSchemaInventory(getDatabase())).not.toThrow();
      expect(tableNames()).toContain("execution_hosts");
      expect(tableNames()).toContain("mesh_controller_relays");
      expect(tableNames()).toContain("workspace_execution_targets");
      expect(tableNames()).toContain("workspace_worker_enrollments");
      expect(tableNames()).toContain("chat_transcript_entries");
      expect(tableNames()).toContain("agent_run_transcript_entries");
      expect(columnNames("workspaces")).toContain("execution_host_id");
      expect(columnNames("workspaces")).toContain("provisioning_host_id");
      expect(columnNames("chats")).toContain("execution_host_id");
      expect(columnNames("terminal_sessions")).toContain("execution_host_id");
      expect(columnNames("terminal_sessions")).not.toContain("target_transport");
      expect(columnNames("preview_sessions")).toContain("target_kind");
      expect(columnNames("preview_sessions")).toContain("execution_host_id");
      expect(columnNames("tasks")).toContain("issue_number");
      expect(columnNames("agents")).toContain("generation_chat_id");
      expect(columnNames("chat_transcript_entries")).toContain("message_role");
      expect(columnNames("task_transcript_entries")).toContain("message_role");
      expect(columnNames("mesh_enrollment_tokens")).toEqual(
        expect.arrayContaining(["relay_url", "relay_fingerprint"]),
      );
      expect(indexNames("preview_sessions")).toContain(
        "idx_preview_sessions_execution_host_status",
      );
      expect(indexNames("chat_transcript_entries")).toContain(
        "idx_chat_transcript_entries_assistant_page",
      );
      expect(getDatabase().query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });

  test("repairs legacy consolidated schema gaps before dependent indexes are created", () => {
    const database = createLegacyConsolidatedDatabase();
    try {
      expect(() => createBaseSchema(database)).not.toThrow();
      expect(runMigrations(database)).toBe(3);

      expect(getSchemaVersion(database)).toBe(migrations.at(-1)!.version);
      expect(getTableColumns(database, "execution_hosts")).toEqual(
        expect.arrayContaining([
          "platform_os",
          "platform_architecture",
          "capabilities_json",
        ]),
      );
      expect(
        database
          .query(
            "SELECT platform_os, platform_architecture, capabilities_json FROM execution_hosts WHERE id = ?",
          )
          .get("host-1"),
      ).toEqual({
        platform_os: "linux",
        platform_architecture: "x64",
        capabilities_json: "{}",
      });
      expect(getTableColumns(database, "chat_transcript_entries")).toContain(
        "message_role",
      );
      expect(
        database
          .query(
            "SELECT message_role FROM chat_transcript_entries WHERE entry_id = ?",
          )
          .get("entry-1"),
      ).toEqual({ message_role: "assistant" });
      expect(getTableColumns(database, "preview_sessions")).toEqual(
        expect.arrayContaining([
          "target_kind",
          "execution_host_id",
          "execution_host_revision",
        ]),
      );
      expect(
        database
          .query(
            "SELECT target_kind, execution_host_id, execution_host_revision FROM preview_sessions WHERE id = ?",
          )
          .get("preview-valid"),
      ).toEqual({
        target_kind: "workspace",
        execution_host_id: "host-1",
        execution_host_revision: 1,
      });
      expect(
        database
          .query("SELECT id FROM preview_sessions ORDER BY id")
          .all(),
      ).toEqual([{ id: "preview-valid" }]);
      expect(
        database
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?, ?)",
          )
          .all(
            "idx_chat_transcript_entries_assistant_page",
            "idx_agent_run_transcript_entries_assistant_page",
            "idx_task_transcript_entries_assistant_page",
            "idx_preview_sessions_execution_host_status",
          ),
      ).toHaveLength(4);

      expect(runMigrations(database)).toBe(0);
    } finally {
      database.close();
    }
  });

  test("allows introspection only for inventory-approved table names", async () => {
    await withTempDataDir(async () => {
      await initializeDatabase();

      for (const tableName of getIntrospectableTableNames()) {
        expect(getTableColumns(getDatabase(), tableName)).toBeInstanceOf(Array);
      }
      expect(() =>
        getTableColumns(getDatabase(), "unknown_table; DROP TABLE tasks"),
      ).toThrow('Unknown table name: "unknown_table; DROP TABLE tasks"');
    });
  });

  test("reopens an existing production-baseline database without rewriting data", async () => {
    await withTempDataDir(async () => {
      await initializeDatabase();
      getDatabase().run(
        `INSERT INTO webapp_users (
          id, username, role, auth_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        ["demo-user", "demo-user", "owner", 1, "now", "now"],
      );
      closeDatabase();

      await initializeDatabase();

      expect(
        (getDatabase().query("SELECT username FROM webapp_users").get() as {
          username: string;
        }).username,
      ).toBe("demo-user");
      expect(getSchemaVersion(getDatabase())).toBe(migrations.at(-1)!.version);
      expect(runMigrations(getDatabase())).toBe(0);
    });
  });

  test("rejects a database below the consolidated baseline", async () => {
    await withTempDataDir(async (dataDir) => {
      createVersionedMigrationDatabase(dataDir, 55);

      await expect(initializeDatabase()).rejects.toThrow(
        "below the consolidated baseline",
      );
    });
  });

  test("removes obsolete Mesh and SSH tables during initialization", async () => {
    await withTempDataDir(async (dataDir) => {
      createVersionedMigrationDatabase(dataDir, BASELINE_SCHEMA_VERSION + 1);
      const database = new Database(join(dataDir, "clanky.db"));
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
        database.run(`CREATE TABLE ${tableName} (id TEXT PRIMARY KEY)`);
      }
      database.close();

      await initializeDatabase();

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
        expect(tableNames()).not.toContain(tableName);
      }
    });
  });

  test("removes Mesh records without encryption keys during migration", async () => {
    await withTempDataDir(async (dataDir) => {
      const database = new Database(join(dataDir, "clanky.db"));
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE mesh_controller_grants (
          controller_node_id TEXT NOT NULL,
          controller_encryption_public_key TEXT
        );
        CREATE TABLE mesh_worker_registrations (
          worker_node_id TEXT NOT NULL,
          worker_encryption_public_key TEXT
        );
        CREATE TABLE mesh_node_identity (
          singleton INTEGER PRIMARY KEY,
          encryption_public_key TEXT
        );
      `);
      for (let version = 1; version <= BASELINE_SCHEMA_VERSION + 2; version++) {
        database.run(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          [version, `migration_${String(version)}`, "now"],
        );
      }
      database.run(
        "INSERT INTO mesh_controller_grants VALUES (?, ?), (?, ?), (?, ?)",
        ["valid-controller", "controller-key", "null-controller", null, "empty-controller", "  "],
      );
      database.run(
        "INSERT INTO mesh_worker_registrations VALUES (?, ?), (?, ?), (?, ?)",
        ["valid-worker", "worker-key", "null-worker", null, "empty-worker", "  "],
      );
      database.run(
        "INSERT INTO mesh_node_identity VALUES (?, ?)",
        [1, null],
      );

      expect(runMigrations(database)).toBe(5);
      expect(
        database
          .query("SELECT controller_node_id FROM mesh_controller_grants")
          .all(),
      ).toEqual([{ controller_node_id: "valid-controller" }]);
      expect(
        database
          .query("SELECT worker_node_id FROM mesh_worker_registrations")
          .all(),
      ).toEqual([{ worker_node_id: "valid-worker" }]);
      expect(database.query("SELECT * FROM mesh_node_identity").all()).toEqual([]);
      database.close();
    });
  });

  test("normalizes Mesh protocol metadata to v5 and is idempotent", async () => {
    await withTempDataDir(async (dataDir) => {
      const database = new Database(join(dataDir, "clanky.db"));
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE mesh_node_identity (
          singleton INTEGER PRIMARY KEY
        );
        CREATE TABLE mesh_worker_registrations (
          worker_node_id TEXT PRIMARY KEY
        );
        CREATE TABLE mesh_controller_grants (
          controller_node_id TEXT PRIMARY KEY
        );
        CREATE TABLE mesh_controller_relay_pairing (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          relay_url TEXT NOT NULL,
          relay_public_key TEXT NOT NULL,
          relay_fingerprint TEXT NOT NULL,
          controller_node_id TEXT NOT NULL,
          controller_fingerprint TEXT NOT NULL,
          paired_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      for (let version = 1; version <= BASELINE_SCHEMA_VERSION + 3; version++) {
        database.run(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          [version, `migration_${String(version)}`, "now"],
        );
      }
      database.run("INSERT INTO mesh_node_identity VALUES (?)", [1]);
      database.run("INSERT INTO mesh_worker_registrations VALUES (?)", ["worker-1"]);
      database.run("INSERT INTO mesh_controller_grants VALUES (?)", ["controller-1"]);
      database.run(
        "INSERT INTO mesh_controller_relay_pairing VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          1, "https://relay-v4.example", "relay-key", "relay-fingerprint",
          "controller-node", "controller-fingerprint", "paired-time", "updated-time",
        ],
      );

      expect(runMigrations(database)).toBe(4);
      expect(getTableColumns(database, "mesh_worker_registrations")).toEqual(
        expect.arrayContaining([
          "worker_binary_version",
          "worker_supported_protocol_versions_json",
          "worker_preferred_protocol_version",
          "worker_negotiated_protocol_version",
          "worker_protocol_updated_at",
        ]),
      );
      expect(getTableColumns(database, "mesh_controller_grants")).toEqual(
        expect.arrayContaining([
          "controller_binary_version",
          "controller_supported_protocol_versions_json",
          "controller_preferred_protocol_version",
          "controller_negotiated_protocol_version",
          "controller_protocol_updated_at",
        ]),
      );
      expect(getTableColumns(database, "mesh_controller_relays")).toEqual(
        expect.arrayContaining([
          "relay_binary_version",
          "relay_supported_protocol_versions_json",
          "relay_preferred_protocol_version",
          "relay_negotiated_protocol_version",
          "relay_protocol_updated_at",
        ]),
      );
      expect(
        database.query(
          "SELECT worker_node_id, worker_supported_protocol_versions_json, worker_preferred_protocol_version, worker_negotiated_protocol_version FROM mesh_worker_registrations",
        ).all(),
      ).toEqual([{
        worker_node_id: "worker-1",
        worker_supported_protocol_versions_json: "[5]",
        worker_preferred_protocol_version: 5,
        worker_negotiated_protocol_version: 5,
      }]);
      expect(
        database.query(
          "SELECT controller_node_id, controller_supported_protocol_versions_json, controller_preferred_protocol_version, controller_negotiated_protocol_version FROM mesh_controller_grants",
        ).all(),
      ).toEqual([{
        controller_node_id: "controller-1",
        controller_supported_protocol_versions_json: "[5]",
        controller_preferred_protocol_version: 5,
        controller_negotiated_protocol_version: 5,
      }]);
      expect(database.query(
        "SELECT current_version, migrated_from_version FROM mesh_protocol_state WHERE singleton = 1",
      ).all()).toEqual([{
        current_version: 5,
        migrated_from_version: 1,
      }]);
      expect(database.query(
        "SELECT relay_supported_protocol_versions_json, relay_preferred_protocol_version, relay_negotiated_protocol_version FROM mesh_controller_relays",
      ).all()).toEqual([{
        relay_supported_protocol_versions_json: "[5]",
        relay_preferred_protocol_version: 5,
        relay_negotiated_protocol_version: 5,
      }]);
      expect(database.query(
        "SELECT worker_node_id FROM mesh_worker_registrations",
      ).all()).toEqual([{ worker_node_id: "worker-1" }]);
      expect(database.query(
        "SELECT controller_node_id FROM mesh_controller_grants",
      ).all()).toEqual([{ controller_node_id: "controller-1" }]);
      expect(database.query(
        "SELECT name, is_primary, relay_url, paired_at, updated_at FROM mesh_controller_relays",
      ).all()).toEqual([{
        name: "default",
        is_primary: 1,
        relay_url: "https://relay-v4.example",
        paired_at: "paired-time",
        updated_at: "updated-time",
      }]);

      expect(runMigrations(database)).toBe(0);
      expect(database.query(
        "SELECT current_version, migrated_from_version FROM mesh_protocol_state WHERE singleton = 1",
      ).all()).toEqual([{
        current_version: 5,
        migrated_from_version: 1,
      }]);
      database.close();
    });
  });

  test("normalizes deployed v1 Mesh metadata during the v5-only upgrade", async () => {
    await withTempDataDir(async (dataDir) => {
      const database = new Database(join(dataDir, "clanky.db"));
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE mesh_node_identity (
          singleton INTEGER PRIMARY KEY
        );
        CREATE TABLE mesh_worker_registrations (
          worker_node_id TEXT PRIMARY KEY,
          worker_binary_version TEXT,
          worker_supported_protocol_versions_json TEXT NOT NULL DEFAULT '[1]',
          worker_preferred_protocol_version INTEGER NOT NULL DEFAULT 1,
          worker_negotiated_protocol_version INTEGER NOT NULL DEFAULT 1,
          worker_protocol_updated_at TEXT
        );
        CREATE TABLE mesh_controller_grants (
          controller_node_id TEXT PRIMARY KEY,
          controller_binary_version TEXT,
          controller_supported_protocol_versions_json TEXT NOT NULL DEFAULT '[1]',
          controller_preferred_protocol_version INTEGER NOT NULL DEFAULT 1,
          controller_negotiated_protocol_version INTEGER NOT NULL DEFAULT 1,
          controller_protocol_updated_at TEXT
        );
        CREATE TABLE mesh_controller_relay_pairing (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          relay_url TEXT NOT NULL,
          relay_public_key TEXT NOT NULL,
          relay_fingerprint TEXT NOT NULL,
          controller_node_id TEXT NOT NULL,
          controller_fingerprint TEXT NOT NULL,
          paired_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          relay_binary_version TEXT,
          relay_supported_protocol_versions_json TEXT NOT NULL DEFAULT '[1]',
          relay_preferred_protocol_version INTEGER NOT NULL DEFAULT 1,
          relay_negotiated_protocol_version INTEGER NOT NULL DEFAULT 1,
          relay_protocol_updated_at TEXT
        );
        CREATE TABLE mesh_protocol_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          current_version INTEGER NOT NULL,
          migrated_from_version INTEGER,
          migrated_at TEXT,
          updated_at TEXT NOT NULL
        );
      `);
      for (let version = 1; version <= BASELINE_SCHEMA_VERSION + 5; version++) {
        database.run(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          [version, `migration_${String(version)}`, "now"],
        );
      }
      database.run("INSERT INTO mesh_node_identity VALUES (?)", [1]);
      database.run(
        "INSERT INTO mesh_worker_registrations VALUES (?, ?, ?, ?, ?, ?)",
        ["worker-1", "5.0.5", "[1]", 1, 1, "old-worker-time"],
      );
      database.run(
        "INSERT INTO mesh_controller_grants VALUES (?, ?, ?, ?, ?, ?)",
        ["controller-1", "5.0.5", "[1]", 1, 1, "old-controller-time"],
      );
      database.run(
        "INSERT INTO mesh_controller_relay_pairing VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          1, "https://relay-v1.example", "relay-key", "relay-fingerprint",
          "controller-node", "controller-fingerprint", "paired-time", "updated-time",
          "5.0.5", "[1]", 1, 1, "old-relay-time",
        ],
      );
      database.run(
        "INSERT INTO mesh_protocol_state VALUES (?, ?, ?, ?, ?)",
        [1, 1, 1, "old-migration-time", "old-update-time"],
      );

      expect(runMigrations(database)).toBe(2);
      expect(database.query(
        "SELECT worker_supported_protocol_versions_json, worker_preferred_protocol_version, worker_negotiated_protocol_version, worker_protocol_updated_at FROM mesh_worker_registrations",
      ).all()).toEqual([{
        worker_supported_protocol_versions_json: "[5]",
        worker_preferred_protocol_version: 5,
        worker_negotiated_protocol_version: 5,
        worker_protocol_updated_at: "old-worker-time",
      }]);
      expect(database.query(
        "SELECT controller_supported_protocol_versions_json, controller_preferred_protocol_version, controller_negotiated_protocol_version, controller_protocol_updated_at FROM mesh_controller_grants",
      ).all()).toEqual([{
        controller_supported_protocol_versions_json: "[5]",
        controller_preferred_protocol_version: 5,
        controller_negotiated_protocol_version: 5,
        controller_protocol_updated_at: "old-controller-time",
      }]);
      expect(database.query(
        "SELECT name, is_primary, relay_binary_version, relay_supported_protocol_versions_json, relay_preferred_protocol_version, relay_negotiated_protocol_version, relay_protocol_updated_at FROM mesh_controller_relays",
      ).all()).toEqual([{
        name: "default",
        is_primary: 1,
        relay_binary_version: "5.0.5",
        relay_supported_protocol_versions_json: "[5]",
        relay_preferred_protocol_version: 5,
        relay_negotiated_protocol_version: 5,
        relay_protocol_updated_at: "old-relay-time",
      }]);
      expect(database.query(
        "SELECT current_version, migrated_from_version, migrated_at, updated_at FROM mesh_protocol_state",
      ).all()).toEqual([{
        current_version: 5,
        migrated_from_version: 1,
        migrated_at: "old-migration-time",
        updated_at: expect.any(String),
      }]);

      expect(runMigrations(database)).toBe(0);
      database.close();
    });
  });

  test("upgrades a prior controller relay pairing and preserves unbound enrollment tokens", () => {
    const database = new Database(":memory:");
    try {
      database.run("PRAGMA foreign_keys = ON");
      createBaseSchema(database);
      for (const migration of migrations) {
        if (migration.version > BASELINE_SCHEMA_VERSION + 6) {
          break;
        }
        migration.up(database);
        database.run(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          [migration.version, migration.name, "old-migration-time"],
        );
      }
      database.run(`
        INSERT INTO mesh_controller_relay_pairing (
          singleton, relay_url, relay_public_key, relay_fingerprint,
          controller_node_id, controller_fingerprint, paired_at, updated_at,
          relay_binary_version, relay_supported_protocol_versions_json,
          relay_preferred_protocol_version, relay_negotiated_protocol_version,
          relay_protocol_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        1, "https://original-relay.example", "relay-public-key", "relay-fingerprint",
        "controller-node", "controller-fingerprint", "paired-time", "updated-time",
        "5.0.5", "[5]", 5, 5, "protocol-time",
      ]);
      database.run(`
        INSERT INTO mesh_enrollment_tokens (
          id, user_id, token_hash, name, controller_node_id,
          controller_fingerprint, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        "token-1", "user-1", "token-hash", "existing token",
        "controller-node", "controller-fingerprint", "created-time", "expires-time",
      ]);

      expect(runMigrations(database)).toBe(1);
      expect(getSchemaVersion(database)).toBe(migrations.at(-1)!.version);
      const migratedPairing = {
        name: "default",
        is_primary: 1,
        relay_url: "https://original-relay.example",
        relay_public_key: "relay-public-key",
        relay_fingerprint: "relay-fingerprint",
        controller_node_id: "controller-node",
        controller_fingerprint: "controller-fingerprint",
        paired_at: "paired-time",
        updated_at: "updated-time",
        relay_binary_version: "5.0.5",
        relay_supported_protocol_versions_json: "[5]",
        relay_preferred_protocol_version: 5,
        relay_negotiated_protocol_version: 5,
        relay_protocol_updated_at: "protocol-time",
      };
      expect(database.query("SELECT * FROM mesh_controller_relays").all()).toEqual([
        migratedPairing,
      ]);
      expect(database.query(
        "SELECT id, token_hash, relay_url, relay_fingerprint FROM mesh_enrollment_tokens",
      ).all()).toEqual([{
        id: "token-1",
        token_hash: "token-hash",
        relay_url: null,
        relay_fingerprint: null,
      }]);
      expect(database.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mesh_controller_relay_pairing'",
      ).get()).toBeNull();
      expect(() => assertSchemaInventory(database)).not.toThrow();

      createBaseSchema(database);
      database.run(`
        INSERT INTO mesh_controller_relay_pairing (
          singleton, relay_url, relay_public_key, relay_fingerprint,
          controller_node_id, controller_fingerprint, paired_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        1, "https://stale-relay.example", "stale-relay-key", "stale-fingerprint",
        "controller-node", "controller-fingerprint", "paired-time", "updated-time",
      ]);
      expect(() => runMigrations(database)).toThrow();
      expect(database.query(
        "SELECT relay_url FROM mesh_controller_relay_pairing",
      ).all()).toEqual([{ relay_url: "https://stale-relay.example" }]);
      expect(database.query("SELECT * FROM mesh_controller_relays").all()).toEqual([
        migratedPairing,
      ]);
      database.run("DELETE FROM mesh_controller_relay_pairing");
      expect(runMigrations(database)).toBe(0);
      expect(database.query("SELECT * FROM mesh_controller_relays").all()).toEqual([
        migratedPairing,
      ]);
      expect(database.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mesh_controller_relay_pairing'",
      ).get()).toBeNull();
      expect(() => assertSchemaInventory(database)).not.toThrow();
    } finally {
      database.close();
    }
  });

  test("enforces relay identity and primary uniqueness while allowing no primary", () => {
    const database = new Database(":memory:");
    try {
      createBaseSchema(database);
      runMigrations(database);
      const insertRelay = (
        name: string,
        relayUrl: string,
        relayFingerprint: string,
        isPrimary = 0,
      ): void => {
        database.run(`
          INSERT INTO mesh_controller_relays (
            name, is_primary, relay_url, relay_public_key, relay_fingerprint,
            controller_node_id, controller_fingerprint, paired_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          name, isPrimary, relayUrl, "relay-public-key", relayFingerprint,
          "controller-node", "controller-fingerprint", "paired-time", "updated-time",
        ]);
      };

      insertRelay("Primary", "https://primary.example", "primary-fingerprint", 1);
      insertRelay("Backup", "https://backup.example", "backup-fingerprint");
      expect(() => insertRelay(
        "PRIMARY", "https://another.example", "another-fingerprint",
      )).toThrow();
      expect(() => insertRelay(
        "Another", "https://backup.example", "another-fingerprint",
      )).toThrow();
      expect(() => insertRelay(
        "Another", "https://another.example", "backup-fingerprint",
      )).toThrow();
      expect(() => insertRelay(
        "Another", "https://another.example", "another-fingerprint", 1,
      )).toThrow();

      database.run("DELETE FROM mesh_controller_relays WHERE name = ?", ["Primary"]);
      expect(database.query(
        "SELECT name FROM mesh_controller_relays WHERE is_primary = 1",
      ).all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("applies a future migration once and keeps it idempotent", async () => {
    await withTempDataDir(async () => {
      await initializeDatabase();
      const futureMigration = {
        version: migrations.at(-1)!.version + 1,
        name: "test_future_schema_change",
        up: (db: Database) => {
          db.run(
            "CREATE TABLE future_schema_test (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
          );
        },
      };
      migrations.push(futureMigration);

      try {
        expect(runMigrations(getDatabase())).toBe(1);
        expect(runMigrations(getDatabase())).toBe(0);
        expect(getSchemaVersion(getDatabase())).toBe(futureMigration.version);
        expect(tableNames()).toContain("future_schema_test");
      } finally {
        migrations.pop();
      }
    });
  });

  test("rejects tables that are not classified by the inventory", async () => {
    await withTempDataDir(async () => {
      await initializeDatabase();
      getDatabase().run(
        "CREATE TABLE unclassified_schema_table (id TEXT PRIMARY KEY)",
      );

      expect(() => assertSchemaInventory(getDatabase())).toThrow(
        "unexpected tables: unclassified_schema_table",
      );
    });
  });

  test("reset recreates the inventory baseline and clears current data", async () => {
    await withTempDataDir(async () => {
      await initializeDatabase();
      getDatabase().run(
        `INSERT INTO webapp_users (
          id, username, role, auth_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        ["reset-user", "reset-user", "owner", 1, "now", "now"],
      );
      getDatabase().run(`
        INSERT INTO mesh_controller_relays (
          name, is_primary, relay_url, relay_public_key, relay_fingerprint,
          controller_node_id, controller_fingerprint, paired_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        "primary", 1, "https://current.example", "relay-key", "current-fingerprint",
        "controller-node", "controller-fingerprint", "paired-time", "updated-time",
      ]);
      createBaseSchema(getDatabase());
      getDatabase().run(`
        INSERT INTO mesh_controller_relay_pairing (
          singleton, relay_url, relay_public_key, relay_fingerprint,
          controller_node_id, controller_fingerprint, paired_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        1, "https://legacy.example", "legacy-key", "legacy-fingerprint",
        "controller-node", "controller-fingerprint", "paired-time", "updated-time",
      ]);
      const freshTableNames = new Set(getFreshSchemaTableNames());
      for (const tableName of getResettableTableNames()) {
        if (freshTableNames.has(tableName)) {
          continue;
        }
        getDatabase().run(
          `CREATE TABLE IF NOT EXISTS "${tableName}" (id TEXT PRIMARY KEY)`,
        );
      }

      resetDatabase();

      expect(
        (getDatabase().query("SELECT COUNT(*) AS count FROM webapp_users").get() as {
          count: number;
        }).count,
      ).toBe(0);
      expect(getDatabase().query("SELECT name FROM mesh_controller_relays").all()).toEqual([]);
      expect(getSchemaVersion(getDatabase())).toBe(migrations.at(-1)!.version);
      expect(tableNames()).toEqual([...getFreshSchemaTableNames()].sort());
      expect(columnNames("mesh_enrollment_tokens")).toEqual(
        expect.arrayContaining(["relay_url", "relay_fingerprint"]),
      );
      expect(() => assertSchemaInventory(getDatabase())).not.toThrow();
      expect(getDatabase().query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
});
