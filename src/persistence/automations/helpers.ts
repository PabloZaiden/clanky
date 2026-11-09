import type { Automation, AutomationConfig, AutomationConfigSnapshot, AutomationRun, AutomationState } from "@/shared/automation";
import { createLogger } from "@pablozaiden/webapp/server";
import { requireResourcePersistenceUserId } from "../ownership";
import { parseStoredTokenUsage } from "../harness-usage";

const log = createLogger("persistence:automations");

export const ALLOWED_AUTOMATION_COLUMNS = new Set([
  "id",
  "user_id",
  "name",
  "workspace_id",
  "directory",
  "prompt",
  "code",
  "generation_chat_id",
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

export const ALLOWED_AUTOMATION_RUN_COLUMNS = new Set([
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
  "worktree_original_branch",
  "worktree_working_branch",
  "worktree_path",
  "pending_permission_requests",
  "attachments",
  "config_snapshot",
  "created_at",
  "updated_at",
]);

export function validateAutomationColumnNames(columns: string[]): void {
  for (const column of columns) {
    if (!ALLOWED_AUTOMATION_COLUMNS.has(column)) {
      throw new Error(`Invalid automation column name: ${column}`);
    }
  }
}

export function validateAutomationRunColumnNames(columns: string[]): void {
  for (const column of columns) {
    if (!ALLOWED_AUTOMATION_RUN_COLUMNS.has(column)) {
      throw new Error(`Invalid automation run column name: ${column}`);
    }
  }
}

export function safeJsonParse<T>(json: string, fallback: T, fieldName: string, rowId: unknown): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    log.warn(`Failed to parse JSON in field "${fieldName}" for automation row ${String(rowId)}: ${String(error)}`);
    return fallback;
  }
}

function requireString(row: Record<string, unknown>, columnName: string, rowId: unknown): string {
  const value = row[columnName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid automation row ${String(rowId)}: ${columnName} is required`);
  }
  return value;
}

export function automationToRow(automation: Automation): Record<string, unknown> {
  const { config, state } = automation;
  if (config.generationChatId) requireResourcePersistenceUserId("chat", config.generationChatId);
  return {
    id: config.id,
    user_id: requireResourcePersistenceUserId("automation", config.id, config.workspaceId),
    name: config.name,
    workspace_id: config.workspaceId,
    directory: config.directory,
    prompt: config.prompt,
    code: config.code ?? null,
    generation_chat_id: config.generationChatId ?? null,
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

export function rowToAutomation(row: Record<string, unknown>): Automation {
  const rowId = row["id"];
  const config: AutomationConfig = {
    id: requireString(row, "id", rowId),
    name: requireString(row, "name", rowId),
    workspaceId: requireString(row, "workspace_id", rowId),
    directory: requireString(row, "directory", rowId),
    prompt: requireString(row, "prompt", rowId),
    code: typeof row["code"] === "string" && row["code"].trim().length > 0 ? row["code"] : undefined,
    generationChatId: (row["generation_chat_id"] as string | null) ?? undefined,
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
        unit: row["schedule_interval_unit"] as AutomationConfig["schedule"]["interval"]["unit"],
      },
      nextRunAt: requireString(row, "schedule_next_run_at", rowId),
    },
    enabled: row["enabled"] === 1,
    createdAt: requireString(row, "created_at", rowId),
    updatedAt: requireString(row, "updated_at", rowId),
    isPrivate: row["is_private"] === 1,
    mode: "automation",
  };

  const state: AutomationState = {
    id: config.id,
    status: row["status"] as AutomationState["status"],
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

export function automationRunToRow(run: AutomationRun): Record<string, unknown> {
  requireResourcePersistenceUserId("automation-run", run.id);
  if (run.chatId) requireResourcePersistenceUserId("chat", run.chatId);
  return {
    id: run.id,
    user_id: requireResourcePersistenceUserId("automation", run.automationId, run.configSnapshot.workspaceId),
    automation_id: run.automationId,
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

export function rowToAutomationRun(row: Record<string, unknown>): AutomationRun {
  const rowId = row["id"];
  const snapshotFallback: AutomationConfigSnapshot = {
    name: "Unknown automation",
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

  const run: AutomationRun = {
    id: requireString(row, "id", rowId),
    automationId: requireString(row, "automation_id", rowId),
    chatId: (row["chat_id"] as string | null) ?? undefined,
    usage: parseStoredTokenUsage(row["usage_json"], String(rowId)),
    status: row["status"] as AutomationRun["status"],
    trigger: row["trigger"] as AutomationRun["trigger"],
    scheduledFor: requireString(row, "scheduled_for", rowId),
    startedAt: (row["started_at"] as string | null) ?? undefined,
    completedAt: (row["completed_at"] as string | null) ?? undefined,
    skipReason: (row["skip_reason"] as string | null) ?? undefined,
    messages: [],
    logs: [],
    toolCalls: [],
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
