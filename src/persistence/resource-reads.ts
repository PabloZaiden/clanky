/**
 * Metadata-only windows for persisted work collections. Large harness and
 * transcript payloads are counted in storage, never hydrated for these rows.
 */
import { getDatabase } from "./database";
import type { ResourceReadOptions } from "@/contracts/schemas/resource-read";
import { getTranscriptTableConfig } from "./transcripts/table-config";
import { getPersistenceWorkspaceId, requireResourcePersistenceUserId } from "./ownership";
import { DomainError } from "../domain/domain-error";
import type { CollaborationCreator } from "@/shared/collaboration";
import { collaborationCreatorFromRow, collaborationCreatorProjection } from "./collaboration-authorship";

export type WorkReadResource = "chat" | "task" | "agent_run";
export interface StoredWorkReadRow {
  id: string;
  creator?: CollaborationCreator;
  name: string;
  workspaceId: string | null;
  directory: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  lastUserMessageAt: string | null;
  planApproval: number;
  providerID: string | null;
  modelID: string | null;
  variant: string | null;
  currentIteration: number | null;
  pendingQuestions: number;
  pendingPermissions: number;
  pendingInputs: number;
  stateAvailable: number;
  agentId: string | null;
  chatId: string | null;
  taskId: string | null;
  sourceKind: string;
  executionHostId: string | null;
}

interface WorkReadSource {
  resource: WorkReadResource;
  userId: string;
  workspaceId?: string;
  agentId?: string;
  id?: string;
  options?: ResourceReadOptions;
}

const TABLES = { chat: "chats", task: "tasks", agent_run: "agent_runs" } as const;

function sourceWhere(source: WorkReadSource): { clause: string; values: string[] } {
  const kind = source.resource === "agent_run" ? "agent-run" : source.resource;
  const expectedOwner = requireResourcePersistenceUserId(kind, source.id,
    source.workspaceId ?? source.options?.workspaceId);
  if (getPersistenceWorkspaceId() && source.userId !== expectedOwner) {
    throw new DomainError("collaboration_authority_mismatch", "The collection owner does not match workspace authority.");
  }
  if (source.agentId) requireResourcePersistenceUserId("agent", source.agentId);
  const clauses = ["user_id = ?"];
  const values = [source.userId];
  if (source.resource === "chat") clauses.push("deleted_at IS NULL");
  if (source.resource === "chat" && !source.id) clauses.push("scope = 'workspace' AND task_id IS NULL");
  if (source.id) { clauses.push("id = ?"); values.push(source.id); }
  const workspaceId = getPersistenceWorkspaceId() ?? source.workspaceId ?? source.options?.workspaceId;
  if (workspaceId && source.resource !== "agent_run") {
    clauses.push("workspace_id = ?");
    values.push(workspaceId);
  }
  if (source.resource === "agent_run" && source.agentId) {
    clauses.push("agent_id = ?");
    values.push(source.agentId!);
  }
  if (workspaceId && source.resource === "agent_run") {
    clauses.push("agent_id IN (SELECT id FROM agents WHERE workspace_id = ? AND user_id = ?)");
    values.push(workspaceId, source.userId);
  }
  return { clause: clauses.join(" AND "), values };
}

