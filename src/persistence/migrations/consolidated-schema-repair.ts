/**
 * Repairs schema changes that were recorded as historical no-ops during the
 * consolidated baseline transition.
 */

import type { Database } from "bun:sqlite";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  executionHostRefFromParts,
  parseExecutionHostRuntimeSnapshot,
} from "../../shared/execution-host";

const log = createLogger("persistence:migrations:consolidated-schema-repair");

type RepairTableName =
  | "agent_run_transcript_entries"
  | "chat_transcript_entries"
  | "execution_hosts"
  | "mesh_worker_registrations"
  | "preview_sessions"
  | "task_transcript_entries"
  | "workspaces";

const REPAIR_TABLE_NAMES = new Set<RepairTableName>([
  "agent_run_transcript_entries",
  "chat_transcript_entries",
  "execution_hosts",
  "mesh_worker_registrations",
  "preview_sessions",
  "task_transcript_entries",
  "workspaces",
]);

interface TableColumn {
  name: string;
  notnull: number;
}

interface MeshHostRow {
  id: string;
  user_id: string;
  source_id: string;
}

interface MeshRegistrationRow {
  worker_node_id: string;
  local_user_id: string;
  worker_capabilities_json: string | null;
  worker_platform_os: string | null;
  worker_platform_architecture: string | null;
  registration_scope: string;
  workspace_worker_enrollment_id: string | null;
  workspace_id: string | null;
}

interface TranscriptRepair {
  tableName:
    | "agent_run_transcript_entries"
    | "chat_transcript_entries"
    | "task_transcript_entries";
  resourceColumn: "agent_run_id" | "chat_id" | "task_id";
  indexName:
    | "idx_agent_run_transcript_entries_assistant_page"
    | "idx_chat_transcript_entries_assistant_page"
    | "idx_task_transcript_entries_assistant_page";
}

const TRANSCRIPT_REPAIRS: readonly TranscriptRepair[] = [
  {
    tableName: "chat_transcript_entries",
    resourceColumn: "chat_id",
    indexName: "idx_chat_transcript_entries_assistant_page",
  },
  {
    tableName: "agent_run_transcript_entries",
    resourceColumn: "agent_run_id",
    indexName: "idx_agent_run_transcript_entries_assistant_page",
  },
  {
    tableName: "task_transcript_entries",
    resourceColumn: "task_id",
    indexName: "idx_task_transcript_entries_assistant_page",
  },
];

function assertIdentifier(value: string): void {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) {
    throw new Error(`Unsafe schema identifier: "${value}"`);
  }
}

function assertRepairTableName(
  tableName: string,
): asserts tableName is RepairTableName {
  if (!REPAIR_TABLE_NAMES.has(tableName as RepairTableName)) {
    throw new Error(`Unknown repair table: "${tableName}"`);
  }
  assertIdentifier(tableName);
}

function tableExists(db: Database, tableName: RepairTableName): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | null;
  return row !== null;
}

function getTableInfo(
  db: Database,
  tableName: RepairTableName,
): TableColumn[] {
  assertRepairTableName(tableName);
  return db
    .query(`PRAGMA table_info(${tableName})`)
    .all() as TableColumn[];
}

