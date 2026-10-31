import type { Database } from "bun:sqlite";

export function dropRetiredExecutionTables(db: Database): void {
  for (const table of ["ssh_servers", "workspace_execution_targets"] as const) {
    const exists = db.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!exists) continue;
    const populated = db.query(`SELECT 1 FROM ${table} LIMIT 1`).get();
    if (populated) {
      throw new Error(
        "Legacy execution configuration still exists. Migrate or remove it with the previous application version before upgrading; no resource data was deleted.",
      );
    }
    db.run(`DROP TABLE ${table}`);
  }
}

export function retireExecutionTransport(db: Database): void {
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.run(`DELETE FROM execution_hosts
        WHERE kind = 'ssh'
          AND NOT EXISTS (
            SELECT 1 FROM workspaces
            WHERE execution_host_id = execution_hosts.id
              OR provisioning_host_id = execution_hosts.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM chats WHERE execution_host_id = execution_hosts.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM terminal_sessions WHERE execution_host_id = execution_hosts.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM preview_sessions WHERE execution_host_id = execution_hosts.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM provisioning_jobs WHERE execution_host_id = execution_hosts.id
          )`);
      const unsupportedHost = db.query(
        "SELECT 1 FROM execution_hosts WHERE kind NOT IN ('local', 'mesh') LIMIT 1",
      ).get();
      if (unsupportedHost) {
        throw new Error(
          "Unsupported legacy execution hosts still exist. Migrate or remove their resources with the previous application version before upgrading; no resource data was deleted.",
        );
      }

      dropRetiredExecutionTables(db);
      db.run(`CREATE TABLE execution_hosts_current (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'mesh')),
        source_id TEXT NOT NULL,
        target_key TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        platform_os TEXT,
        platform_architecture TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (user_id, kind, source_id)
      )`);
      db.run(`INSERT INTO execution_hosts_current (
        id, user_id, kind, source_id, target_key, revision, revoked_at,
        created_at, updated_at, platform_os, platform_architecture, capabilities_json
      ) SELECT id, user_id, kind, source_id, target_key, revision, revoked_at,
        created_at, updated_at, platform_os, platform_architecture, capabilities_json
        FROM execution_hosts`);
      db.run("DROP TABLE execution_hosts");
      db.run("ALTER TABLE execution_hosts_current RENAME TO execution_hosts");
      db.run("CREATE INDEX idx_execution_hosts_user_kind ON execution_hosts(user_id, kind, created_at ASC)");
      db.run("CREATE INDEX idx_execution_hosts_user_revoked ON execution_hosts(user_id, revoked_at)");
      db.run("CREATE INDEX idx_execution_hosts_user_target ON execution_hosts(user_id, target_key)");
      if (db.query("PRAGMA foreign_key_check").get()) {
        throw new Error("Execution-host migration would leave invalid resource references.");
      }
    })();
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}
