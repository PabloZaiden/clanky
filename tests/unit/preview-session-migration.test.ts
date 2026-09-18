import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migratePreviewSessions } from "../../src/persistence/migrations/preview-sessions";

function createLegacyPreviewSchema(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE execution_hosts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      execution_host_id TEXT,
      execution_host_revision INTEGER
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
}

describe("preview session migration", () => {
  test("backfills workspace bindings, accepts server rows, and is idempotent", () => {
    const db = new Database(":memory:");
    try {
      createLegacyPreviewSchema(db);
      db.run(`
        INSERT INTO execution_hosts (
          id, user_id, kind, source_id, target_key, revision,
          revoked_at, created_at, updated_at
        ) VALUES ('host-1', 'user-1', 'local', 'node-1', 'local:node-1', 3, NULL, 'now', 'now')
      `);
      db.run(`
        INSERT INTO workspaces (
          id, user_id, execution_host_id, execution_host_revision
        ) VALUES ('workspace-1', 'user-1', 'host-1', 3)
      `);
      db.run(`
        INSERT INTO preview_sessions (
          id, user_id, workspace_id, remote_host, remote_port, local_host,
          local_port, local_url, initial_path, created_at, updated_at, status
        ) VALUES (
          'preview-1', 'user-1', 'workspace-1', 'localhost', 3000,
          '127.0.0.1', 43000, 'http://127.0.0.1:43000/', '/',
          'now', 'now', 'active'
        )
      `);

      migratePreviewSessions(db);
      migratePreviewSessions(db);

      const migrated = db.query(`
        SELECT target_kind, workspace_id, execution_host_id, execution_host_revision
        FROM preview_sessions WHERE id = 'preview-1'
      `).get();
      expect(migrated).toEqual({
        target_kind: "workspace",
        workspace_id: "workspace-1",
        execution_host_id: "host-1",
        execution_host_revision: 3,
      });

      db.run(`
        INSERT INTO preview_sessions (
          id, user_id, target_kind, workspace_id, execution_host_id,
          execution_host_revision, remote_host, remote_port, local_host,
          local_port, local_url, initial_path, created_at, updated_at, status
        ) VALUES (
          'preview-server', 'user-1', 'server', NULL, 'host-1', 3,
          'localhost', 3001, '127.0.0.1', 43001, 'http://127.0.0.1:43001/',
          '/', 'now', 'now', 'active'
        )
      `);
      expect(db.query("SELECT COUNT(*) AS count FROM preview_sessions").get())
        .toEqual({ count: 2 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("fails explicitly when a workspace preview has no current host binding", () => {
    const db = new Database(":memory:");
    try {
      createLegacyPreviewSchema(db);
      db.run(`
        INSERT INTO preview_sessions (
          id, user_id, workspace_id, remote_host, remote_port, local_host,
          local_port, local_url, initial_path, created_at, updated_at, status
        ) VALUES (
          'orphan-preview', 'user-1', 'missing-workspace', 'localhost', 3000,
          '127.0.0.1', 43000, 'http://127.0.0.1:43000/', '/', 'now', 'now', 'active'
        )
      `);

      expect(() => migratePreviewSessions(db)).toThrow(
        "Cannot migrate preview orphan-preview without a current execution-host binding",
      );
    } finally {
      db.close();
    }
  });
});
