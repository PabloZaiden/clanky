import type { Agent, AgentRun, AgentRunStatus } from "@/shared/agent";
import { getDatabase } from "../database";
import {
  agentRunToRow,
  agentToRow,
  rowToAgent,
  rowToAgentRun,
  validateAgentColumnNames,
  validateAgentRunColumnNames,
} from "./helpers";
import { requirePersistenceUserId } from "../ownership";
import {
  hydrateTranscriptStateForUser,
  syncTranscriptEntriesInTransaction,
} from "../transcripts/store";

const DELETE_AGENT_RUN_BATCH_SIZE = 500;
const AGENT_RUN_METADATA_COLUMNS = [
  "id",
  "user_id",
  "agent_id",
  "chat_id",
  "status",
  "trigger",
  "scheduled_for",
  "started_at",
  "completed_at",
  "skip_reason",
  "error_message",
  "error_timestamp",
  "error_code",
  "session_id",
  "session_server_url",
  "worktree_original_branch",
  "worktree_working_branch",
  "worktree_path",
  "pending_permission_requests",
  "config_snapshot",
  "created_at",
  "updated_at",
].join(", ");
const AGENT_RUN_LOAD_COLUMNS = `${AGENT_RUN_METADATA_COLUMNS}, attachments`;

export interface AgentRunListOptions {
  limit?: number;
  offset?: number;
}

export interface AgentRunPurgeOptions {
  before?: string;
  statuses?: AgentRunStatus[];
}

function buildUpsertSql(tableName: "agents" | "agent_runs", row: Record<string, unknown>): {
  sql: string;
  values: (string | number | null | Uint8Array)[];
} {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  const updateColumns = columns.filter((column) => column !== "id");
  const updateClause = updateColumns.map((column) => `${column} = excluded.${column}`).join(", ");
  const values = Object.values(row) as (string | number | null | Uint8Array)[];

  return {
    sql: `
      INSERT INTO ${tableName} (${columns.join(", ")})
      VALUES (${placeholders})
      ON CONFLICT(id) DO UPDATE SET ${updateClause}
      WHERE ${tableName}.user_id = excluded.user_id
    `,
    values,
  };
}

export async function saveAgent(agent: Agent): Promise<void> {
  const row = agentToRow(agent);
  validateAgentColumnNames(Object.keys(row));
  const { sql, values } = buildUpsertSql("agents", row);
  getDatabase().prepare(sql).run(...values);
}

export async function loadAgent(agentId: string): Promise<Agent | null> {
  const userId = requirePersistenceUserId();
  const row = getDatabase()
    .prepare("SELECT * FROM agents WHERE id = ? AND user_id = ?")
    .get(agentId, userId) as Record<string, unknown> | null;
  return row ? rowToAgent(row) : null;
}

