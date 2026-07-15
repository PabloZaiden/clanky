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

function workspaceColumnInfo(db: Database): Array<{
  name: string;
  notnull: number;
  dflt_value: string | null;
}> {
  return db.query("PRAGMA table_info(workspaces)").all() as Array<{
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

      expect(tableNames()).toContain("preview_sessions");
      for (const tableName of PRIVATE_FLAG_TABLE_NAMES) {
        expect(columnNames(tableName)).toContain("is_private");
      }
      expect(columnNames("workspaces")).toContain("archived");
      expect(columnNames("chats")).toContain("queued_messages");
      expect(columnNames("tasks")).toContain("issue_number");

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

  test("migration v7 adds queued chat messages idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 7);
    if (!migration) {
      throw new Error("Migration v7 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE chats (id TEXT PRIMARY KEY)");

      migration.up(db);
      migration.up(db);

      const columns = db.query("PRAGMA table_info(chats)").all() as Array<{
        name: string;
        type: string;
      }>;
      const queuedMessagesColumn = columns.find((column) => column.name === "queued_messages");
      expect(queuedMessagesColumn?.type).toBe("TEXT");
    } finally {
      db.close();
    }
  });

  test("migration v8 adds archived workspace flag idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 8);
    if (!migration) {
      throw new Error("Migration v8 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");

      migration.up(db);
      migration.up(db);

      const columns = workspaceColumnInfo(db);
      const archivedColumn = columns.find((column) => column.name === "archived");
      expect(archivedColumn?.notnull).toBe(1);
      expect(archivedColumn?.dflt_value).toBe("0");
    } finally {
      db.close();
    }
  });

  test("migration v9 adds task issue numbers idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 9);
    if (!migration) {
      throw new Error("Migration v9 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");

      migration.up(db);
      migration.up(db);

      const columns = db.query("PRAGMA table_info(tasks)").all() as Array<{
        name: string;
        type: string;
      }>;
      const issueNumberColumn = columns.find((column) => column.name === "issue_number");
      expect(issueNumberColumn?.type).toBe("INTEGER");
    } finally {
      db.close();
    }
  });

  test("migration v10 converts legacy settings and task modes idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 10);
    if (!migration) {
      throw new Error("Migration v10 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.run(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          server_settings TEXT
        )
      `);
      db.run("INSERT INTO workspaces (id, server_settings) VALUES (?, ?)", [
        "legacy-ssh",
        JSON.stringify({ mode: "connect", hostname: "agent.example", port: 2222, password: "secret" }),
      ]);
      db.run("INSERT INTO workspaces (id, server_settings) VALUES (?, ?)", [
        "legacy-agent",
        JSON.stringify({
          agent: { provider: "copilot", transport: "ssh" },
          execution: { host: "runner.example", port: 2200, user: "runner" },
        }),
      ]);
      db.run("INSERT INTO workspaces (id, server_settings) VALUES (?, ?)", [
        "current",
        JSON.stringify({ agent: { provider: "codex", transport: "stdio" } }),
      ]);
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, mode TEXT)");
      db.run("INSERT INTO tasks (id, mode) VALUES (?, ?)", ["legacy-task", "agent"]);
      db.run("INSERT INTO tasks (id, mode) VALUES (?, ?)", ["current-task", "task"]);

      migration.up(db);
      migration.up(db);

      const legacySsh = db.query("SELECT server_settings FROM workspaces WHERE id = ?").get("legacy-ssh") as {
        server_settings: string;
      };
      expect(JSON.parse(legacySsh.server_settings)).toEqual({
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "agent.example",
          port: 2222,
          password: "secret",
        },
      });

      const legacyAgent = db.query("SELECT server_settings FROM workspaces WHERE id = ?").get("legacy-agent") as {
        server_settings: string;
      };
      expect(JSON.parse(legacyAgent.server_settings)).toEqual({
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "runner.example",
          port: 2200,
          username: "runner",
        },
      });

      const current = db.query("SELECT server_settings FROM workspaces WHERE id = ?").get("current") as {
        server_settings: string;
      };
      expect(JSON.parse(current.server_settings)).toEqual({
        agent: { provider: "codex", transport: "stdio" },
      });

      const taskModes = db.query("SELECT id, mode FROM tasks ORDER BY id").all() as Array<{
        id: string;
        mode: string;
      }>;
      expect(taskModes).toEqual([
        { id: "current-task", mode: "task" },
        { id: "legacy-task", mode: "task" },
      ]);
    } finally {
      db.close();
    }
  });

  test("migration v10 adds a missing task mode column", () => {
    const migration = migrations.find((candidate) => candidate.version === 10);
    if (!migration) {
      throw new Error("Migration v10 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
      db.run("INSERT INTO tasks (id) VALUES (?)", ["missing-mode"]);

      migration.up(db);
      migration.up(db);

      const task = db.query("SELECT mode FROM tasks WHERE id = ?").get("missing-mode") as { mode: string };
      expect(task.mode).toBe("task");
      const columns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "mode")).toBe(true);
    } finally {
      db.close();
    }
  });
});