function workQuery(source: WorkReadSource): { sql: string; values: string[] } {
  const where = sourceWhere(source);
  const run = source.resource === "agent_run";
  const task = source.resource === "task";
  const snapshot = "CASE WHEN json_valid(config_snapshot) THEN config_snapshot ELSE '{}' END";
  const storedHarness = run
    ? "(SELECT harness_state_json FROM chats WHERE chats.id = agent_runs.chat_id AND chats.user_id = agent_runs.user_id)"
    : "harness_state_json";
  const harness = `CASE WHEN json_valid(${storedHarness}) THEN ${storedHarness} ELSE '{}' END`;
  const permissions = "CASE WHEN json_valid(pending_permission_requests) THEN pending_permission_requests ELSE '[]' END";
  const pendingQuestions = `(SELECT COUNT(*) FROM json_each(${harness}, '$.questions')
    WHERE json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.status')
      IN ('pending', 'queued', 'submitting', 'unconfirmed'))`;
  const pendingInputs = `(SELECT COUNT(*) FROM json_each(${harness}, '$.inputs')
    WHERE COALESCE(json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.admission.status'), 'unknown')
      NOT IN ('delivered', 'rejected'))`;
  const pendingPermissions = `(SELECT COUNT(*) FROM json_each(${permissions})
    WHERE COALESCE(json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.status'), 'pending') = 'pending')`;
  const harnessAvailable = `(${storedHarness} IS NULL OR (
      json_valid(${storedHarness}) AND json_type(${harness}) = 'object'
    ))
    AND (json_type(${harness}, '$.questions') IS NULL OR json_type(${harness}, '$.questions') = 'array')
    AND (json_type(${harness}, '$.inputs') IS NULL OR json_type(${harness}, '$.inputs') = 'array')
    AND json_extract(${harness}, '$.integrity') IS NOT 'invalid'`;
  const permissionsAvailable = `(pending_permission_requests IS NULL OR (
    json_valid(pending_permission_requests) AND json_type(${permissions}) = 'array'
  ))`;
  const select = run ? `
    json_extract(${snapshot}, '$.name') AS name,
    json_extract(${snapshot}, '$.workspaceId') AS workspaceId,
    json_extract(${snapshot}, '$.directory') AS directory,
    json_extract(${snapshot}, '$.model.providerID') AS providerID,
    json_extract(${snapshot}, '$.model.modelID') AS modelID,
    json_extract(${snapshot}, '$.model.variant') AS variant,
    NULL AS currentIteration, ${pendingQuestions} AS pendingQuestions, ${pendingInputs} AS pendingInputs,
    0 AS planApproval,
    agent_id AS agentId, chat_id AS chatId, NULL AS taskId, 'workspace' AS sourceKind, NULL AS executionHostId,
    ${pendingPermissions} AS pendingPermissions,
    CASE WHEN json_valid(config_snapshot) AND json_type(${snapshot}) = 'object' AND ${harnessAvailable}
      AND ${permissionsAvailable} THEN 1 ELSE 0 END AS stateAvailable
  ` : `
    name, workspace_id AS workspaceId, directory,
    model_provider_id AS providerID, model_model_id AS modelID, model_variant AS variant,
    ${task ? "current_iteration" : "NULL"} AS currentIteration,
    NULL AS agentId, NULL AS chatId,
    ${task ? "NULL" : "task_id"} AS taskId,
    ${task ? "'workspace'" : "source_kind"} AS sourceKind,
    ${task ? "NULL" : "execution_host_id"} AS executionHostId,
    ${pendingQuestions} AS pendingQuestions, ${pendingInputs} AS pendingInputs,
    ${task ? "0" : pendingPermissions} AS pendingPermissions,
    ${task ? "(status = 'planning' AND plan_is_ready = 1 AND auto_accept_plan = 0)" : "0"} AS planApproval,
    CASE WHEN ${harnessAvailable}
      ${task ? "" : `AND ${permissionsAvailable}`}
      THEN 1 ELSE 0 END AS stateAvailable
  `;
  const transcript = getTranscriptTableConfig(source.resource);
  const table = TABLES[source.resource];
  const lastUser = `(SELECT MAX(timestamp) FROM ${transcript.entriesTable} entry
    WHERE entry.${transcript.resourceColumn} = ${table}.id AND entry.user_id = ${table}.user_id
      AND entry.kind = 'message' AND entry.message_role = 'user')`;
  const clauses: string[] = [];
  if (source.options?.name) { clauses.push("name = ? COLLATE NOCASE"); where.values.push(source.options.name); }
  if (source.options?.status) { clauses.push("status = ?"); where.values.push(source.options.status); }
  if (source.options?.needsInput) {
    clauses.push(source.options.needsInput === "true"
      ? "(pendingQuestions + pendingPermissions + planApproval > 0 OR stateAvailable = 0)"
      : "(pendingQuestions + pendingPermissions + planApproval = 0 AND stateAvailable = 1)");
  }
  return { sql: `
    WITH work AS (SELECT id, status, created_at AS createdAt, updated_at AS updatedAt,
      ${run ? "COALESCE(completed_at, started_at, created_at)" : "COALESCE(last_activity_at, created_at)"} AS lastActivityAt,
      ${lastUser} AS lastUserMessageAt,
      ${run ? "NULL AS collaboration_creator_json" : collaborationCreatorProjection(task ? "task" : "chat")}, ${select}
    FROM ${TABLES[source.resource]} WHERE ${where.clause}
    )
    SELECT * FROM work ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY ${source.options?.order === "activity" ? "lastActivityAt" : "createdAt"} DESC, id DESC
  `, values: where.values };
}

export function listWorkReadIds(source: WorkReadSource): string[] {
  const { sql, values } = workQuery(source);
  return (getDatabase().prepare(sql.replace("SELECT * FROM work", "SELECT id FROM work"))
    .all(...values) as Array<{ id: string }>).map((row) => row.id);
}

export function listWorkReadWindow(source: WorkReadSource, position: number, limit: number): StoredWorkReadRow[] {
  const { sql, values } = workQuery(source);
  const rows = getDatabase().prepare(`${sql} LIMIT ? OFFSET ?`)
    .all(...values, limit, position) as Array<StoredWorkReadRow & Record<string, unknown>>;
  return rows.map((row) => {
    const { collaboration_creator_json: _creator, ...metadata } = row;
    return { ...metadata, creator: collaborationCreatorFromRow(row) } as StoredWorkReadRow;
  });
}
