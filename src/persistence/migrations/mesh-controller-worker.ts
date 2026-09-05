/**
 * Migration v45: destructive clean-break to controller-worker mesh.
 *
 * Deletes all legacy Mesh identities, links, members, pairing/enrollment
 * artifacts, kind='mesh' execution hosts, and all associated workspaces,
 * tasks, chats, transcripts, agents, runs, terminal/preview/provisioning/VNC
 * records. Preserves all local/SSH data.
 *
 * Creates new persistence tables for controller-worker grants and worker
 * registrations. Flags the node identity for fresh regeneration on next
 * startup.
 */

import type { Database } from "bun:sqlite";
function tableExists(db: Database, name: string): boolean {
  const row = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== null;
}

export function migrateMeshControllerWorker(db: Database): void {
  const migrate = db.transaction(() => {
    db.run("DROP TABLE IF EXISTS temp._mesh_host_ids");
    db.run("DROP TABLE IF EXISTS temp._mesh_workspace_ids");
    db.run(`
      CREATE TEMP TABLE _mesh_host_ids AS
      SELECT id FROM execution_hosts WHERE kind = 'mesh'
    `);
    db.run(`
      CREATE TEMP TABLE _mesh_workspace_ids AS
      SELECT id FROM workspaces
      WHERE execution_host_id IN (SELECT id FROM _mesh_host_ids)
    `);

    db.run(`
      DELETE FROM review_comments WHERE task_id IN (
        SELECT id FROM tasks WHERE workspace_id IN (SELECT id FROM _mesh_workspace_ids)
      )
    `);
    db.run(`
      DELETE FROM sessions WHERE task_id IN (
        SELECT id FROM tasks WHERE workspace_id IN (SELECT id FROM _mesh_workspace_ids)
      )
    `);
    if (tableExists(db, "clanky_context_api_keys")) {
      db.run(`
        DELETE FROM clanky_context_api_keys
        WHERE workspace_id IN (SELECT id FROM _mesh_workspace_ids)
      `);
    }
    for (const table of ["task_transcript_entries", "task_transcript_meta"]) {
      if (tableExists(db, table)) {
        db.run(`
          DELETE FROM ${table} WHERE task_id IN (
            SELECT id FROM tasks WHERE workspace_id IN (SELECT id FROM _mesh_workspace_ids)
          )
        `);
      }
    }
    for (const table of ["chat_transcript_entries", "chat_transcript_meta"]) {
      if (tableExists(db, table)) {
        db.run(`
          DELETE FROM ${table} WHERE chat_id IN (
            SELECT id FROM chats WHERE workspace_id IN (SELECT id FROM _mesh_workspace_ids)
            UNION
            SELECT id FROM chats
            WHERE source_kind = 'execution_host'
              AND execution_host_id IN (SELECT id FROM _mesh_host_ids)
          )
        `);
      }
    }
    for (const table of ["agent_run_transcript_entries", "agent_run_transcript_meta"]) {
      if (tableExists(db, table)) {
        db.run(`
          DELETE FROM ${table} WHERE agent_run_id IN (
            SELECT run.id FROM agent_runs run
            JOIN agents agent ON agent.id = run.agent_id
            WHERE agent.workspace_id IN (SELECT id FROM _mesh_workspace_ids)
          )
        `);
      }
    }
    db.run(`
      DELETE FROM agent_runs WHERE agent_id IN (
        SELECT id FROM agents WHERE workspace_id IN (SELECT id FROM _mesh_workspace_ids)
      )
    `);
    db.run("DELETE FROM agents WHERE workspace_id IN (SELECT id FROM _mesh_workspace_ids)");
    db.run("DELETE FROM chats WHERE workspace_id IN (SELECT id FROM _mesh_workspace_ids)");
    db.run(`
      DELETE FROM chats
      WHERE source_kind = 'execution_host'
        AND execution_host_id IN (SELECT id FROM _mesh_host_ids)
    `);
    db.run("DELETE FROM preview_sessions WHERE workspace_id IN (SELECT id FROM _mesh_workspace_ids)");
    db.run("DELETE FROM terminal_sessions WHERE workspace_id IN (SELECT id FROM _mesh_workspace_ids)");
    db.run("DELETE FROM terminal_sessions WHERE execution_host_id IN (SELECT id FROM _mesh_host_ids)");
    db.run("DELETE FROM provisioning_jobs WHERE execution_host_id IN (SELECT id FROM _mesh_host_ids)");
    db.run("DELETE FROM vnc_sessions WHERE execution_host_id IN (SELECT id FROM _mesh_host_ids)");
    db.run("DELETE FROM tasks WHERE workspace_id IN (SELECT id FROM _mesh_workspace_ids)");
    db.run("DELETE FROM workspaces WHERE id IN (SELECT id FROM _mesh_workspace_ids)");
    db.run("DELETE FROM execution_hosts WHERE id IN (SELECT id FROM _mesh_host_ids)");
    db.run("DROP TABLE _mesh_workspace_ids");
    db.run("DROP TABLE _mesh_host_ids");

    for (const table of [
      "mesh_pairing_approvals",
      "mesh_pairing_requests",
      "mesh_enrollment_tokens",
      "mesh_link_members",
      "mesh_links",
      "mesh_nodes",
      "mesh_node_identity",
    ]) {
      if (tableExists(db, table)) {
        db.run(`DELETE FROM ${table}`);
      }
    }

    db.run("DROP TABLE IF EXISTS mesh_enrollment_tokens");
    db.run(`
      CREATE TABLE mesh_enrollment_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        controller_node_id TEXT NOT NULL,
        controller_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      )
    `);
    db.run(`
      CREATE INDEX idx_mesh_enrollment_tokens_owner
      ON mesh_enrollment_tokens(user_id, expires_at, consumed_at)
    `);

    for (const table of [
      "mesh_pairing_approvals",
      "mesh_pairing_requests",
      "mesh_link_members",
      "mesh_links",
      "mesh_nodes",
    ]) {
      db.run(`DROP TABLE IF EXISTS ${table}`);
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS mesh_worker_registrations (
      worker_node_id TEXT NOT NULL,
      local_user_id TEXT NOT NULL,
      worker_instance_name TEXT,
      worker_endpoint TEXT NOT NULL,
      worker_transport TEXT NOT NULL DEFAULT 'https',
      worker_public_key TEXT NOT NULL,
      worker_fingerprint TEXT NOT NULL,
      worker_encryption_public_key TEXT,
      worker_directory TEXT,
      worker_capabilities_json TEXT,
      worker_accept_remote_execution INTEGER NOT NULL DEFAULT 1,
      worker_config_revision INTEGER NOT NULL DEFAULT 1,
      grant_status TEXT NOT NULL DEFAULT 'active' CHECK (grant_status IN ('active', 'revoked')),
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (local_user_id, worker_node_id)
      )
    `);

    db.run(`
      CREATE INDEX IF NOT EXISTS idx_mesh_worker_registrations_user
      ON mesh_worker_registrations(local_user_id)
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS mesh_controller_grants (
      controller_node_id TEXT NOT NULL,
      controller_instance_name TEXT,
      controller_public_key TEXT NOT NULL,
      controller_fingerprint TEXT NOT NULL,
      controller_encryption_public_key TEXT,
      grant_status TEXT NOT NULL DEFAULT 'active' CHECK (grant_status IN ('active', 'revoked')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (controller_node_id)
      )
    `);
  });

  migrate();
  const violations = db.query("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(
      `Mesh controller-worker migration left ${String(violations.length)} foreign-key violations.`,
    );
  }
}
