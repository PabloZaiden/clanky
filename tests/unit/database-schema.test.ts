import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";

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

describe("database schema", () => {
  afterEach(() => {
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
  });

  test("does not create legacy auth tables for new databases", async () => {
    await withTempDataDir(async () => {
      await initializeDatabase();

      expect(tableNames()).not.toContain("passkey_credentials");
      expect(tableNames()).not.toContain("auth_device_requests");
      expect(tableNames()).not.toContain("auth_refresh_sessions");
    });
  });

  test("migrates legacy auth data into framework tables and drops legacy tables", async () => {
    await withTempDataDir(async (dataDir) => {
      await mkdir(dataDir, { recursive: true });
      const oldDb = new Database(join(dataDir, "clanky.db"));
      const now = new Date().toISOString();
      oldDb.run(`
        CREATE TABLE passkey_credentials (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          credential_id TEXT NOT NULL,
          public_key BLOB NOT NULL,
          counter INTEGER NOT NULL,
          device_type TEXT NOT NULL,
          backed_up INTEGER NOT NULL DEFAULT 0,
          transports TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_used_at TEXT
        )
      `);
      oldDb
        .query(`
          INSERT INTO passkey_credentials (
            id, name, credential_id, public_key, counter, device_type,
            backed_up, transports, created_at, updated_at, last_used_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `)
        .run("legacy-passkey", "Legacy passkey", "legacy-credential", new Uint8Array([1, 2, 3]), 0, "singleDevice", 0, "[]", now, now);
      oldDb.close();

      await initializeDatabase();

      expect(tableNames()).not.toContain("passkey_credentials");
      const migrated = getDatabase()
        .query("SELECT id, user_id, credential_id FROM webapp_passkeys")
        .get() as { id: string; user_id: string; credential_id: string } | null;
      expect(migrated).toEqual({
        id: "legacy-passkey",
        user_id: "admin",
        credential_id: "legacy-credential",
      });
    });
  });
});
