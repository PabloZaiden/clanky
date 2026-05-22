/**
 * Tests for the database migration infrastructure after the Clanky reset.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  getSchemaVersion,
  getTableColumns,
  migrations,
  runMigrations,
  tableExists,
} from "../../src/persistence/migrations";

function nextMigrationVersion(offset = 1): number {
  const highestExisting = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
  return highestExisting + offset;
}

describe("migration infrastructure", () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clanky-migration-test-"));
    db = new Database(join(tempDir, "test.db"));
    db.run("PRAGMA foreign_keys = ON");
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("reset baseline", () => {
    test("starts with no historical migrations", () => {
      expect(migrations).toHaveLength(0);
      expect(runMigrations(db)).toBe(0);
      expect(getSchemaVersion(db)).toBe(0);
    });
  });

  describe("getSchemaVersion", () => {
    test("returns 0 when no schema_migrations table exists", () => {
      expect(getSchemaVersion(db)).toBe(0);
    });

    test("returns 0 when schema_migrations table exists but is empty", () => {
      db.run(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      expect(getSchemaVersion(db)).toBe(0);
    });

    test("returns the highest version number", () => {
      db.run(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'first', '2025-01-01')");
      db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, 'third', '2025-01-03')");
      db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'second', '2025-01-02')");
      expect(getSchemaVersion(db)).toBe(3);
    });
  });

  describe("runMigrations", () => {
    test("creates schema_migrations table when it does not exist", () => {
      expect(tableExists(db, "schema_migrations")).toBe(false);
      runMigrations(db);
      expect(tableExists(db, "schema_migrations")).toBe(true);
    });

    test("is idempotent with the empty reset migration list", () => {
      runMigrations(db);
      expect(runMigrations(db)).toBe(0);
      expect(runMigrations(db)).toBe(0);
      expect(tableExists(db, "schema_migrations")).toBe(true);
    });
  });

  describe("getTableColumns", () => {
    test("returns column names for an existing table", () => {
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
      const columns = getTableColumns(db, "tasks");
      expect(columns).toContain("id");
      expect(columns).toContain("name");
    });

    test("returns column names even when table has no rows", () => {
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
      const columns = getTableColumns(db, "tasks");
      expect(columns).toEqual(["id"]);
    });

    test("throws for unknown table names", () => {
      expect(() => getTableColumns(db, "malicious_table")).toThrow(
        'Unknown table name: "malicious_table"',
      );
    });

    test("throws for SQL injection attempts", () => {
      expect(() => getTableColumns(db, "tasks; DROP TABLE tasks")).toThrow();
    });

    test("works for all known table names", () => {
      db.run("CREATE TABLE chats (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE ssh_sessions (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE ssh_servers (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE ssh_server_sessions (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE forwarded_ports (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE preferences (key TEXT PRIMARY KEY)");
      db.run("CREATE TABLE passkey_credentials (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE auth_device_requests (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE auth_refresh_sessions (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE review_comments (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");

      expect(getTableColumns(db, "chats")).toContain("id");
      expect(getTableColumns(db, "tasks")).toContain("id");
      expect(getTableColumns(db, "ssh_sessions")).toContain("id");
      expect(getTableColumns(db, "ssh_servers")).toContain("id");
      expect(getTableColumns(db, "ssh_server_sessions")).toContain("id");
      expect(getTableColumns(db, "workspaces")).toContain("id");
      expect(getTableColumns(db, "forwarded_ports")).toContain("id");
      expect(getTableColumns(db, "preferences")).toContain("key");
      expect(getTableColumns(db, "passkey_credentials")).toContain("id");
      expect(getTableColumns(db, "auth_device_requests")).toContain("id");
      expect(getTableColumns(db, "auth_refresh_sessions")).toContain("id");
      expect(getTableColumns(db, "review_comments")).toContain("id");
      expect(getTableColumns(db, "schema_migrations")).toContain("version");
    });
  });

  describe("tableExists", () => {
    test("returns false for non-existing table", () => {
      expect(tableExists(db, "tasks")).toBe(false);
    });

    test("returns true for existing table", () => {
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
      expect(tableExists(db, "tasks")).toBe(true);
    });

    test("returns false after table is dropped", () => {
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
      db.run("DROP TABLE tasks");
      expect(tableExists(db, "tasks")).toBe(false);
    });
  });

  describe("migration execution with mock migrations", () => {
    test("applies a mock migration and records it", () => {
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
      const originalLength = migrations.length;
      const version = nextMigrationVersion();
      migrations.push({
        version,
        name: "add_test_column",
        up: (database) => {
          database.run("ALTER TABLE tasks ADD COLUMN test_column TEXT");
        },
      });

      try {
        expect(runMigrations(db)).toBe(1);
        expect(getTableColumns(db, "tasks")).toContain("test_column");
        expect(getSchemaVersion(db)).toBe(version);
      } finally {
        migrations.length = originalLength;
      }
    });

    test("does not re-apply already applied migrations", () => {
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
      const originalLength = migrations.length;
      const version = nextMigrationVersion();
      let callCount = 0;
      migrations.push({
        version,
        name: "counted_migration",
        up: () => {
          callCount++;
        },
      });

      try {
        runMigrations(db);
        runMigrations(db);
        expect(callCount).toBe(1);
      } finally {
        migrations.length = originalLength;
      }
    });

    test("applies migrations in version order", () => {
      const appliedOrder: number[] = [];
      const originalLength = migrations.length;
      const version1 = nextMigrationVersion();
      const version2 = nextMigrationVersion(2);
      const version3 = nextMigrationVersion(3);
      migrations.push({ version: version3, name: "third", up: () => { appliedOrder.push(3); } });
      migrations.push({ version: version1, name: "first", up: () => { appliedOrder.push(1); } });
      migrations.push({ version: version2, name: "second", up: () => { appliedOrder.push(2); } });

      try {
        expect(runMigrations(db)).toBe(3);
        expect(appliedOrder).toEqual([1, 2, 3]);
      } finally {
        migrations.length = originalLength;
      }
    });

    test("rolls back individual migration on failure", () => {
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
      const originalLength = migrations.length;
      const goodVersion = nextMigrationVersion();
      const badVersion = nextMigrationVersion(2);
      migrations.push({
        version: goodVersion,
        name: "good_migration",
        up: (database) => {
          database.run("ALTER TABLE tasks ADD COLUMN good_column TEXT");
        },
      });
      migrations.push({
        version: badVersion,
        name: "bad_migration",
        up: () => {
          throw new Error("Migration failed deliberately");
        },
      });

      try {
        expect(() => runMigrations(db)).toThrow("Migration failed deliberately");
        expect(getTableColumns(db, "tasks")).toContain("good_column");
        expect(getSchemaVersion(db)).toBe(goodVersion);
      } finally {
        migrations.length = originalLength;
      }
    });
  });
});
