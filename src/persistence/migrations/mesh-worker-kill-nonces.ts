import type { Database } from "bun:sqlite";

export function migrateMeshWorkerKillNonces(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS mesh_worker_kill_nonces (
      nonce TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_mesh_worker_kill_nonces_expires_at
    ON mesh_worker_kill_nonces(expires_at)
  `);
}
