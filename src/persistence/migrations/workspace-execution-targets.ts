/**
 * Migration v47: separate auto-provisioning hosts from workspace SSH targets.
 */

import type { Database } from "bun:sqlite";
import { WORKSPACE_SSH_TARGET_SOURCE_PREFIX } from "../../shared/execution-host";

const MISSING_TARGET_KEY_PREFIX = "workspace-target-missing:";
const MIGRATION_TABLE_NAMES = new Set(["chats", "terminal_sessions", "workspaces"]);

function assertMigrationTableName(tableName: string): void {
  if (!MIGRATION_TABLE_NAMES.has(tableName)) {
    throw new Error(`Unknown workspace execution target migration table: ${tableName}`);
  }
}

function addColumnIfMissing(
  db: Database,
  tableName: string,
  columns: Set<string>,
  definition: string,
): void {
  assertMigrationTableName(tableName);
  const columnName = definition.split(" ")[0]!;
  if (!columns.has(columnName)) {
    db.run(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
    columns.add(columnName);
  }
}

function getColumns(db: Database, tableName: string): Set<string> {
  assertMigrationTableName(tableName);
  return new Set(
    (db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
}

function createWorkspaceExecutionTargetTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_execution_targets (
      workspace_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      host TEXT,
      port INTEGER,
      username TEXT,
      password_ciphertext TEXT,
      target_key TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_workspace_execution_targets_user
    ON workspace_execution_targets(user_id, updated_at DESC)
  `);
}

function ensureMissingTarget(
  db: Database,
  workspace: {
    id: string;
    user_id: string;
    created_at: string;
    updated_at: string;
  },
): void {
  db.run(`
    INSERT INTO workspace_execution_targets (
      workspace_id, user_id, host, port, username, password_ciphertext,
      target_key, revision, created_at, updated_at
    ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, 1, ?, ?)
    ON CONFLICT(workspace_id) DO NOTHING
  `, [
    workspace.id,
    workspace.user_id,
    `${MISSING_TARGET_KEY_PREFIX}${workspace.id}`,
    workspace.created_at,
    workspace.updated_at,
  ]);
}

export function migrateWorkspaceExecutionTargets(db: Database): void {
  const workspaceColumns = getColumns(db, "workspaces");
  addColumnIfMissing(
    db,
    "workspaces",
    workspaceColumns,
    "provisioning_host_id TEXT REFERENCES execution_hosts(id) ON DELETE SET NULL",
  );
  addColumnIfMissing(
    db,
    "workspaces",
    workspaceColumns,
    "provisioning_host_revision INTEGER",
  );
  createWorkspaceExecutionTargetTable(db);

  const rows = db.query(`
    SELECT
      workspace.id,
      workspace.user_id,
      workspace.created_at,
      workspace.updated_at,
      workspace.source_directory,
      workspace.execution_host_id,
      workspace.execution_host_revision,
      execution_host.kind AS execution_host_kind,
      execution_host.source_id AS execution_host_source_id,
      execution_host.revision AS execution_host_registry_revision
    FROM workspaces workspace
    LEFT JOIN execution_hosts execution_host
      ON execution_host.id = workspace.execution_host_id
      AND execution_host.user_id = workspace.user_id
    WHERE workspace.source_directory IS NOT NULL
  `).all() as Array<{
    id: string;
    user_id: string;
    created_at: string;
    updated_at: string;
    source_directory: string | null;
    execution_host_id: string | null;
    execution_host_revision: number | null;
    execution_host_kind: string | null;
    execution_host_source_id: string | null;
    execution_host_registry_revision: number | null;
  }>;

  for (const workspace of rows) {
    if (
      workspace.execution_host_kind !== "ssh"
      || !workspace.execution_host_id
      || !workspace.execution_host_source_id
      || workspace.execution_host_source_id.startsWith(WORKSPACE_SSH_TARGET_SOURCE_PREFIX)
    ) {
      continue;
    }

    const directSourceId = `${WORKSPACE_SSH_TARGET_SOURCE_PREFIX}${workspace.id}`;
    ensureMissingTarget(db, workspace);

    const existingDirectHost = db.query(`
      SELECT id, revision
      FROM execution_hosts
      WHERE user_id = ? AND kind = 'ssh' AND source_id = ?
      LIMIT 1
    `).get(workspace.user_id, directSourceId) as {
      id: string;
      revision: number;
    } | null;

    const directHost = existingDirectHost ?? (() => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.run(`
        INSERT INTO execution_hosts (
          id, user_id, kind, source_id, target_key, revision,
          revoked_at, created_at, updated_at
        )
        SELECT ?, ?, 'ssh', ?, target_key, 1, NULL, ?, ?
        FROM workspace_execution_targets
        WHERE workspace_id = ? AND user_id = ?
      `, [
        id,
        workspace.user_id,
        directSourceId,
        now,
        now,
        workspace.id,
        workspace.user_id,
      ]);
      return {
        id,
        revision: 1,
      };
    })();

    const provisioningRevision = Math.max(
      1,
      Math.floor(
        workspace.execution_host_revision
        ?? workspace.execution_host_registry_revision
        ?? 1,
      ),
    );
    db.run(`
      UPDATE workspaces
      SET
        provisioning_host_id = COALESCE(provisioning_host_id, ?),
        provisioning_host_revision = COALESCE(provisioning_host_revision, ?),
        execution_host_id = ?,
        execution_host_revision = ?
      WHERE id = ? AND user_id = ?
    `, [
      workspace.execution_host_id,
      provisioningRevision,
      directHost.id,
      directHost.revision,
      workspace.id,
      workspace.user_id,
    ]);

    for (const tableName of ["terminal_sessions", "chats"]) {
      assertMigrationTableName(tableName);
      db.run(`
        UPDATE ${tableName}
        SET execution_host_id = ?, execution_host_revision = ?
        WHERE workspace_id = ? AND user_id = ?
      `, [
        directHost.id,
        directHost.revision,
        workspace.id,
        workspace.user_id,
      ]);
    }
  }
}
