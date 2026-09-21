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

      expect(runMigrations(database)).toBe(1);
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
      expect(getSchemaVersion(getDatabase())).toBe(migrations.at(-1)!.version);
      expect(tableNames()).toEqual([...getFreshSchemaTableNames()].sort());
      expect(() => assertSchemaInventory(getDatabase())).not.toThrow();
      expect(getDatabase().query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });
});
