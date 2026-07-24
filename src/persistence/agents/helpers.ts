import type { Agent, AgentConfig, AgentConfigSnapshot, AgentRun, AgentState } from "@/shared/agent";
import { createLogger } from "@pablozaiden/webapp/server";
import { requirePersistenceUserId } from "../ownership";

const log = createLogger("persistence:agents");

export const ALLOWED_AGENT_COLUMNS = new Set([
  "id",
  "user_id",
  "name",
  "workspace_id",
  "directory",
  "prompt",
  "code",
  "model_provider_id",
  "model_model_id",
  "model_variant",
  "base_branch",
  "use_worktree",
  "schedule_start_at_local",
  "schedule_timezone",
  "schedule_interval_value",
  "schedule_interval_unit",
  "schedule_next_run_at",
  "enabled",
  "mode",
  "created_at",
  "updated_at",
  "is_private",
  "status",
  "last_run_at",
  "next_run_at",
  "last_skipped_at",
  "last_error_message",
  "last_error_timestamp",
  "last_error_code",
  "active_run_id",
]);

export const ALLOWED_AGENT_RUN_COLUMNS = new Set([
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
  "attachments",
  "config_snapshot",
  "created_at",
  "updated_at",
]);

export function validateAgentColumnNames(columns: string[]): void {
  for (const column of columns) {
    if (!ALLOWED_AGENT_COLUMNS.has(column)) {
      throw new Error(`Invalid agent column name: ${column}`);
    }
  }
}

export function validateAgentRunColumnNames(columns: string[]): void {
  for (const column of columns) {
    if (!ALLOWED_AGENT_RUN_COLUMNS.has(column)) {
      throw new Error(`Invalid agent run column name: ${column}`);
    }
  }
}

export function safeJsonParse<T>(json: string, fallback: T, fieldName: string, rowId: unknown): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    log.warn(`Failed to parse JSON in field "${fieldName}" for agent row ${String(rowId)}: ${String(error)}`);
    return fallback;
  }
}

