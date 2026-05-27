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
    test("starts with chat source migration", () => {
      expect(migrations).toHaveLength(2);
      expect(migrations[1]?.name).toBe("add_vnc_sessions");
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

    test("is idempotent after chat source migration has been applied", () => {
      db.run("CREATE TABLE chats (id TEXT PRIMARY KEY, source_kind TEXT)");
      runMigrations(db);
      expect(runMigrations(db)).toBe(0);
      expect(runMigrations(db)).toBe(0);
      expect(tableExists(db, "schema_migrations")).toBe(true);
    });

    test("adds chat source fields and makes workspace nullable", () => {
      db.run("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE ssh_servers (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE ssh_server_sessions (id TEXT PRIMARY KEY)");
      db.run(`
        CREATE TABLE chats (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'workspace',
          task_id TEXT,
          directory TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          model_provider_id TEXT,
          model_model_id TEXT,
          model_variant TEXT,
          use_worktree INTEGER NOT NULL DEFAULT 1,
          auto_approve_permissions INTEGER NOT NULL DEFAULT 1,
          skip_base_branch_sync INTEGER NOT NULL DEFAULT 0,
          base_branch TEXT,
          mode TEXT NOT NULL DEFAULT 'chat',
          status TEXT NOT NULL DEFAULT 'idle',
          started_at TEXT,
          completed_at TEXT,
          last_activity_at TEXT,
          session_id TEXT,
          session_server_url TEXT,
          error_message TEXT,
          error_timestamp TEXT,
          error_code TEXT,
          worktree_original_branch TEXT,
          worktree_working_branch TEXT,
          worktree_path TEXT,
          messages TEXT,
          logs TEXT,
          tool_calls TEXT,
          pending_permission_requests TEXT,
          active_message_id TEXT,
          interrupt_requested INTEGER NOT NULL DEFAULT 0
        )
      `);
      db.run("INSERT INTO workspaces (id) VALUES ('workspace-1')");
      db.run(`
        INSERT INTO chats (
          id, name, workspace_id, directory, created_at, updated_at
        ) VALUES (
          'chat-1', 'Chat 1', 'workspace-1', '/repo', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `);

      expect(runMigrations(db)).toBe(2);
      expect(getTableColumns(db, "chats")).toContain("source_kind");
      expect(getTableColumns(db, "chats")).toContain("ssh_server_id");
      expect(getTableColumns(db, "chats")).toContain("ssh_server_session_id");
      expect(getTableColumns(db, "chats")).toContain("connection_status");
      const migrated = db.query("SELECT source_kind, workspace_id, connection_status FROM chats WHERE id = ?")
        .get("chat-1") as { source_kind: string; workspace_id: string; connection_status: string };
      expect(migrated).toEqual({
        source_kind: "workspace",
        workspace_id: "workspace-1",
        connection_status: "disconnected",
      });
      db.run("INSERT INTO ssh_servers (id) VALUES ('ssh-server-1')");
      db.run("INSERT INTO ssh_server_sessions (id) VALUES ('ssh-session-1')");
      db.run(`
        INSERT INTO chats (
          id, name, source_kind, workspace_id, ssh_server_id, ssh_server_session_id,
          directory, created_at, updated_at
        ) VALUES (
          'remote-chat', 'Remote chat', 'ssh_server', NULL, 'ssh-server-1', 'ssh-session-1',
          '/repo', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `);
      expect(() => db.run(`
        INSERT INTO chats (
          id, name, source_kind, workspace_id, ssh_server_id, ssh_server_session_id,
          directory, created_at, updated_at
        ) VALUES (
          'bad-remote-chat', 'Bad remote chat', 'ssh_server', NULL, 'ssh-server-1', NULL,
          '/repo', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `)).toThrow();
      db.run("DELETE FROM ssh_server_sessions WHERE id = 'ssh-session-1'");
      const deletedRemote = db.query("SELECT id FROM chats WHERE id = ?").get("remote-chat");
      expect(deletedRemote).toBeNull();
      expect(runMigrations(db)).toBe(0);
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
      db.run("CREATE TABLE vnc_sessions (id TEXT PRIMARY KEY)");

      expect(getTableColumns(db, "chats")).toContain("id");
      expect(getTableColumns(db, "tasks")).toContain("id");
      expect(getTableColumns(db, "vnc_sessions")).toContain("id");
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
        expect(runMigrations(db)).toBe(3);
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
        expect(runMigrations(db)).toBe(5);
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
