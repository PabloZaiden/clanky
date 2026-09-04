/**
 * Allows terminal sessions to belong directly to an execution host.
 */

import type { Database } from "bun:sqlite";

export function migrateDirectExecutionHostTerminalSessions(db: Database): void {
  const columns = db.query("PRAGMA table_info(terminal_sessions)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const workspaceColumn = columns.find((column) => column.name === "workspace_id");
  if (!workspaceColumn || workspaceColumn.notnull === 0) {
    return;
  }

  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN IMMEDIATE");
  try {
    db.run(`
      CREATE TABLE terminal_sessions_direct_host (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        workspace_id TEXT,
        directory TEXT NOT NULL,
        remote_session_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        last_connected_at TEXT,
        error_message TEXT,
        task_id TEXT,
        connection_mode TEXT NOT NULL DEFAULT 'dtach',
        use_tmux INTEGER NOT NULL DEFAULT 0,
        runtime_connection_mode TEXT,
        notice_message TEXT,
        target_transport TEXT NOT NULL DEFAULT 'stdio',
        target_key TEXT NOT NULL DEFAULT '',
        target_revision INTEGER NOT NULL DEFAULT 1,
        target_hostname TEXT,
        target_port INTEGER,
        target_username TEXT,
        target_execution_node_id TEXT,
        is_private INTEGER NOT NULL DEFAULT 0,
        execution_host_id TEXT REFERENCES execution_hosts(id) ON DELETE CASCADE,
        execution_host_revision INTEGER,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CHECK (workspace_id IS NOT NULL OR execution_host_id IS NOT NULL)
      )
    `);
    db.run(`
      INSERT INTO terminal_sessions_direct_host
      SELECT
        id, user_id, name, workspace_id, directory, remote_session_name,
        created_at, updated_at, status, last_connected_at, error_message,
        task_id, connection_mode, use_tmux, runtime_connection_mode,
        notice_message, target_transport, target_key, target_revision,
        target_hostname, target_port, target_username,
        target_execution_node_id, is_private, execution_host_id,
        execution_host_revision
      FROM terminal_sessions
    `);
    db.run("DROP TABLE terminal_sessions");
    db.run("ALTER TABLE terminal_sessions_direct_host RENAME TO terminal_sessions");
    db.run(`
      CREATE INDEX idx_terminal_sessions_workspace_id
      ON terminal_sessions(user_id, workspace_id)
    `);
    db.run(`
      CREATE INDEX idx_terminal_sessions_created_at
      ON terminal_sessions(user_id, created_at DESC)
    `);
    db.run(`
      CREATE UNIQUE INDEX idx_terminal_sessions_task_id_unique
      ON terminal_sessions(user_id, task_id)
      WHERE task_id IS NOT NULL
    `);
    db.run(`
      CREATE INDEX idx_terminal_sessions_execution_host
      ON terminal_sessions(execution_host_id)
    `);
    db.run("COMMIT");
    const violations = db.query("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error("Foreign-key violations detected after terminal-session migration");
    }
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
    throw error;
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}
