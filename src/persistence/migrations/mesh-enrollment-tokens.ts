import type { Database } from "bun:sqlite";

export function migrateMeshEnrollmentTokens(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS mesh_enrollment_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      link_id TEXT,
      controller_node_id TEXT NOT NULL,
      controller_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_mesh_enrollment_tokens_owner
    ON mesh_enrollment_tokens(user_id, expires_at, consumed_at)
  `);
}