function ensureColumn(
  db: Database,
  tableName: RepairTableName,
  columnName: string,
  definition: string,
): void {
  assertRepairTableName(tableName);
  assertIdentifier(columnName);
  if (!getTableInfo(db, tableName).some((column) => column.name === columnName)) {
    db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function registrationMatchesHost(
  host: MeshHostRow,
  registration: MeshRegistrationRow,
): boolean {
  if (host.user_id !== registration.local_user_id) {
    return false;
  }
  const ref = executionHostRefFromParts("mesh", host.source_id);
  if (
    !ref
    || ref.kind !== "mesh"
    || ref.nodeId !== registration.worker_node_id
  ) {
    return false;
  }
  if (!("scope" in ref)) {
    return registration.registration_scope === "global";
  }
  if (ref.scope === "enrollment") {
    return registration.registration_scope === "workspace"
      && ref.enrollmentId === registration.workspace_worker_enrollment_id;
  }
  return registration.registration_scope === "workspace"
    && ref.workspaceId === registration.workspace_id;
}

function repairExecutionHostRuntimeSnapshots(db: Database): void {
  if (!tableExists(db, "execution_hosts")) {
    return;
  }
  ensureColumn(db, "execution_hosts", "platform_os", "TEXT");
  ensureColumn(db, "execution_hosts", "platform_architecture", "TEXT");
  ensureColumn(
    db,
    "execution_hosts",
    "capabilities_json",
    "TEXT NOT NULL DEFAULT '{}'",
  );

  if (!tableExists(db, "mesh_worker_registrations")) {
    return;
  }
  ensureColumn(
    db,
    "mesh_worker_registrations",
    "worker_platform_os",
    "TEXT",
  );
  ensureColumn(
    db,
    "mesh_worker_registrations",
    "worker_platform_architecture",
    "TEXT",
  );

  const hosts = db.query(`
    SELECT id, user_id, source_id
    FROM execution_hosts
    WHERE kind = 'mesh'
  `).all() as MeshHostRow[];
  const registrations = db.query(`
    SELECT
      worker_node_id,
      local_user_id,
      worker_capabilities_json,
      worker_platform_os,
      worker_platform_architecture,
      registration_scope,
      workspace_worker_enrollment_id,
      workspace_id
    FROM mesh_worker_registrations
  `).all() as MeshRegistrationRow[];
  const updateHost = db.query(`
    UPDATE execution_hosts
    SET platform_os = ?,
        platform_architecture = ?,
        capabilities_json = ?
    WHERE id = ? AND user_id = ?
  `);

  for (const host of hosts) {
    const registration = registrations.find((candidate) =>
      registrationMatchesHost(host, candidate)
    );
    if (!registration) {
      continue;
    }

    let capabilities: unknown;
    try {
      capabilities = JSON.parse(
        registration.worker_capabilities_json ?? "{}",
      ) as unknown;
    } catch (error) {
      log.warn("Skipping invalid Mesh runtime snapshot during schema repair", {
        hostId: host.id,
        workerNodeId: registration.worker_node_id,
        error: String(error),
      });
      continue;
    }
    const runtime = parseExecutionHostRuntimeSnapshot(
      {
        os: registration.worker_platform_os,
        architecture: registration.worker_platform_architecture,
      },
      capabilities,
    );
    if (!runtime) {
      log.warn("Skipping inconsistent Mesh runtime snapshot during schema repair", {
        hostId: host.id,
        workerNodeId: registration.worker_node_id,
      });
      continue;
    }

    updateHost.run(
      runtime.platform?.os ?? null,
      runtime.platform?.architecture ?? null,
      JSON.stringify(runtime.capabilities),
      host.id,
      host.user_id,
    );
  }
}

function repairTranscriptMessageRoles(db: Database): void {
  for (const repair of TRANSCRIPT_REPAIRS) {
    if (!tableExists(db, repair.tableName)) {
      continue;
    }
    ensureColumn(db, repair.tableName, "message_role", "TEXT");
    db.run(`
      UPDATE ${repair.tableName}
      SET message_role = CASE
        WHEN json_valid(payload) = 1 THEN json_extract(payload, '$.role')
        ELSE NULL
      END
      WHERE kind = 'message'
        AND message_role IS NULL
        AND CASE
          WHEN json_valid(payload) = 1 THEN json_extract(payload, '$.role')
          ELSE NULL
        END IN ('user', 'assistant')
    `);
    db.run(`
      CREATE INDEX IF NOT EXISTS ${repair.indexName}
      ON ${repair.tableName}(
        user_id,
        ${repair.resourceColumn},
        timestamp DESC,
        sequence DESC,
        entry_id DESC
      )
      WHERE kind = 'message' AND message_role = 'assistant'
    `);
  }
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

function repairPreviewSessions(db: Database): number {
  const columns = getTableInfo(db, "preview_sessions");
  if (columns.length === 0) {
    return 0;
  }
  const columnNames = new Set(columns.map((column) => column.name));
  const workspaceColumn = columns.find((column) => column.name === "workspace_id");
  const isCanonical = columnNames.has("target_kind")
    && columnNames.has("execution_host_id")
    && columnNames.has("execution_host_revision")
    && workspaceColumn?.notnull === 0;
  if (isCanonical) {
    createPreviewIndexes(db);
    return 0;
  }

  if (!columnNames.has("workspace_id")) {
    throw new Error("Cannot repair preview sessions without workspace associations");
  }
  if (!tableExists(db, "workspaces") || !tableExists(db, "execution_hosts")) {
    throw new Error(
      "Cannot repair preview sessions without workspaces and execution hosts",
    );
  }

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
  if (db.query("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error("Foreign-key violations detected during schema repair");
  }
  return discarded.changes;
}

export function repairConsolidatedSchema(db: Database): void {
  db.run("PRAGMA foreign_keys = OFF");
  db.run("BEGIN IMMEDIATE");
  let discardedPreviewCount = 0;
  try {
    repairExecutionHostRuntimeSnapshots(db);
    repairTranscriptMessageRoles(db);
    discardedPreviewCount = repairPreviewSessions(db);
    db.run("COMMIT");
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

  if (discardedPreviewCount > 0) {
    log.warn("Discarded preview sessions without a current execution-host binding", {
      count: discardedPreviewCount,
    });
  }
}
