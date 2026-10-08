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
import { MESH_PROTOCOL_VERSION } from "../../src/shared/mesh-protocol";

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

function expectPeerMetadataToRequireRefresh(metadata: {
  supportedVersions: string;
  preferredVersion: number;
  negotiatedVersion: number;
}): void {
  expect(JSON.parse(metadata.supportedVersions)).not.toContain(MESH_PROTOCOL_VERSION);
  expect(metadata.preferredVersion).not.toBe(MESH_PROTOCOL_VERSION);
  expect(metadata.negotiatedVersion).not.toBe(MESH_PROTOCOL_VERSION);
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
      expect(indexNames("chat_transcript_entries")).toContain(
        "idx_chat_transcript_entries_user_message_activity",
      );
      expect(indexNames("task_transcript_entries")).toContain(
        "idx_task_transcript_entries_user_message_activity",
      );
      const userMessageIndexDefinitions = getDatabase()
        .query(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'index'
             AND name IN (?, ?)`,
        )
        .all(
          "idx_chat_transcript_entries_user_message_activity",
          "idx_task_transcript_entries_user_message_activity",
        ) as Array<{ name: string; sql: string }>;
      expect(userMessageIndexDefinitions).toHaveLength(2);
      expect(userMessageIndexDefinitions.every(
        (index) => index.sql.includes("WHERE kind = 'message' AND message_role = 'user'"),
      )).toBe(true);
      const userMessageIndexMigration = migrations.find(
        (migration) => migration.name === "add_user_message_activity_indexes",
      );
      if (!userMessageIndexMigration) {
        throw new Error("User message activity migration is missing");
      }
      expect(() => userMessageIndexMigration.up(getDatabase())).not.toThrow();
      expect(getDatabase().query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });

  test("adds Scratchpad to a version-69 workspace and defaults it to empty", () => {
    const database = new Database(":memory:");
    try {
      database.run("PRAGMA foreign_keys = ON");
      createBaseSchema(database);
      const scratchpadMigration = migrations.find(
        (migration) => migration.name === "add_workspace_scratchpad",
      );
      if (!scratchpadMigration) {
        throw new Error("Workspace Scratchpad migration is missing");
      }
      for (const migration of migrations.filter(
        (candidate) => candidate.version < scratchpadMigration.version,
      )) {
        migration.up(database);
        database.run(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          [migration.version, migration.name, "previously-applied"],
        );
      }
      database.run(
        `INSERT INTO execution_hosts (
          id, user_id, kind, source_id, target_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["host-1", "owner-1", "local", "node-1", "local:node-1", "created", "updated"],
      );
      database.run(
        `INSERT INTO workspaces (
          id, user_id, name, directory, execution_host_id, execution_host_revision,
          server_settings, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "workspace-1",
          "owner-1",
          "Workspace",
          "/synthetic",
          "host-1",
          1,
          '{"agent":{"adapter":"acp","provider":"copilot"}}',
          "created",
          "updated",
        ],
      );

      expect(getSchemaVersion(database)).toBe(scratchpadMigration.version - 1);
      expect(getTableColumns(database, "workspaces")).not.toContain("scratchpad");
      expect(runMigrations(database)).toBe(1);
      expect(
        database.query(
          "SELECT id, user_id, name, directory, scratchpad FROM workspaces WHERE id = ?",
        ).get("workspace-1"),
      ).toEqual({
        id: "workspace-1",
        user_id: "owner-1",
        name: "Workspace",
        directory: "/synthetic",
        scratchpad: "",
      });
      expect(runMigrations(database)).toBe(0);
    } finally {
      database.close();
    }
  });

  // A fresh HTTP server cannot exercise the deployed schema's data-preserving upgrade.
  test("upgrades version 63 conversation storage without losing owned session data", () => {
    const database = new Database(":memory:");
    try {
      database.run("PRAGMA foreign_keys = ON");
      createBaseSchema(database);
      for (const migration of migrations) {
        if (migration.version > 63) break;
        migration.up(database);
        database.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
          migration.version, migration.name, "old-migration-time",
        ]);
      }
      database.run(`INSERT INTO execution_hosts (id, user_id, kind, source_id, target_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, ["host-1", "owner-1", "local", "node-1", "local:node-1", "created", "updated"]);
      database.run(`INSERT INTO workspaces (id, user_id, name, directory, execution_host_id,
        execution_host_revision, server_settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        "workspace-1", "owner-1", "Workspace", "/synthetic", "host-1", 1,
        '{"agent":{"provider":"copilot"}}', "created", "updated",
      ]);
      database.run(`INSERT INTO tasks (id, user_id, name, directory, prompt, created_at, updated_at,
        stop_pattern, git_branch_prefix, session_id, pending_prompt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        "task-1", "owner-1", "Task", "/synthetic", "Original task", "created", "updated", "COMPLETE", "", "acp-task-1", "Preserved follow-up",
      ]);
      database.run(`INSERT INTO chats (id, user_id, name, source_kind, directory, created_at, updated_at,
        execution_host_id, execution_host_revision, session_id, queued_messages)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        "chat-1", "owner-1", "Chat", "execution_host", "/synthetic", "created", "updated",
        "host-1", 1, "acp-chat-1", '[{"id":"input-1","content":"Keep this input","createdAt":"created"}]',
      ]);

      runMigrations(database);
      const migratedSettings = database.query<{ server_settings: string }, [string]>("SELECT server_settings FROM workspaces WHERE id = ?").get("workspace-1")!;
      expect(JSON.parse(migratedSettings.server_settings)).toEqual({ agent: { adapter: "acp", provider: "copilot" } });
      expect(database.query("SELECT user_id, session_id, pending_prompt, session_binding_json, harness_state_json FROM tasks WHERE id = ?").get("task-1")).toEqual({
        user_id: "owner-1", session_id: "acp-task-1", pending_prompt: "Preserved follow-up", session_binding_json: null, harness_state_json: null,
      });
      expect(database.query("SELECT user_id, session_id, queued_messages, session_binding_json, harness_state_json FROM chats WHERE id = ?").get("chat-1")).toEqual({
        user_id: "owner-1", session_id: "acp-chat-1",
        queued_messages: '[{"id":"input-1","content":"Keep this input","createdAt":"created"}]', session_binding_json: null, harness_state_json: null,
      });
      const pendingRow = database.query<{ pending_input_json: string }, [string]>("SELECT pending_input_json FROM tasks WHERE id = ?").get("task-1")!;
      const pending = JSON.parse(pendingRow.pending_input_json) as { id: string; attachments: unknown[] };
      expect(pending.id.length).toBeGreaterThan(0);
      expect(pending.attachments).toEqual([]);
      const input = JSON.stringify({ ...pending, attachments: [{
        id: "attachment-1", filename: "context.txt", mimeType: "text/plain", data: "eA==", size: 1,
      }] });
      const binding = JSON.stringify({ adapter: "acp", nativeId: "acp-task-1", ownerId: "owner-1", contextId: "task-1", directory: "/synthetic" });
      const harness = JSON.stringify({ inputs: [{ conversation: JSON.parse(binding), submittedAt: "submitted", admission: { status: "unknown", inputId: pending.id } }] });
      database.run("UPDATE tasks SET pending_input_json = ? WHERE id = ?", [input, "task-1"]);
      database.run("UPDATE tasks SET harness_state_json = ? WHERE id = ?", [harness, "task-1"]);
      database.run("UPDATE tasks SET session_binding_json = ? WHERE id = ?", [binding, "task-1"]);
      const nativeSettings = JSON.stringify({ agent: { adapter: "copilot", provider: "copilot" } });
      database.run("UPDATE workspaces SET server_settings = ? WHERE id = ?", [nativeSettings, "workspace-1"]);
      migrations.find((migration) => migration.name === "add_owned_harness_conversation_bindings")!.up(database);
      migrations.find((migration) => migration.name === "add_durable_task_pending_input")!.up(database);
      migrations.find((migration) => migration.name === "select_explicit_workspace_harness_adapter")!.up(database);
      runMigrations(database);
      expect(database.query("SELECT session_binding_json, harness_state_json FROM tasks WHERE id = ?").get("task-1")).toEqual({ session_binding_json: binding, harness_state_json: harness });
      expect(database.query("SELECT pending_input_json, pending_prompt FROM tasks WHERE id = ?").get("task-1")).toEqual({
        pending_input_json: input, pending_prompt: "Preserved follow-up",
      });
      expect(database.query("SELECT server_settings FROM workspaces WHERE id = ?").get("workspace-1")).toEqual({ server_settings: nativeSettings });
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { database.close(); }
  });

  test("repairs legacy consolidated schema gaps before dependent indexes are created", () => {
    const database = createLegacyConsolidatedDatabase();
    try {
      expect(() => createBaseSchema(database)).not.toThrow();
      runMigrations(database);

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

      runMigrations(database);
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

  test("upgrades the local Mesh generation without advertising it for legacy peers", async () => {
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

      runMigrations(database);
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
      const workerMetadata = database.query(
        "SELECT worker_node_id, worker_supported_protocol_versions_json, worker_preferred_protocol_version, worker_negotiated_protocol_version FROM mesh_worker_registrations",
      ).get() as {
        worker_node_id: string;
        worker_supported_protocol_versions_json: string;
        worker_preferred_protocol_version: number;
        worker_negotiated_protocol_version: number;
      };
      expect(workerMetadata.worker_node_id).toBe("worker-1");
      expectPeerMetadataToRequireRefresh({
        supportedVersions: workerMetadata.worker_supported_protocol_versions_json,
        preferredVersion: workerMetadata.worker_preferred_protocol_version,
        negotiatedVersion: workerMetadata.worker_negotiated_protocol_version,
      });
      const controllerMetadata = database.query(
        "SELECT controller_node_id, controller_supported_protocol_versions_json, controller_preferred_protocol_version, controller_negotiated_protocol_version FROM mesh_controller_grants",
      ).get() as {
        controller_node_id: string;
        controller_supported_protocol_versions_json: string;
        controller_preferred_protocol_version: number;
        controller_negotiated_protocol_version: number;
      };
      expect(controllerMetadata.controller_node_id).toBe("controller-1");
      expectPeerMetadataToRequireRefresh({
        supportedVersions: controllerMetadata.controller_supported_protocol_versions_json,
        preferredVersion: controllerMetadata.controller_preferred_protocol_version,
        negotiatedVersion: controllerMetadata.controller_negotiated_protocol_version,
      });
      expect(database.query(
        "SELECT current_version, migrated_from_version FROM mesh_protocol_state WHERE singleton = 1",
      ).all()).toEqual([{
        current_version: 6,
        migrated_from_version: 1,
      }]);
      const relayMetadata = database.query(
        "SELECT relay_supported_protocol_versions_json, relay_preferred_protocol_version, relay_negotiated_protocol_version FROM mesh_controller_relays",
      ).get() as {
        relay_supported_protocol_versions_json: string;
        relay_preferred_protocol_version: number;
        relay_negotiated_protocol_version: number;
      };
      expectPeerMetadataToRequireRefresh({
        supportedVersions: relayMetadata.relay_supported_protocol_versions_json,
        preferredVersion: relayMetadata.relay_preferred_protocol_version,
        negotiatedVersion: relayMetadata.relay_negotiated_protocol_version,
      });
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
        current_version: 6,
        migrated_from_version: 1,
      }]);
      database.close();
    });
  });

  // Migration/data-safety exception: an HTTP test cannot prove a schema upgrade preserves persisted peer evidence.
  test("Mesh generation migration preserves unconfirmed peer capabilities", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
        CREATE TABLE mesh_protocol_state (singleton INTEGER PRIMARY KEY, current_version INTEGER NOT NULL, migrated_from_version INTEGER NOT NULL, updated_at TEXT NOT NULL);
        INSERT INTO mesh_protocol_state VALUES (1, 1, 1, 'before-upgrade');
        CREATE TABLE mesh_worker_registrations (
          worker_node_id TEXT PRIMARY KEY, worker_public_key TEXT, worker_fingerprint TEXT,
          grant_status TEXT, worker_supported_protocol_versions_json TEXT,
          worker_preferred_protocol_version INTEGER, worker_negotiated_protocol_version INTEGER,
          worker_protocol_updated_at TEXT
        );
        INSERT INTO mesh_worker_registrations VALUES
          ('unsupported-worker', 'worker-key', 'worker-fingerprint', 'active', '[99]', 99, 99, 'pre-upgrade-observation'),
          ('mixed-worker', 'mixed-key', 'mixed-fingerprint', 'active', '[6,99]', 6, 6, 'known-observation');
        CREATE TABLE mesh_controller_grants (
          controller_node_id TEXT PRIMARY KEY, controller_public_key TEXT,
          controller_fingerprint TEXT, grant_status TEXT,
          controller_supported_protocol_versions_json TEXT,
          controller_preferred_protocol_version INTEGER, controller_negotiated_protocol_version INTEGER,
          controller_protocol_updated_at TEXT
        );
        INSERT INTO mesh_controller_grants VALUES
          ('unsupported-controller', 'controller-key', 'controller-fingerprint', 'active', '[99]', 99, 99, 'pre-upgrade-observation'),
          ('mixed-controller', 'mixed-controller-key', 'mixed-controller-fingerprint', 'active', '[6,99]', 6, 6, 'known-observation');
        CREATE TABLE mesh_controller_relays (
          name TEXT PRIMARY KEY, relay_fingerprint TEXT,
          relay_supported_protocol_versions_json TEXT,
          relay_preferred_protocol_version INTEGER, relay_negotiated_protocol_version INTEGER,
          relay_protocol_updated_at TEXT
        );
        INSERT INTO mesh_controller_relays VALUES
          ('unsupported-relay', 'unsupported-relay-fingerprint', '[99]', 99, 99, 'pre-upgrade-observation'),
          ('mixed-relay', 'mixed-relay-fingerprint', '[6,99]', 6, 6, 'known-observation');
      `);
      for (let version = 1; version <= 67; version++) database.run("INSERT INTO schema_migrations VALUES (?, ?, ?)", [version, `prior-${version}`, "before-upgrade"]);
      expect(runMigrations(database)).toBe(3);
      expect(database.query("SELECT current_version, migrated_from_version FROM mesh_protocol_state").get()).toEqual({ current_version: 6, migrated_from_version: 1 });
      expect(database.query("SELECT * FROM mesh_worker_registrations ORDER BY worker_node_id").all()).toEqual([
        { worker_node_id: "mixed-worker", worker_public_key: "mixed-key", worker_fingerprint: "mixed-fingerprint", grant_status: "active", worker_supported_protocol_versions_json: "[6,99]", worker_preferred_protocol_version: 6, worker_negotiated_protocol_version: 6, worker_protocol_updated_at: "known-observation" },
        { worker_node_id: "unsupported-worker", worker_public_key: "worker-key", worker_fingerprint: "worker-fingerprint", grant_status: "active", worker_supported_protocol_versions_json: "[99]", worker_preferred_protocol_version: 99, worker_negotiated_protocol_version: 99, worker_protocol_updated_at: "pre-upgrade-observation" },
      ]);
      expect(database.query("SELECT controller_node_id, controller_public_key, controller_fingerprint, grant_status, controller_supported_protocol_versions_json, controller_preferred_protocol_version, controller_negotiated_protocol_version, controller_protocol_updated_at FROM mesh_controller_grants ORDER BY controller_node_id").all()).toEqual([
        { controller_node_id: "mixed-controller", controller_public_key: "mixed-controller-key", controller_fingerprint: "mixed-controller-fingerprint", grant_status: "active", controller_supported_protocol_versions_json: "[6,99]", controller_preferred_protocol_version: 6, controller_negotiated_protocol_version: 6, controller_protocol_updated_at: "known-observation" },
        { controller_node_id: "unsupported-controller", controller_public_key: "controller-key", controller_fingerprint: "controller-fingerprint", grant_status: "active", controller_supported_protocol_versions_json: "[99]", controller_preferred_protocol_version: 99, controller_negotiated_protocol_version: 99, controller_protocol_updated_at: "pre-upgrade-observation" },
      ]);
      expect(database.query("SELECT name, relay_fingerprint, relay_supported_protocol_versions_json, relay_preferred_protocol_version, relay_negotiated_protocol_version, relay_protocol_updated_at FROM mesh_controller_relays ORDER BY name").all()).toEqual([
        { name: "mixed-relay", relay_fingerprint: "mixed-relay-fingerprint", relay_supported_protocol_versions_json: "[6,99]", relay_preferred_protocol_version: 6, relay_negotiated_protocol_version: 6, relay_protocol_updated_at: "known-observation" },
        { name: "unsupported-relay", relay_fingerprint: "unsupported-relay-fingerprint", relay_supported_protocol_versions_json: "[99]", relay_preferred_protocol_version: 99, relay_negotiated_protocol_version: 99, relay_protocol_updated_at: "pre-upgrade-observation" },
      ]);
      expect(runMigrations(database)).toBe(0);
      expect(database.query("SELECT current_version FROM mesh_protocol_state").get()).toEqual({ current_version: 6 });
    } finally { database.close(); }
  });

  test("preserves peer trust while migrating historical Mesh metadata", async () => {
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
        ["worker-1", "worker-build-before-upgrade", "[1]", 1, 1, "old-worker-time"],
      );
      database.run(
        "INSERT INTO mesh_controller_grants VALUES (?, ?, ?, ?, ?, ?)",
        ["controller-1", "controller-build-before-upgrade", "[1]", 1, 1, "old-controller-time"],
      );
      database.run(
        "INSERT INTO mesh_controller_relay_pairing VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          1, "https://relay-v1.example", "relay-key", "relay-fingerprint",
          "controller-node", "controller-fingerprint", "paired-time", "updated-time",
          "relay-build-before-upgrade", "[1]", 1, 1, "old-relay-time",
        ],
      );
      database.run(
        "INSERT INTO mesh_protocol_state VALUES (?, ?, ?, ?, ?)",
        [1, 1, 1, "old-migration-time", "old-update-time"],
      );

      runMigrations(database);
      const workerMetadata = database.query(
        "SELECT worker_binary_version, worker_supported_protocol_versions_json, worker_preferred_protocol_version, worker_negotiated_protocol_version, worker_protocol_updated_at FROM mesh_worker_registrations",
      ).get() as {
        worker_binary_version: string;
        worker_supported_protocol_versions_json: string;
        worker_preferred_protocol_version: number;
        worker_negotiated_protocol_version: number;
        worker_protocol_updated_at: string;
      };
      expect(workerMetadata.worker_binary_version).toBe("worker-build-before-upgrade");
      expect(workerMetadata.worker_protocol_updated_at).toBe("old-worker-time");
      expectPeerMetadataToRequireRefresh({
        supportedVersions: workerMetadata.worker_supported_protocol_versions_json,
        preferredVersion: workerMetadata.worker_preferred_protocol_version,
        negotiatedVersion: workerMetadata.worker_negotiated_protocol_version,
      });
      const controllerMetadata = database.query(
        "SELECT controller_binary_version, controller_supported_protocol_versions_json, controller_preferred_protocol_version, controller_negotiated_protocol_version, controller_protocol_updated_at FROM mesh_controller_grants",
      ).get() as {
        controller_binary_version: string;
        controller_supported_protocol_versions_json: string;
        controller_preferred_protocol_version: number;
        controller_negotiated_protocol_version: number;
        controller_protocol_updated_at: string;
      };
      expect(controllerMetadata.controller_binary_version).toBe("controller-build-before-upgrade");
      expect(controllerMetadata.controller_protocol_updated_at).toBe("old-controller-time");
      expectPeerMetadataToRequireRefresh({
        supportedVersions: controllerMetadata.controller_supported_protocol_versions_json,
        preferredVersion: controllerMetadata.controller_preferred_protocol_version,
        negotiatedVersion: controllerMetadata.controller_negotiated_protocol_version,
      });
      const relayMetadata = database.query(
        "SELECT name, is_primary, relay_binary_version, relay_supported_protocol_versions_json, relay_preferred_protocol_version, relay_negotiated_protocol_version, relay_protocol_updated_at FROM mesh_controller_relays",
      ).get() as {
        name: string;
        is_primary: number;
        relay_binary_version: string;
        relay_supported_protocol_versions_json: string;
        relay_preferred_protocol_version: number;
        relay_negotiated_protocol_version: number;
        relay_protocol_updated_at: string;
      };
      expect(relayMetadata).toMatchObject({
        name: "default",
        is_primary: 1,
        relay_binary_version: "relay-build-before-upgrade",
        relay_protocol_updated_at: "old-relay-time",
      });
      expectPeerMetadataToRequireRefresh({
        supportedVersions: relayMetadata.relay_supported_protocol_versions_json,
        preferredVersion: relayMetadata.relay_preferred_protocol_version,
        negotiatedVersion: relayMetadata.relay_negotiated_protocol_version,
      });
      expect(database.query(
        "SELECT current_version, migrated_from_version, migrated_at, updated_at FROM mesh_protocol_state",
      ).all()).toEqual([{
        current_version: 6,
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
        "relay-build", "[99]", 99, 99, "protocol-time",
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

      runMigrations(database);
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
        relay_binary_version: "relay-build",
        relay_supported_protocol_versions_json: "[99]",
        relay_preferred_protocol_version: 99,
        relay_negotiated_protocol_version: 99,
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
