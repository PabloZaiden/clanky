/**
 * Authoritative metadata for tables that Clanky creates, inspects, or resets.
 *
 * This module deliberately describes table ownership and lifecycle capabilities
 * without copying schema definitions owned by Clanky or the webapp framework.
 * A new table added by a base schema or migration must be classified here.
 */

import type { Database } from "bun:sqlite";

export type SchemaTableCategory =
  | "clanky"
  | "framework"
  | "metadata";

export type SchemaTranscriptResource = "chat" | "task" | "agent_run";
export type SchemaTranscriptTableRole = "entries" | "meta";

export interface SchemaTranscriptTableMetadata {
  readonly resource: SchemaTranscriptResource;
  readonly role: SchemaTranscriptTableRole;
  readonly parentTable: "chats" | "tasks" | "agent_runs";
  readonly resourceColumn: "chat_id" | "task_id" | "agent_run_id";
}

export interface SchemaTableDefinition {
  readonly name: string;
  readonly category: SchemaTableCategory;
  readonly expectedInFreshSchema: boolean;
  readonly introspectable: boolean;
  readonly resettable: boolean;
  readonly transcript?: SchemaTranscriptTableMetadata;
}

function currentTable(
  name: string,
  category: "clanky" | "framework" | "metadata",
  transcript?: SchemaTranscriptTableMetadata,
): SchemaTableDefinition {
  return {
    name,
    category,
    expectedInFreshSchema: true,
    introspectable: true,
    resettable: true,
    ...(transcript ? { transcript } : {}),
  };
}

function resetOnlyTable(
  name: string,
  category: "framework",
): SchemaTableDefinition {
  return {
    name,
    category,
    expectedInFreshSchema: false,
    introspectable: false,
    resettable: true,
  };
}

export const SCHEMA_TABLE_INVENTORY: readonly SchemaTableDefinition[] = [
  resetOnlyTable("webapp_audit_events", "framework"),
  resetOnlyTable("webapp_user_setup_links", "framework"),
  resetOnlyTable("webapp_preferences", "framework"),
  currentTable("webapp_refresh_sessions", "framework"),
  currentTable("webapp_device_auth_requests", "framework"),
  currentTable("webapp_api_keys", "framework"),
  currentTable("webapp_passkeys", "framework"),
  resetOnlyTable("webapp_signing_keys", "framework"),
  currentTable("webapp_users", "framework"),

  currentTable("mesh_enrollment_tokens", "clanky"),
  currentTable("mesh_worker_kill_nonces", "clanky"),
  currentTable("mesh_worker_registrations", "clanky"),
  currentTable("mesh_controller_grants", "clanky"),
  currentTable("mesh_controller_relay_pairing", "clanky"),
  currentTable("mesh_node_identity", "clanky"),

  currentTable("workspace_worker_enrollments", "clanky"),
  currentTable("workspace_execution_targets", "clanky"),
  currentTable("clanky_context_api_keys", "clanky"),
  currentTable("preview_sessions", "clanky"),
  currentTable("agent_run_transcript_meta", "clanky", {
    resource: "agent_run",
    role: "meta",
    parentTable: "agent_runs",
    resourceColumn: "agent_run_id",
  }),
  currentTable("agent_run_transcript_entries", "clanky", {
    resource: "agent_run",
    role: "entries",
    parentTable: "agent_runs",
    resourceColumn: "agent_run_id",
  }),
  currentTable("agent_runs", "clanky"),
  currentTable("agents", "clanky"),
  currentTable("review_comments", "clanky"),
  currentTable("sessions", "clanky"),
  currentTable("terminal_sessions", "clanky"),
  currentTable("provisioning_job_logs", "clanky"),
  currentTable("provisioning_jobs", "clanky"),
  currentTable("task_transcript_meta", "clanky", {
    resource: "task",
    role: "meta",
    parentTable: "tasks",
    resourceColumn: "task_id",
  }),
  currentTable("task_transcript_entries", "clanky", {
    resource: "task",
    role: "entries",
    parentTable: "tasks",
    resourceColumn: "task_id",
  }),
  currentTable("tasks", "clanky"),
  currentTable("chat_transcript_meta", "clanky", {
    resource: "chat",
    role: "meta",
    parentTable: "chats",
    resourceColumn: "chat_id",
  }),
  currentTable("chat_transcript_entries", "clanky", {
    resource: "chat",
    role: "entries",
    parentTable: "chats",
    resourceColumn: "chat_id",
  }),
  currentTable("chats", "clanky"),
  currentTable("ssh_servers", "clanky"),
  currentTable("workspaces", "clanky"),
  currentTable("execution_hosts", "clanky"),
  currentTable("preferences", "clanky"),
  currentTable("schema_migrations", "metadata"),
] as const;

const inventoryNames = new Set<string>();
for (const table of SCHEMA_TABLE_INVENTORY) {
  if (inventoryNames.has(table.name)) {
    throw new Error(`Duplicate schema table inventory entry: ${table.name}`);
  }
  inventoryNames.add(table.name);
}

const FRESH_SCHEMA_TABLE_NAMES = Object.freeze(
  SCHEMA_TABLE_INVENTORY.filter(
    (table) => table.expectedInFreshSchema,
  ).map((table) => table.name),
);
const INTROSPECTABLE_TABLE_NAMES = Object.freeze(
  SCHEMA_TABLE_INVENTORY.filter((table) => table.introspectable).map(
    (table) => table.name,
  ),
);
const RESETTABLE_TABLE_NAMES = Object.freeze(
  SCHEMA_TABLE_INVENTORY.filter((table) => table.resettable).map(
    (table) => table.name,
  ),
);
const NON_FRESH_TABLE_NAMES = new Set(
  SCHEMA_TABLE_INVENTORY.filter(
    (table) => !table.expectedInFreshSchema,
  ).map((table) => table.name),
);
const INTROSPECTABLE_TABLE_NAME_SET = new Set(INTROSPECTABLE_TABLE_NAMES);

export function getFreshSchemaTableNames(): readonly string[] {
  return FRESH_SCHEMA_TABLE_NAMES;
}

export function getIntrospectableTableNames(): readonly string[] {
  return INTROSPECTABLE_TABLE_NAMES;
}

export function getResettableTableNames(): readonly string[] {
  return RESETTABLE_TABLE_NAMES;
}

export function isIntrospectableTableName(tableName: string): boolean {
  return INTROSPECTABLE_TABLE_NAME_SET.has(tableName);
}

/**
 * Verifies that all current tables exist and that no unknown user table has
 * been introduced. Known reset-only framework tables are allowed to remain
 * until the next database reset.
 */
export function assertSchemaInventory(db: Database): void {
  const actualTableNames = (
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
  const actualTableNameSet = new Set(actualTableNames);
  const expectedTableNames = getFreshSchemaTableNames();

  const missingTableNames = expectedTableNames.filter(
    (tableName) => !actualTableNameSet.has(tableName),
  );
  const unexpectedTableNames = actualTableNames.filter(
    (tableName) =>
      !inventoryNames.has(tableName) && !NON_FRESH_TABLE_NAMES.has(tableName),
  );

  if (missingTableNames.length === 0 && unexpectedTableNames.length === 0) {
    return;
  }

  const details: string[] = [];
  if (missingTableNames.length > 0) {
    details.push(`missing tables: ${missingTableNames.join(", ")}`);
  }
  if (unexpectedTableNames.length > 0) {
    details.push(`unexpected tables: ${unexpectedTableNames.join(", ")}`);
  }
  throw new Error(`Database schema inventory mismatch (${details.join("; ")})`);
}
