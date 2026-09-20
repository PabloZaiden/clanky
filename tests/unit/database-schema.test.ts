import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
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
  WORKER_SCHEMA_BASELINE_VERSION,
} from "../../src/persistence/migrations";
import {
  assertSchemaInventory,
  getFreshSchemaTableNames,
  getIntrospectableTableNames,
  getResettableTableNames,
} from "../../src/persistence/schema-inventory";
import { getTranscriptTableConfig } from "../../src/persistence/transcripts/table-config";

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
  options: { legacyWorkerSchema?: boolean } = {},
): void {
  const legacyDatabase = new Database(join(dataDir, "clanky.db"));
  legacyDatabase.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  legacyDatabase.run(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    [version, `migration_${String(version)}`, "now"],
  );
  if (options.legacyWorkerSchema === true) {
    legacyDatabase.exec(`
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
        error_message TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      INSERT INTO preview_sessions (
        id, user_id, workspace_id, remote_host, remote_port, local_host,
        local_port, local_url, initial_path, created_at, updated_at
      ) VALUES (
        'legacy-preview', 'legacy-user', 'legacy-workspace', '127.0.0.1',
        3000, '127.0.0.1', 4000, 'http://127.0.0.1:4000', '/', 'now', 'now'
      );
      CREATE TABLE chat_transcript_entries (
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'tool', 'log')),
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
        PRIMARY KEY (chat_id, entry_id),
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );
      INSERT INTO chat_transcript_entries (
        chat_id, user_id, entry_id, kind, timestamp, sequence, payload,
        created_at, updated_at
      ) VALUES (
        'legacy-chat', 'legacy-user', 'legacy-entry', 'message', 'now', 1,
        '{"role":"assistant","content":"legacy"}', 'now', 'now'
      );
    `);
  }
  legacyDatabase.close();
}

describe("database schema", () => {
  afterEach(() => {
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
  });

  test("creates the consolidated baseline from the authoritative inventory", async () => {
    await withTempDataDir(async () => {
      await initializeDatabase();

      expect(getSchemaVersion(getDatabase())).toBe(BASELINE_SCHEMA_VERSION);
      expect(
        (getDatabase().query("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
          count: number;
        }).count,
      ).toBe(BASELINE_SCHEMA_VERSION);
      expect(tableNames()).toEqual([...getFreshSchemaTableNames()].sort());
      expect(() => assertSchemaInventory(getDatabase())).not.toThrow();
      expect(tableNames()).toContain("execution_hosts");
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
      expect(indexNames("preview_sessions")).toContain(
        "idx_preview_sessions_execution_host_status",
      );
      expect(indexNames("chat_transcript_entries")).toContain(
        "idx_chat_transcript_entries_assistant_page",
      );
      expect(getDatabase().query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
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

  test("derives transcript table configuration from the canonical inventory", () => {
    expect(getTranscriptTableConfig("chat")).toEqual({
      parentTable: "chats",
      entriesTable: "chat_transcript_entries",
      metaTable: "chat_transcript_meta",
      resourceColumn: "chat_id",
    });
    expect(getTranscriptTableConfig("task")).toEqual({
      parentTable: "tasks",
      entriesTable: "task_transcript_entries",
      metaTable: "task_transcript_meta",
      resourceColumn: "task_id",
    });
    expect(getTranscriptTableConfig("agent_run")).toEqual({
      parentTable: "agent_runs",
      entriesTable: "agent_run_transcript_entries",
      metaTable: "agent_run_transcript_meta",
      resourceColumn: "agent_run_id",
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
      expect(getSchemaVersion(getDatabase())).toBe(BASELINE_SCHEMA_VERSION);
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

  test("allows workers from the worker baseline through the latest historical marker", async () => {
    for (const version of [
      WORKER_SCHEMA_BASELINE_VERSION,
      BASELINE_SCHEMA_VERSION - 1,
    ]) {
      await withTempDataDir(async (dataDir) => {
        createVersionedMigrationDatabase(dataDir, version, {
          legacyWorkerSchema: true,
        });

        await initializeDatabase({ meshWorker: true });

        expect(getSchemaVersion(getDatabase())).toBe(BASELINE_SCHEMA_VERSION);
        expect(runMigrations(getDatabase(), { meshWorker: true })).toBe(0);
        expect(
          (
            getDatabase()
              .query(
                "SELECT local_url FROM preview_sessions WHERE id = ?",
              )
              .get("legacy-preview") as { local_url: string }
          ).local_url,
        ).toBe("http://127.0.0.1:4000");
        expect(
          (
            getDatabase()
              .query(
                "SELECT payload FROM chat_transcript_entries WHERE entry_id = ?",
              )
              .get("legacy-entry") as { payload: string }
          ).payload,
        ).toBe('{"role":"assistant","content":"legacy"}');
        expect(indexNames("preview_sessions")).not.toContain(
          "idx_preview_sessions_execution_host_status",
        );
        expect(indexNames("chat_transcript_entries")).not.toContain(
          "idx_chat_transcript_entries_assistant_page",
        );
      });
    }
  });

  test("rejects workers below the worker schema baseline", async () => {
    await withTempDataDir(async (dataDir) => {
      createVersionedMigrationDatabase(
        dataDir,
        WORKER_SCHEMA_BASELINE_VERSION - 1,
      );

      await expect(
        initializeDatabase({ meshWorker: true }),
      ).rejects.toThrow("below the consolidated baseline");
    });
  });

  test("keeps controllers strict when a baseline marker hides a legacy table", async () => {
    await withTempDataDir(async (dataDir) => {
      createVersionedMigrationDatabase(dataDir, BASELINE_SCHEMA_VERSION, {
        legacyWorkerSchema: true,
      });

      await expect(initializeDatabase()).rejects.toThrow(
        "Cannot create index",
      );
    });
  });

  test("applies a future migration once and keeps it idempotent", async () => {
    await withTempDataDir(async () => {
      await initializeDatabase();
      const futureMigration = {
        version: BASELINE_SCHEMA_VERSION + 1,
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

  test("reset recreates the inventory baseline and clears current and legacy data", async () => {
    await withTempDataDir(async () => {
      await initializeDatabase();
      getDatabase().run(
        `INSERT INTO webapp_users (
          id, username, role, auth_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        ["reset-user", "reset-user", "owner", 1, "now", "now"],
      );
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
      expect(getSchemaVersion(getDatabase())).toBe(BASELINE_SCHEMA_VERSION);
        expect(tableNames()).toEqual([...getFreshSchemaTableNames()].sort());
        expect(() => assertSchemaInventory(getDatabase())).not.toThrow();
      expect(getDatabase().query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
});
