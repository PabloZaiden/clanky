/**
 * Tests for the database migration system.
 *
 * These tests verify that the migration infrastructure works correctly.
 * Legacy migration tests (v1-v16) were removed in the first clean-cut reset.
 * Migration tests (v1-v13) were removed in the second clean-cut reset.
 * The base schema contains the reset baseline, and newer schema additions stay
 * covered by explicit migration tests until a future clean-cut reset folds them in.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  runMigrations,
  getSchemaVersion,
  migrations,
  getTableColumns,
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
    tempDir = await mkdtemp(join(tmpdir(), "ralpher-migration-test-"));
    db = new Database(join(tempDir, "test.db"));
    db.run("PRAGMA foreign_keys = ON");
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
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

    test("returns 0 when all migrations are already applied", () => {
      runMigrations(db);
      const applied = runMigrations(db);
      expect(applied).toBe(0);
    });

    test("is idempotent - safe to call multiple times", () => {
      runMigrations(db);
      runMigrations(db);
      runMigrations(db);
      expect(tableExists(db, "schema_migrations")).toBe(true);
    });

    test("normalizes legacy loop modes to loop", () => {
      db.run("CREATE TABLE loops (id TEXT PRIMARY KEY, mode TEXT)");
      db.run("INSERT INTO loops (id, mode) VALUES ('legacy-chat', 'chat')");
      db.run("INSERT INTO loops (id, mode) VALUES ('legacy-loop', 'loop')");
      db.run("INSERT INTO loops (id, mode) VALUES ('legacy-null', NULL)");

      const applied = runMigrations(db);

      expect(applied).toBe(migrations.length);

      const rows = db.query("SELECT id, mode FROM loops ORDER BY id").all() as Array<{
        id: string;
        mode: string;
      }>;
      expect(rows).toEqual([
        { id: "legacy-chat", mode: "loop" },
        { id: "legacy-loop", mode: "loop" },
        { id: "legacy-null", mode: "loop" },
      ]);
    });

    test("adds pull request monitoring to loops", () => {
      db.run("CREATE TABLE loops (id TEXT PRIMARY KEY)");

      const applied = runMigrations(db);

      expect(applied).toBe(migrations.length);
      expect(getTableColumns(db, "loops")).toContain("pull_request_monitoring");
    });

    test("adds automatic PR flow state to loops", () => {
      db.run("CREATE TABLE loops (id TEXT PRIMARY KEY)");

      const applied = runMigrations(db);

      expect(applied).toBe(migrations.length);
      expect(getTableColumns(db, "loops")).toContain("automatic_pr_flow");
    });

    test("adds cheap model to loops", () => {
      db.run("CREATE TABLE loops (id TEXT PRIMARY KEY)");

      const applied = runMigrations(db);

      expect(applied).toBe(migrations.length);
      expect(getTableColumns(db, "loops")).toContain("cheap_model");
    });

    test("creates auth device and refresh tables", () => {
      const applied = runMigrations(db);

      expect(applied).toBe(migrations.length);
      expect(tableExists(db, "auth_device_requests")).toBe(true);
      expect(tableExists(db, "auth_refresh_sessions")).toBe(true);
      expect(getTableColumns(db, "auth_device_requests")).toContain("device_code_hash");
      expect(getTableColumns(db, "auth_refresh_sessions")).toContain("refresh_token_hash");
      expect(getTableColumns(db, "auth_refresh_sessions")).toContain("scope");

      const authIndexes = db.query(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name IN ('auth_device_requests', 'auth_refresh_sessions')
        ORDER BY name
      `).all() as Array<{ name: string }>;
      const authIndexNames = authIndexes.map((index) => index.name);

      expect(authIndexNames).not.toContain("idx_auth_device_requests_device_code_hash");
      expect(authIndexNames).not.toContain("idx_auth_device_requests_user_code");
      expect(authIndexNames).not.toContain("idx_auth_refresh_sessions_token_hash");
      expect(authIndexNames).toEqual(expect.arrayContaining([
        "idx_auth_device_requests_status_expires_at",
        "idx_auth_refresh_sessions_family_id",
        "idx_auth_refresh_sessions_subject_created_at",
      ]));
    });

    test("adds use_tmux columns to SSH session tables", () => {
      db.run("CREATE TABLE ssh_sessions (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE ssh_server_sessions (id TEXT PRIMARY KEY)");

      const applied = runMigrations(db);

      expect(applied).toBe(migrations.length);
      expect(getTableColumns(db, "ssh_sessions")).toContain("use_tmux");
      expect(getTableColumns(db, "ssh_server_sessions")).toContain("use_tmux");
    });
  });

  describe("getTableColumns", () => {
    test("returns column names for an existing table", () => {
      db.run("CREATE TABLE loops (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
      const columns = getTableColumns(db, "loops");
      expect(columns).toContain("id");
      expect(columns).toContain("name");
    });

    test("returns column names even when table has no rows", () => {
      db.run("CREATE TABLE loops (id TEXT PRIMARY KEY)");
      const columns = getTableColumns(db, "loops");
      expect(columns).toEqual(["id"]);
    });

    test("throws for unknown table names (SQL injection prevention)", () => {
      expect(() => getTableColumns(db, "malicious_table")).toThrow(
        'Unknown table name: "malicious_table"'
      );
    });

    test("throws for SQL injection attempts", () => {
      expect(() => getTableColumns(db, "loops; DROP TABLE loops")).toThrow();
    });

    test("works for all known table names", () => {
      // Create all known tables
      db.run("CREATE TABLE chats (id TEXT PRIMARY KEY)");
      db.run("CREATE TABLE loops (id TEXT PRIMARY KEY)");
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

      // All should work without throwing
      expect(getTableColumns(db, "chats")).toContain("id");
      expect(getTableColumns(db, "loops")).toContain("id");
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
      expect(tableExists(db, "loops")).toBe(false);
    });

    test("returns true for existing table", () => {
      db.run("CREATE TABLE loops (id TEXT PRIMARY KEY)");
      expect(tableExists(db, "loops")).toBe(true);
    });

    test("returns false after table is dropped", () => {
      db.run("CREATE TABLE loops (id TEXT PRIMARY KEY)");
      expect(tableExists(db, "loops")).toBe(true);
      db.run("DROP TABLE loops");
      expect(tableExists(db, "loops")).toBe(false);
    });
  });

  describe("chat migration", () => {
    test("creates the chats table and indexes", () => {
      const applied = runMigrations(db);

      expect(applied).toBe(migrations.length);
      expect(tableExists(db, "chats")).toBe(true);

      const columns = getTableColumns(db, "chats");
      expect(columns).toContain("workspace_id");
      expect(columns).toContain("session_id");
      expect(columns).toContain("interrupt_requested");
    });

    test("creates chat indexes even when chats table already exists", () => {
      db.run(`
        CREATE TABLE chats (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          directory TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          model_provider_id TEXT,
          model_model_id TEXT,
          model_variant TEXT,
          use_worktree INTEGER NOT NULL DEFAULT 1,
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
          active_message_id TEXT,
          interrupt_requested INTEGER NOT NULL DEFAULT 0
        )
      `);

      const applied = runMigrations(db);
      expect(applied).toBe(migrations.length);

      const indexes = db.query(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'chats'
        ORDER BY name
      `).all() as Array<{ name: string }>;

      const indexNames = indexes.map((index) => index.name);

      expect(indexNames).toEqual(expect.arrayContaining([
        "idx_chats_created_at",
        "idx_chats_workspace_created_at",
        "idx_chats_directory_workspace_status",
      ]));
      expect(indexNames).not.toContain("idx_chats_workspace_id");
      expect(indexNames).not.toContain("idx_chats_directory");
    });
  });

  describe("passkey credentials migration", () => {
    test("creates the passkey credentials table and index", () => {
      const applied = runMigrations(db);

      expect(applied).toBe(migrations.length);
      expect(tableExists(db, "passkey_credentials")).toBe(true);

      const columns = getTableColumns(db, "passkey_credentials");
      expect(columns).toEqual(expect.arrayContaining([
        "credential_id",
        "public_key",
        "counter",
        "device_type",
        "backed_up",
        "transports",
      ]));

      const indexes = db.query(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'passkey_credentials'
        ORDER BY name
      `).all() as Array<{ name: string }>;

      expect(indexes.map((index) => index.name)).toContain("idx_passkey_credentials_credential_id");
    });
  });

  describe("loop auto-accept plan migration", () => {
    test("adds auto_accept_plan to loops when missing", () => {
      db.run(`
        CREATE TABLE loops (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        )
      `);

      const applied = runMigrations(db);

      expect(applied).toBe(migrations.length);
      expect(getTableColumns(db, "loops")).toContain("auto_accept_plan");
    });

    test("is idempotent when auto_accept_plan already exists", () => {
      db.run(`
        CREATE TABLE loops (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          auto_accept_plan INTEGER NOT NULL DEFAULT 0
        )
      `);

      const applied = runMigrations(db);

      expect(applied).toBe(migrations.length);
      expect(getTableColumns(db, "loops")).toContain("auto_accept_plan");
    });
  });

  describe("loop fully autonomous migration", () => {
    test("adds fully_autonomous and fully_autonomous_pending to loops when missing", () => {
      db.run(`
        CREATE TABLE loops (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        )
      `);

      const applied = runMigrations(db);

      expect(applied).toBe(migrations.length);
      expect(getTableColumns(db, "loops")).toContain("fully_autonomous");
      expect(getTableColumns(db, "loops")).toContain("fully_autonomous_pending");
    });

    test("is idempotent when fully autonomous columns already exist", () => {
      db.run(`
        CREATE TABLE loops (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          fully_autonomous INTEGER NOT NULL DEFAULT 0,
          fully_autonomous_pending INTEGER NOT NULL DEFAULT 0
        )
      `);

      const applied = runMigrations(db);

      expect(applied).toBe(migrations.length);
      expect(getTableColumns(db, "loops")).toContain("fully_autonomous");
      expect(getTableColumns(db, "loops")).toContain("fully_autonomous_pending");
    });
  });

  describe("workspace devcontainer subpath migration", () => {
    test("adds devcontainer_subpath to existing workspaces tables", () => {
      db.run(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          directory TEXT NOT NULL,
          server_fingerprint TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          server_settings TEXT NOT NULL DEFAULT '{}',
          source_directory TEXT,
          ssh_server_id TEXT,
          repo_url TEXT,
          base_path TEXT,
          provider TEXT
        )
      `);

      runMigrations(db);
      runMigrations(db);

      const columns = getTableColumns(db, "workspaces");
      expect(columns).toContain("devcontainer_subpath");
    });
  });

  describe("migration execution with mock migration", () => {
    test("applies a mock migration and records it", () => {
      // Create a table to migrate
      db.run("CREATE TABLE loops (id TEXT PRIMARY KEY, name TEXT NOT NULL)");

      // Temporarily add a mock migration
      const originalLength = migrations.length;
      const version = nextMigrationVersion();
      migrations.push({
        version,
        name: "test_add_description",
        up: (database) => {
          const columns = getTableColumns(database, "loops");
          if (!columns.includes("description")) {
            database.run("ALTER TABLE loops ADD COLUMN description TEXT");
          }
        },
      });

      try {
        const applied = runMigrations(db);
        expect(applied).toBe(originalLength + 1);

        // Verify the column was added
        const columns = getTableColumns(db, "loops");
        expect(columns).toContain("description");

        // Verify schema version
        expect(getSchemaVersion(db)).toBe(version);

        // Verify schema_migrations has the record
        const record = db.query(`SELECT * FROM schema_migrations WHERE version = ${version}`).get() as {
          version: number;
          name: string;
          applied_at: string;
        };
        expect(record).not.toBeNull();
        expect(record.name).toBe("test_add_description");
        expect(record.applied_at).toBeTruthy();
      } finally {
        // Restore the original migrations array
        migrations.length = originalLength;
      }
    });

    test("does not re-apply already applied migrations", () => {
      db.run("CREATE TABLE loops (id TEXT PRIMARY KEY, name TEXT NOT NULL)");

      let callCount = 0;
      const originalLength = migrations.length;
      const version = nextMigrationVersion();
      migrations.push({
        version,
        name: "test_counting",
        up: () => {
          callCount++;
        },
      });

      try {
        runMigrations(db);
        expect(callCount).toBe(1);

        // Run again - should not re-apply
        runMigrations(db);
        expect(callCount).toBe(1);
      } finally {
        migrations.length = originalLength;
      }
    });

    test("applies migrations in version order", () => {
      db.run("CREATE TABLE loops (id TEXT PRIMARY KEY)");

      const appliedOrder: number[] = [];
      const originalLength = migrations.length;

      // Add migrations in reverse order
      const version1 = nextMigrationVersion();
      const version2 = nextMigrationVersion(2);
      const version3 = nextMigrationVersion(3);
      migrations.push({
        version: version3,
        name: "third",
        up: () => { appliedOrder.push(3); },
      });
      migrations.push({
        version: version1,
        name: "first",
        up: () => { appliedOrder.push(1); },
      });
      migrations.push({
        version: version2,
        name: "second",
        up: () => { appliedOrder.push(2); },
      });

      try {
        const applied = runMigrations(db);
        expect(applied).toBe(originalLength + 3);
        expect(appliedOrder).toEqual([1, 2, 3]);
      } finally {
        migrations.length = originalLength;
      }
    });

    test("rolls back individual migration on failure", () => {
      db.run("CREATE TABLE loops (id TEXT PRIMARY KEY)");

      const originalLength = migrations.length;
      const goodVersion = nextMigrationVersion();
      const badVersion = nextMigrationVersion(2);
      migrations.push({
        version: goodVersion,
        name: "good_migration",
        up: (database) => {
          const columns = getTableColumns(database, "loops");
          if (!columns.includes("good_column")) {
            database.run("ALTER TABLE loops ADD COLUMN good_column TEXT");
          }
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

        // Good migration should have been applied (it ran in its own transaction)
        const columns = getTableColumns(db, "loops");
        expect(columns).toContain("good_column");
        expect(getSchemaVersion(db)).toBe(goodVersion);
      } finally {
        migrations.length = originalLength;
      }
    });
  });
});