export async function listAgents(): Promise<Agent[]> {
  const userId = requirePersistenceUserId();
  const rows = getDatabase()
    .prepare("SELECT * FROM agents WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as Record<string, unknown>[];
  return rows.map(rowToAgent);
}

export async function listAgentsByWorkspace(workspaceId: string): Promise<Agent[]> {
  const userId = requirePersistenceUserId();
  const rows = getDatabase()
    .prepare("SELECT * FROM agents WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC")
    .all(workspaceId, userId) as Record<string, unknown>[];
  return rows.map(rowToAgent);
}

export async function listDueAgents(now: string): Promise<Agent[]> {
  const userId = requirePersistenceUserId();
  const rows = getDatabase()
    .prepare(`
      SELECT * FROM agents
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? AND user_id = ?
      ORDER BY next_run_at ASC
    `)
    .all(now, userId) as Record<string, unknown>[];
  return rows.map(rowToAgent);
}

export async function deleteAgent(agentId: string): Promise<boolean> {
  const result = getDatabase().prepare("DELETE FROM agents WHERE id = ? AND user_id = ?").run(agentId, requirePersistenceUserId());
  return result.changes > 0;
}

export async function saveAgentRun(run: AgentRun): Promise<void> {
  const row = agentRunToRow(run);
  validateAgentRunColumnNames(Object.keys(row));
  const { sql, values } = buildUpsertSql("agent_runs", row);
  const db = getDatabase();
  const userId = String(row["user_id"]);
  db.transaction(() => {
    const previousState = hydrateTranscriptStateForUser("agent_run", run.id, userId);
    db.prepare(sql).run(...values);
    syncTranscriptEntriesInTransaction(
      db,
      "agent_run",
      run.id,
      userId,
      previousState,
      run,
    );
  })();
}

export async function loadAgentRun(runId: string): Promise<AgentRun | null> {
  const userId = requirePersistenceUserId();
  const row = getDatabase()
    .prepare(`SELECT ${AGENT_RUN_LOAD_COLUMNS} FROM agent_runs WHERE id = ? AND user_id = ?`)
    .get(runId, userId) as Record<string, unknown> | null;
  if (!row) {
    return null;
  }

  const run = rowToAgentRun(row);
  const transcript = hydrateTranscriptStateForUser("agent_run", runId, userId);
  run.messages = transcript.messages;
  run.logs = transcript.logs;
  run.toolCalls = transcript.toolCalls;
  return run;
}

/** Load agent-run metadata without parsing transcript or attachment columns. */
export async function loadAgentRunSummary(runId: string): Promise<AgentRun | null> {
  const userId = requirePersistenceUserId();
  const row = getDatabase()
    .prepare(`SELECT ${AGENT_RUN_METADATA_COLUMNS} FROM agent_runs WHERE id = ? AND user_id = ?`)
    .get(runId, userId) as Record<string, unknown> | null;
  if (!row) {
    return null;
  }
  return rowToAgentRun(row);
}

export async function loadAgentRunByChatId(chatId: string): Promise<AgentRun | null> {
  const userId = requirePersistenceUserId();
  const row = getDatabase()
    .prepare(`
      SELECT ${AGENT_RUN_LOAD_COLUMNS} FROM agent_runs
      WHERE chat_id = ? AND user_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(chatId, userId) as Record<string, unknown> | null;
  if (!row) {
    return null;
  }
  const run = rowToAgentRun(row);
  const transcript = hydrateTranscriptStateForUser("agent_run", run.id, userId);
  run.messages = transcript.messages;
  run.logs = transcript.logs;
  run.toolCalls = transcript.toolCalls;
  return run;
}

export async function listAgentRuns(
  agentId: string,
  options: AgentRunListOptions = {},
): Promise<AgentRun[]> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const userId = requirePersistenceUserId();
  const rows = getDatabase()
    .prepare(`
      SELECT ${AGENT_RUN_METADATA_COLUMNS} FROM agent_runs
      WHERE agent_id = ? AND user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(agentId, userId, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToAgentRun);
}

export async function listActiveAgentRuns(agentId: string): Promise<AgentRun[]> {
  const userId = requirePersistenceUserId();
  const rows = getDatabase()
    .prepare(`
      SELECT ${AGENT_RUN_LOAD_COLUMNS} FROM agent_runs
      WHERE agent_id = ? AND user_id = ? AND status IN ('scheduled', 'starting', 'running')
      ORDER BY created_at DESC
    `)
    .all(agentId, userId) as Record<string, unknown>[];
  return rows.map((row) => {
    const run = rowToAgentRun(row);
    const transcript = hydrateTranscriptStateForUser("agent_run", run.id, userId);
    run.messages = transcript.messages;
    run.logs = transcript.logs;
    run.toolCalls = transcript.toolCalls;
    return run;
  });
}

export async function deleteAgentRun(runId: string): Promise<boolean> {
  const result = getDatabase().prepare("DELETE FROM agent_runs WHERE id = ? AND user_id = ?").run(runId, requirePersistenceUserId());
  return result.changes > 0;
}

export async function deleteAgentRuns(
  agentId: string,
  options: AgentRunPurgeOptions = {},
): Promise<string[]> {
  const userId = requirePersistenceUserId();
  const clauses = ["agent_id = ?", "user_id = ?"];
  const values: Array<string> = [agentId, userId];
  if (options.before) {
    clauses.push("created_at < ?");
    values.push(options.before);
  }
  if (options.statuses && options.statuses.length > 0) {
    clauses.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
    values.push(...options.statuses);
  }

  const where = clauses.join(" AND ");
  const rows = getDatabase()
    .prepare(`SELECT id FROM agent_runs WHERE ${where}`)
    .all(...values) as Array<{ id: string }>;
  const runIds = rows.map((row) => row.id);
  if (runIds.length === 0) {
    return [];
  }

  const db = getDatabase();
  for (let index = 0; index < runIds.length; index += DELETE_AGENT_RUN_BATCH_SIZE) {
    const batch = runIds.slice(index, index + DELETE_AGENT_RUN_BATCH_SIZE);
    db.prepare(`DELETE FROM agent_runs WHERE user_id = ? AND id IN (${batch.map(() => "?").join(", ")})`)
      .run(userId, ...batch);
  }
  return runIds;
}
