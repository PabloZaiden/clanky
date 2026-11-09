import type { Automation, AutomationRun, AutomationRunStatus } from "@/shared/automation";
import type { TranscriptChangeSet } from "@/shared";
import { getDatabase } from "../database";
import {
  automationRunToRow,
  automationToRow,
  rowToAutomation,
  rowToAutomationRun,
  validateAutomationColumnNames,
  validateAutomationRunColumnNames,
} from "./helpers";
import { requireResourcePersistenceUserId, workspacePersistenceParameters } from "../ownership";
import { automationRunTranscriptStore } from "../transcripts/automation-run-store";

const DELETE_AUTOMATION_RUN_BATCH_SIZE = 500;
const AUTOMATION_RUN_METADATA_COLUMNS = [
  "id",
  "user_id",
  "automation_id",
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
  "usage_json",
  "worktree_original_branch",
  "worktree_working_branch",
  "worktree_path",
  "pending_permission_requests",
  "config_snapshot",
  "created_at",
  "updated_at",
].join(", ");
const AUTOMATION_RUN_LOAD_COLUMNS = `${AUTOMATION_RUN_METADATA_COLUMNS}, attachments`;

export interface AutomationRunListOptions {
  limit?: number;
  offset?: number;
}

export interface AutomationRunPurgeOptions {
  before?: string;
  statuses?: AutomationRunStatus[];
}

