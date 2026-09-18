/**
 * Makes preview sessions target canonical execution hosts directly.
 */

import type { Database } from "bun:sqlite";
import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("persistence:migrations:preview-sessions");

interface PreviewColumn {
  name: string;
  notnull: number;
}

function previewColumns(db: Database): PreviewColumn[] {
  return db.query("PRAGMA table_info(preview_sessions)").all() as PreviewColumn[];
}

function createPreviewIndexes(db: Database): void {
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_preview_sessions_workspace_created
    ON preview_sessions(user_id, workspace_id, created_at DESC)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_preview_sessions_execution_host_status
    ON preview_sessions(user_id, execution_host_id, status, updated_at DESC)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_preview_sessions_status_updated
    ON preview_sessions(user_id, status, updated_at DESC)
  `);
}

export function migratePreviewSessions(db: Database): void {
  const columns = previewColumns(db);
  if (columns.length === 0) {
    return;
  }
  const columnNames = new Set(columns.map((column) => column.name));
  const workspaceColumn = columns.find((column) => column.name === "workspace_id");
  const isCanonical = columnNames.has("target_kind")
    && columnNames.has("execution_host_id")
    && columnNames.has("execution_host_revision")
    && workspaceColumn?.notnull === 0;
  if (isCanonical) {
    createPreviewIndexes(db);
    return;
  }

  if (!columnNames.has("workspace_id")) {
    throw new Error("Cannot migrate preview sessions without workspace associations");
  }
  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN IMMEDIATE");
  let discardedCount = 0;
  try {
    const discarded = db.run(`
      DELETE FROM preview_sessions
      WHERE NOT EXISTS (
        SELECT 1
        FROM workspaces workspace
        JOIN execution_hosts host
          ON host.id = workspace.execution_host_id
         AND host.user_id = workspace.user_id
         AND host.revision = workspace.execution_host_revision
        WHERE workspace.id = preview_sessions.workspace_id
          AND workspace.user_id = preview_sessions.user_id
      )
    `);
    discardedCount = discarded.changes;
    db.run(`
      CREATE TABLE preview_sessions_execution_host (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        target_kind TEXT NOT NULL DEFAULT 'workspace'
          CHECK (target_kind IN ('workspace', 'server')),
        workspace_id TEXT,
        execution_host_id TEXT NOT NULL
          REFERENCES execution_hosts(id) ON DELETE CASCADE,
        execution_host_revision INTEGER NOT NULL,
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
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CHECK (
          (target_kind = 'workspace' AND workspace_id IS NOT NULL)
          OR (target_kind = 'server' AND workspace_id IS NULL)
        )
      )
    `);
    db.run(`
      INSERT INTO preview_sessions_execution_host (
        id, user_id, target_kind, workspace_id, execution_host_id,
        execution_host_revision, remote_host, remote_port, local_host,
        local_port, local_url, initial_path, cli_client_id, cli_hostname,
        created_at, updated_at, status, connected_at, closed_at, error_message
      )
      SELECT
        preview.id, preview.user_id, 'workspace', preview.workspace_id,
        workspace.execution_host_id, workspace.execution_host_revision,
        preview.remote_host, preview.remote_port, preview.local_host,
        preview.local_port, preview.local_url, preview.initial_path,
        preview.cli_client_id, preview.cli_hostname, preview.created_at,
        preview.updated_at, preview.status, preview.connected_at,
        preview.closed_at, preview.error_message
      FROM preview_sessions preview
      JOIN workspaces workspace
        ON workspace.id = preview.workspace_id
       AND workspace.user_id = preview.user_id
    `);
    db.run("DROP TABLE preview_sessions");
    db.run("ALTER TABLE preview_sessions_execution_host RENAME TO preview_sessions");
    createPreviewIndexes(db);
    db.run("COMMIT");
    if (discardedCount > 0) {
      log.warn("Discarded preview sessions without a current execution-host binding", {
        count: discardedCount,
      });
    }
    if (db.query("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("Foreign-key violations detected after preview execution-host migration");
    }
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {
      // SQLite may have already rolled back the transaction.
    }
    throw error;
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}
