/**
 * Makes the canonical execution host the owner of VNC tunnel sessions.
 */

import type { Database } from "bun:sqlite";

export function migrateExecutionHostVncSessions(db: Database): void {
  const columns = db.query("PRAGMA table_info(vnc_sessions)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const sshServerColumn = columns.find((column) => column.name === "ssh_server_id");
  if (!sshServerColumn || sshServerColumn.notnull === 0) {
    return;
  }

  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN IMMEDIATE");
  try {
    db.run(`
      CREATE TABLE vnc_sessions_execution_host (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        ssh_server_id TEXT,
        remote_host TEXT NOT NULL DEFAULT '127.0.0.1',
        remote_port INTEGER NOT NULL,
        local_port INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        connected_at TEXT,
        error_message TEXT,
        execution_host_id TEXT REFERENCES execution_hosts(id) ON DELETE SET NULL,
        execution_host_revision INTEGER,
        FOREIGN KEY (ssh_server_id) REFERENCES ssh_servers(id) ON DELETE SET NULL
      )
    `);
    db.run(`
      INSERT INTO vnc_sessions_execution_host
      SELECT
        id, user_id, ssh_server_id, remote_host, remote_port, local_port,
        created_at, updated_at, status, pid, connected_at, error_message,
        execution_host_id, execution_host_revision
      FROM vnc_sessions
    `);
    db.run("DROP TABLE vnc_sessions");
    db.run("ALTER TABLE vnc_sessions_execution_host RENAME TO vnc_sessions");
    db.run(`
      CREATE UNIQUE INDEX idx_vnc_sessions_active_host_port
      ON vnc_sessions(user_id, execution_host_id, remote_port)
      WHERE status IN ('starting', 'active', 'stopping')
    `);
    db.run(`
      CREATE UNIQUE INDEX idx_vnc_sessions_active_local_port
      ON vnc_sessions(local_port)
      WHERE status IN ('starting', 'active', 'stopping')
    `);
    db.run(`
      CREATE INDEX idx_vnc_sessions_execution_host
      ON vnc_sessions(execution_host_id)
    `);
    db.run("COMMIT");
    if (db.query("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("Foreign-key violations detected after VNC execution-host migration");
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