function buildUpsertSql(tableName: "automations" | "automation_runs", row: Record<string, unknown>): {
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

export async function saveAutomation(automation: Automation): Promise<void> {
  const row = automationToRow(automation);
  validateAutomationColumnNames(Object.keys(row));
  const { sql, values } = buildUpsertSql("automations", row);
  getDatabase().prepare(sql).run(...values);
}

export async function loadAutomation(automationId: string): Promise<Automation | null> {
  const userId = requireResourcePersistenceUserId("automation", automationId);
  const row = getDatabase()
    .prepare("SELECT * FROM automations WHERE id = ? AND user_id = ?")
    .get(automationId, userId) as Record<string, unknown> | null;
  return row ? rowToAutomation(row) : null;
}

export async function listAutomations(): Promise<Automation[]> {
  const userId = requireResourcePersistenceUserId("automation");
  const rows = getDatabase()
    .prepare("SELECT * FROM automations WHERE user_id = ? AND (? IS NULL OR workspace_id = ?) ORDER BY created_at DESC")
    .all(userId, ...workspacePersistenceParameters()) as Record<string, unknown>[];
  return rows.map(rowToAutomation);
}

export async function listAutomationsByWorkspace(workspaceId: string): Promise<Automation[]> {
  const userId = requireResourcePersistenceUserId("automation", undefined, workspaceId);
  const rows = getDatabase()
    .prepare("SELECT * FROM automations WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC")
    .all(workspaceId, userId) as Record<string, unknown>[];
  return rows.map(rowToAutomation);
}

export async function listDueAutomations(now: string): Promise<Automation[]> {
  const userId = requireResourcePersistenceUserId("automation");
  const rows = getDatabase()
    .prepare(`
      SELECT * FROM automations
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? AND user_id = ? AND (? IS NULL OR workspace_id = ?)
      ORDER BY next_run_at ASC
    `)
    .all(now, userId, ...workspacePersistenceParameters()) as Record<string, unknown>[];
  return rows.map(rowToAutomation);
}

export async function deleteAutomation(automationId: string): Promise<boolean> {
  const userId = requireResourcePersistenceUserId("automation", automationId);
  const result = getDatabase().prepare("DELETE FROM automations WHERE id = ? AND user_id = ?").run(automationId, userId);
  return result.changes > 0;
}

export interface SaveAutomationRunOptions {
  previousState?: Pick<AutomationRun, "messages" | "logs" | "toolCalls">;
  transcriptChanges?: TranscriptChangeSet;
}

export async function saveAutomationRun(run: AutomationRun, options: SaveAutomationRunOptions = {}): Promise<void> {
  requireResourcePersistenceUserId("automation-run", run.id, run.configSnapshot.workspaceId);
  const row = automationRunToRow(run);
  validateAutomationRunColumnNames(Object.keys(row));
  const { sql, values } = buildUpsertSql("automation_runs", row);
  const db = getDatabase();
  const userId = String(row["user_id"]);
  db.transaction(() => {
    db.prepare(sql).run(...values);
    if (options.transcriptChanges) {
      automationRunTranscriptStore.applyChangeSetInTransaction(
        db,
        run.id,
        userId,
        options.transcriptChanges,
      );
    } else {
      const previousState = options.previousState ?? automationRunTranscriptStore.hydrateForUser(run.id, userId);
      automationRunTranscriptStore.syncInTransaction(
        db,
        run.id,
        userId,
        previousState,
        run,
      );
    }
  })();
}

export async function loadAutomationRun(runId: string): Promise<AutomationRun | null> {
  const userId = requireResourcePersistenceUserId("automation-run", runId);
  const row = getDatabase()
    .prepare(`SELECT ${AUTOMATION_RUN_LOAD_COLUMNS} FROM automation_runs WHERE id = ? AND user_id = ?`)
    .get(runId, userId) as Record<string, unknown> | null;
  if (!row) {
    return null;
  }

  const run = rowToAutomationRun(row);
  const transcript = automationRunTranscriptStore.hydrateForUser(runId, userId);
  run.messages = transcript.messages;
  run.logs = transcript.logs;
  run.toolCalls = transcript.toolCalls;
  return run;
}

/** Load automation-run metadata without parsing transcript or attachment columns. */
export async function loadAutomationRunSummary(runId: string): Promise<AutomationRun | null> {
  const userId = requireResourcePersistenceUserId("automation-run", runId);
  const row = getDatabase()
    .prepare(`SELECT ${AUTOMATION_RUN_METADATA_COLUMNS} FROM automation_runs WHERE id = ? AND user_id = ?`)
    .get(runId, userId) as Record<string, unknown> | null;
  if (!row) {
    return null;
  }
  return rowToAutomationRun(row);
}

export async function loadAutomationRunSummaryByChatId(chatId: string): Promise<AutomationRun | null> {
  const userId = requireResourcePersistenceUserId("chat", chatId);
  const row = getDatabase()
    .prepare(`
      SELECT ${AUTOMATION_RUN_METADATA_COLUMNS} FROM automation_runs
      WHERE chat_id = ? AND user_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(chatId, userId) as Record<string, unknown> | null;
  if (!row) {
    return null;
  }
  return rowToAutomationRun(row);
}

export async function listAutomationRuns(
  automationId: string,
  options: AutomationRunListOptions = {},
): Promise<AutomationRun[]> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const userId = requireResourcePersistenceUserId("automation", automationId);
  const rows = getDatabase()
    .prepare(`
      SELECT ${AUTOMATION_RUN_METADATA_COLUMNS} FROM automation_runs
      WHERE automation_id = ? AND user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(automationId, userId, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToAutomationRun);
}

export async function listActiveAutomationRuns(automationId: string): Promise<AutomationRun[]> {
  const userId = requireResourcePersistenceUserId("automation", automationId);
  const rows = getDatabase()
    .prepare(`
      SELECT ${AUTOMATION_RUN_LOAD_COLUMNS} FROM automation_runs
      WHERE automation_id = ? AND user_id = ? AND status IN ('scheduled', 'starting', 'running')
      ORDER BY created_at DESC
    `)
    .all(automationId, userId) as Record<string, unknown>[];
  return rows.map((row) => {
    const run = rowToAutomationRun(row);
    const transcript = automationRunTranscriptStore.hydrateForUser(run.id, userId);
    run.messages = transcript.messages;
    run.logs = transcript.logs;
    run.toolCalls = transcript.toolCalls;
    return run;
  });
}

export async function deleteAutomationRun(runId: string): Promise<boolean> {
  const userId = requireResourcePersistenceUserId("automation-run", runId);
  const result = getDatabase().prepare("DELETE FROM automation_runs WHERE id = ? AND user_id = ?").run(runId, userId);
  return result.changes > 0;
}

export async function deleteAutomationRuns(
  automationId: string,
  options: AutomationRunPurgeOptions = {},
): Promise<string[]> {
  const userId = requireResourcePersistenceUserId("automation", automationId);
  const clauses = ["automation_id = ?", "user_id = ?"];
  const values: Array<string> = [automationId, userId];
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
    .prepare(`SELECT id FROM automation_runs WHERE ${where}`)
    .all(...values) as Array<{ id: string }>;
  const runIds = rows.map((row) => row.id);
  if (runIds.length === 0) {
    return [];
  }

  const db = getDatabase();
  for (let index = 0; index < runIds.length; index += DELETE_AUTOMATION_RUN_BATCH_SIZE) {
    const batch = runIds.slice(index, index + DELETE_AUTOMATION_RUN_BATCH_SIZE);
    db.prepare(`DELETE FROM automation_runs WHERE user_id = ? AND id IN (${batch.map(() => "?").join(", ")})`)
      .run(userId, ...batch);
  }
  return runIds;
}
