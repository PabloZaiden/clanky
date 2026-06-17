import type { Agent, AgentRun, AgentRunStatus } from "../../types/agent";
import { getDatabase } from "../database";
import {
  agentRunToRow,
  agentToRow,
  rowToAgent,
  rowToAgentRun,
  validateAgentColumnNames,
  validateAgentRunColumnNames,
} from "./helpers";

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
  const row = getDatabase()
    .prepare("SELECT * FROM agents WHERE id = ?")
    .get(agentId) as Record<string, unknown> | null;
  return row ? rowToAgent(row) : null;
}

export async function listAgents(): Promise<Agent[]> {
  const rows = getDatabase()
    .prepare("SELECT * FROM agents ORDER BY created_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToAgent);
}

export async function listAgentsByWorkspace(workspaceId: string): Promise<Agent[]> {
  const rows = getDatabase()
    .prepare("SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at DESC")
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map(rowToAgent);
}

export async function listDueAgents(now: string): Promise<Agent[]> {
  const rows = getDatabase()
    .prepare(`
      SELECT * FROM agents
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `)
    .all(now) as Record<string, unknown>[];
  return rows.map(rowToAgent);
}

export async function deleteAgent(agentId: string): Promise<boolean> {
  const result = getDatabase().prepare("DELETE FROM agents WHERE id = ?").run(agentId);
  return result.changes > 0;
}

export async function saveAgentRun(run: AgentRun): Promise<void> {
  const row = agentRunToRow(run);
  validateAgentRunColumnNames(Object.keys(row));
  const { sql, values } = buildUpsertSql("agent_runs", row);
  getDatabase().prepare(sql).run(...values);
}

export async function loadAgentRun(runId: string): Promise<AgentRun | null> {
  const row = getDatabase()
    .prepare("SELECT * FROM agent_runs WHERE id = ?")
    .get(runId) as Record<string, unknown> | null;
  return row ? rowToAgentRun(row) : null;
}

export async function listAgentRuns(
  agentId: string,
  options: AgentRunListOptions = {},
): Promise<AgentRun[]> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const rows = getDatabase()
    .prepare(`
      SELECT * FROM agent_runs
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(agentId, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToAgentRun);
}

export async function listActiveAgentRuns(agentId: string): Promise<AgentRun[]> {
  const rows = getDatabase()
    .prepare(`
      SELECT * FROM agent_runs
      WHERE agent_id = ? AND status IN ('scheduled', 'starting', 'running')
      ORDER BY created_at DESC
    `)
    .all(agentId) as Record<string, unknown>[];
  return rows.map(rowToAgentRun);
}

export async function deleteAgentRun(runId: string): Promise<boolean> {
  const result = getDatabase().prepare("DELETE FROM agent_runs WHERE id = ?").run(runId);
  return result.changes > 0;
}

export async function deleteAgentRuns(
  agentId: string,
  options: AgentRunPurgeOptions = {},
): Promise<string[]> {
  const clauses = ["agent_id = ?"];
  const values: Array<string> = [agentId];
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

  getDatabase()
    .prepare(`DELETE FROM agent_runs WHERE id IN (${runIds.map(() => "?").join(", ")})`)
    .run(...runIds);
  return runIds;
}

