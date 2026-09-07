/**
 * Migration v49: add workspace-exclusive Mesh worker enrollments.
 */

import type { Database } from "bun:sqlite";

const MIGRATION_TABLE_NAMES = new Set([
  "mesh_enrollment_tokens",
  "mesh_worker_registrations",
]);

function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  definition: string,
): void {
  if (!MIGRATION_TABLE_NAMES.has(table)) {
    throw new Error(`Unknown workspace worker enrollment migration table: ${table}`);
  }
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function migrateWorkspaceWorkerEnrollments(db: Database): void {
  addColumnIfMissing(
    db,
    "mesh_enrollment_tokens",
    "purpose",
    "TEXT NOT NULL DEFAULT 'global'",
  );
  addColumnIfMissing(
    db,
    "mesh_enrollment_tokens",
    "workspace_worker_enrollment_id",
    "TEXT",
  );
  addColumnIfMissing(
    db,
    "mesh_worker_registrations",
    "registration_scope",
    "TEXT NOT NULL DEFAULT 'global'",
  );
  addColumnIfMissing(
    db,
    "mesh_worker_registrations",
    "workspace_worker_enrollment_id",
    "TEXT",
  );
  addColumnIfMissing(db, "mesh_worker_registrations", "workspace_id", "TEXT");

  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_worker_enrollments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'connected', 'claimed', 'attached',
                   'cancelled', 'expired', 'failed')
      ),
      worker_node_id TEXT,
      workspace_id TEXT UNIQUE,
      claimed_by TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      connected_at TEXT,
      attached_at TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_workspace_worker_enrollments_owner
    ON workspace_worker_enrollments(user_id, status, updated_at DESC)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_workspace_worker_enrollments_worker
    ON workspace_worker_enrollments(user_id, worker_node_id)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_mesh_worker_registrations_scope
    ON mesh_worker_registrations(local_user_id, registration_scope, grant_status)
  `);
}
