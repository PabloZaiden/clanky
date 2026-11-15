import type { Database } from "bun:sqlite";

export function migrateSshKeyAccess(db: Database): void {
  db.run(`
    CREATE TABLE ssh_key_sources (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES webapp_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      host_json TEXT NOT NULL,
      host_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(id, user_id)
    )
  `);
  db.run(`
    CREATE TABLE ssh_public_keys (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      comment TEXT NOT NULL,
      alias TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(source_id, user_id) REFERENCES ssh_key_sources(id, user_id) ON DELETE CASCADE,
      UNIQUE(source_id, fingerprint),
      UNIQUE(id, user_id)
    )
  `);
  // A provisioning scope is allocated before its workspace row exists.
  db.run(`
    CREATE TABLE ssh_workspace_key_grants (
      user_id TEXT NOT NULL REFERENCES webapp_users(id) ON DELETE CASCADE,
      scope_id TEXT NOT NULL,
      key_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      PRIMARY KEY(user_id, scope_id, key_id),
      FOREIGN KEY(key_id, user_id) REFERENCES ssh_public_keys(id, user_id) ON DELETE CASCADE
    )
  `);
}