function requireString(row: Record<string, unknown>, columnName: string, rowId: unknown): string {
  const value = row[columnName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid agent row ${String(rowId)}: ${columnName} is required`);
  }
  return value;
}

export function agentToRow(agent: Agent): Record<string, unknown> {
  const { config, state } = agent;
  return {
    id: config.id,
    user_id: requirePersistenceUserId(),
    name: config.name,
    workspace_id: config.workspaceId,
    directory: config.directory,
    prompt: config.prompt,
    code: config.code ?? null,
    model_provider_id: config.model.providerID,
    model_model_id: config.model.modelID,
    model_variant: config.model.variant ?? null,
    base_branch: config.baseBranch ?? null,
    use_worktree: config.useWorktree ? 1 : 0,
    schedule_start_at_local: config.schedule.startAtLocal,
    schedule_timezone: config.schedule.timezone,
    schedule_interval_value: config.schedule.interval.value,
    schedule_interval_unit: config.schedule.interval.unit,
    schedule_next_run_at: config.schedule.nextRunAt,
    enabled: config.enabled ? 1 : 0,
    mode: config.mode,
    created_at: config.createdAt,
    updated_at: config.updatedAt,
    is_private: config.isPrivate ? 1 : 0,
    status: state.status,
    last_run_at: state.lastRunAt ?? null,
    next_run_at: state.nextRunAt ?? null,
    last_skipped_at: state.lastSkippedAt ?? null,
    last_error_message: state.lastError?.message ?? null,
    last_error_timestamp: state.lastError?.timestamp ?? null,
    last_error_code: state.lastError?.code ?? null,
    active_run_id: state.activeRunId ?? null,
  };
}

export function rowToAgent(row: Record<string, unknown>): Agent {
  const rowId = row["id"];
  const config: AgentConfig = {
    id: requireString(row, "id", rowId),
    name: requireString(row, "name", rowId),
    workspaceId: requireString(row, "workspace_id", rowId),
    directory: requireString(row, "directory", rowId),
    prompt: requireString(row, "prompt", rowId),
    code: typeof row["code"] === "string" && row["code"].trim().length > 0 ? row["code"] : undefined,
    model: {
      providerID: requireString(row, "model_provider_id", rowId),
      modelID: requireString(row, "model_model_id", rowId),
      variant: (row["model_variant"] as string | null) ?? "",
    },
    baseBranch: (row["base_branch"] as string | null) ?? undefined,
    useWorktree: row["use_worktree"] === 1,
    schedule: {
      startAtLocal: requireString(row, "schedule_start_at_local", rowId),
      timezone: requireString(row, "schedule_timezone", rowId),
      interval: {
        value: row["schedule_interval_value"] as number,
        unit: row["schedule_interval_unit"] as AgentConfig["schedule"]["interval"]["unit"],
      },
      nextRunAt: requireString(row, "schedule_next_run_at", rowId),
    },
    enabled: row["enabled"] === 1,
    createdAt: requireString(row, "created_at", rowId),
    updatedAt: requireString(row, "updated_at", rowId),
    isPrivate: row["is_private"] === 1,
    mode: "agent",
  };

  const state: AgentState = {
    id: config.id,
    status: row["status"] as AgentState["status"],
    lastRunAt: (row["last_run_at"] as string | null) ?? undefined,
    nextRunAt: (row["next_run_at"] as string | null) ?? undefined,
    lastSkippedAt: (row["last_skipped_at"] as string | null) ?? undefined,
    activeRunId: (row["active_run_id"] as string | null) ?? undefined,
  };

  if (row["last_error_message"] !== null && row["last_error_message"] !== undefined) {
    state.lastError = {
      message: row["last_error_message"] as string,
      timestamp: (row["last_error_timestamp"] as string | null) ?? new Date(0).toISOString(),
      code: (row["last_error_code"] as string | null) ?? undefined,
    };
  }

  return { config, state };
}

export function agentRunToRow(run: AgentRun): Record<string, unknown> {
  return {
    id: run.id,
    user_id: requirePersistenceUserId(),
    agent_id: run.agentId,
    chat_id: run.chatId ?? null,
    status: run.status,
    trigger: run.trigger,
    scheduled_for: run.scheduledFor,
    started_at: run.startedAt ?? null,
    completed_at: run.completedAt ?? null,
    skip_reason: run.skipReason ?? null,
    error_message: run.error?.message ?? null,
    error_timestamp: run.error?.timestamp ?? null,
    error_code: run.error?.code ?? null,
    session_id: run.session?.id ?? null,
    session_server_url: run.session?.serverUrl ?? null,
    worktree_original_branch: run.worktree?.originalBranch ?? null,
    worktree_working_branch: run.worktree?.workingBranch ?? null,
    worktree_path: run.worktree?.worktreePath ?? null,
    pending_permission_requests: JSON.stringify(run.pendingPermissionRequests ?? []),
    attachments: JSON.stringify(run.attachments ?? []),
    config_snapshot: JSON.stringify(run.configSnapshot),
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

export function rowToAgentRun(row: Record<string, unknown>): AgentRun {
  const rowId = row["id"];
  const snapshotFallback: AgentConfigSnapshot = {
    name: "Unknown agent",
    workspaceId: "",
    directory: "",
    prompt: "",
    code: undefined,
    model: {
      providerID: "unknown",
      modelID: "not-configured",
      variant: "",
    },
    useWorktree: true,
    schedule: {
      startAtLocal: new Date(0).toISOString(),
      timezone: "UTC",
      interval: {
        value: 1,
        unit: "hours",
      },
      nextRunAt: new Date(0).toISOString(),
    },
  };

  const run: AgentRun = {
    id: requireString(row, "id", rowId),
    agentId: requireString(row, "agent_id", rowId),
    chatId: (row["chat_id"] as string | null) ?? undefined,
    status: row["status"] as AgentRun["status"],
    trigger: row["trigger"] as AgentRun["trigger"],
    scheduledFor: requireString(row, "scheduled_for", rowId),
    startedAt: (row["started_at"] as string | null) ?? undefined,
    completedAt: (row["completed_at"] as string | null) ?? undefined,
    skipReason: (row["skip_reason"] as string | null) ?? undefined,
    messages: row["messages"] ? safeJsonParse(row["messages"] as string, [], "messages", rowId) : [],
    logs: row["logs"] ? safeJsonParse(row["logs"] as string, [], "logs", rowId) : [],
    toolCalls: row["tool_calls"] ? safeJsonParse(row["tool_calls"] as string, [], "tool_calls", rowId) : [],
    pendingPermissionRequests: row["pending_permission_requests"]
      ? safeJsonParse(row["pending_permission_requests"] as string, [], "pending_permission_requests", rowId)
      : [],
    attachments: row["attachments"] ? safeJsonParse(row["attachments"] as string, [], "attachments", rowId) : [],
    configSnapshot: row["config_snapshot"]
      ? safeJsonParse(row["config_snapshot"] as string, snapshotFallback, "config_snapshot", rowId)
      : snapshotFallback,
    createdAt: requireString(row, "created_at", rowId),
    updatedAt: requireString(row, "updated_at", rowId),
  };

  if (row["error_message"] !== null && row["error_message"] !== undefined) {
    run.error = {
      message: row["error_message"] as string,
      timestamp: (row["error_timestamp"] as string | null) ?? new Date(0).toISOString(),
      code: (row["error_code"] as string | null) ?? undefined,
    };
  }

  if (row["session_id"] !== null && row["session_id"] !== undefined) {
    run.session = {
      id: row["session_id"] as string,
      serverUrl: (row["session_server_url"] as string | null) ?? undefined,
    };
  }

  if (
    row["worktree_original_branch"] !== null
    && row["worktree_original_branch"] !== undefined
    && row["worktree_working_branch"] !== null
    && row["worktree_working_branch"] !== undefined
  ) {
    run.worktree = {
      originalBranch: row["worktree_original_branch"] as string,
      workingBranch: row["worktree_working_branch"] as string,
      worktreePath: (row["worktree_path"] as string | null) ?? undefined,
    };
  }

  return run;
}
