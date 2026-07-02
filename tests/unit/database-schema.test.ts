import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { getSchemaVersion, migrations } from "../../src/persistence/migrations";

const PRIVATE_FLAG_TABLE_NAMES = [
  "workspaces",
  "tasks",
  "chats",
  "agents",
  "ssh_servers",
  "ssh_sessions",
  "ssh_server_sessions",
] as const;

type PrivateFlagTableName = typeof PRIVATE_FLAG_TABLE_NAMES[number];

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
  ).map((row) => row.name);
}

function assertPrivateFlagTableName(tableName: string): asserts tableName is PrivateFlagTableName {
  if (!(PRIVATE_FLAG_TABLE_NAMES as readonly string[]).includes(tableName)) {
    throw new Error(`Unexpected schema table name: ${tableName}`);
  }
}

function columnNames(tableName: PrivateFlagTableName): string[] {
  assertPrivateFlagTableName(tableName);
  return (
    getDatabase()
      .query(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function privateFlagColumnInfo(db: Database, tableName: PrivateFlagTableName): Array<{
  name: string;
  notnull: number;
  dflt_value: string | null;
}> {
  assertPrivateFlagTableName(tableName);
  return db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
}

describe("database schema", () => {
  afterEach(() => {
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
  });

  test("creates a clean post-migration baseline schema", async () => {
    await withTempDataDir(async () => {
      await initializeDatabase();

      expect(tableNames()).not.toContain("passkey_credentials");
      expect(tableNames()).not.toContain("auth_device_requests");
      expect(tableNames()).not.toContain("auth_refresh_sessions");
      expect(tableNames()).not.toContain("forwarded_ports");
      expect(tableNames()).toContain("preview_sessions");
      for (const tableName of PRIVATE_FLAG_TABLE_NAMES) {
        expect(columnNames(tableName)).toContain("is_private");
      }

      const users = getDatabase()
        .query("SELECT COUNT(*) AS count FROM webapp_users")
        .get() as { count: number };
      expect(users.count).toBe(0);
      expect(getSchemaVersion(getDatabase())).toBe(migrations.at(-1)?.version ?? 0);
    });
  });

  test("migration v5 creates preview sessions with the baseline status default", () => {
    const migration = migrations.find((candidate) => candidate.version === 5);
    if (!migration) {
      throw new Error("Migration v5 was not found");
    }
    const db = new Database(":memory:");
    try {
      migration.up(db);
      const columns = db.query("PRAGMA table_info(preview_sessions)").all() as Array<{
        name: string;
        dflt_value: string | null;
      }>;
      const statusColumn = columns.find((column) => column.name === "status");
      expect(statusColumn?.dflt_value).toBe("'active'");
    } finally {
      db.close();
    }
  });

  test("migration v6 adds private flags idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 6);
    if (!migration) {
      throw new Error("Migration v6 was not found");
    }
    const db = new Database(":memory:");
    try {
      for (const tableName of PRIVATE_FLAG_TABLE_NAMES) {
        db.run(`CREATE TABLE ${tableName} (id TEXT PRIMARY KEY)`);
      }

      migration.up(db);
      migration.up(db);

      for (const tableName of PRIVATE_FLAG_TABLE_NAMES) {
        const columns = privateFlagColumnInfo(db, tableName);
        const privateColumn = columns.find((column) => column.name === "is_private");
        expect(privateColumn?.notnull).toBe(1);
        expect(privateColumn?.dflt_value).toBe("0");
      }
    } finally {
      db.close();
    }
  });
});
