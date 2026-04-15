/**
 * Internal helpers for the loops persistence layer.
 * Handles column validation, JSON serialization, and row mapping.
 */

import type { Loop, LoopConfig, LoopState, ConsecutiveErrorTracker } from "../../types";
import { DEFAULT_LOOP_CONFIG } from "../../types/loop";
import { normalizeCommitScope } from "../../utils/commit-scope";
import { createLogger } from "../../core/logger";
import { CheapModelSelectionSchema } from "../../types/schemas";

const log = createLogger("persistence:loops");

/**
 * Allowed column names for the loops table.
 * This list must match the effective loops schema (the base schema in
 * database.ts plus any startup compatibility repairs and post-reset migrations).
 * Used to validate column names before SQL interpolation to prevent injection.
 */
export const ALLOWED_LOOP_COLUMNS = new Set([
  "id",
  "name",
  "directory",
  "prompt",
  "created_at",
  "updated_at",
  "workspace_id",
  "model_provider_id",
  "model_model_id",
  "model_variant",
  "cheap_model",
  "max_iterations",
  "max_consecutive_errors",
  "activity_timeout_seconds",
  "stop_pattern",
  "git_branch_prefix",
  "git_commit_scope",
  "base_branch",
  "use_worktree",
  "clear_planning_folder",
  "plan_mode",
  "plan_mode_auto_reply",
  "auto_accept_plan",
  "fully_autonomous",
  "status",
  "current_iteration",
  "started_at",
  "completed_at",
  "last_activity_at",
  "session_id",
  "session_server_url",
  "error_message",
  "error_iteration",
  "error_timestamp",
  "git_original_branch",
  "git_working_branch",
  "git_commits",
  "recent_iterations",
  "logs",
  "messages",
  "tool_calls",
  "consecutive_errors",
  "pending_prompt",
  "pending_model_provider_id",
  "pending_model_model_id",
  "pending_model_variant",
  "plan_mode_active",
  "plan_session_id",
  "plan_server_url",
  "plan_feedback_rounds",
  "plan_content",
  "planning_folder_cleared",
  "plan_is_ready",
  "pending_plan_question",
  "review_mode",
  "pull_request_monitoring",
  "automatic_pr_flow",
  "fully_autonomous_pending",
  "git_worktree_path",
  "mode",
]);

/**
 * Validate that all column names are in the allowed list.
 * Throws an error if any column name is not allowed.
 */
export function validateColumnNames(columns: string[]): void {
  for (const column of columns) {
    if (!ALLOWED_LOOP_COLUMNS.has(column)) {
      throw new Error(`Invalid column name: ${column}`);
    }
  }
}

/**
 * Convert a Loop to a flat object for database insertion.
 */
export function loopToRow(loop: Loop): Record<string, unknown> {
  const { config, state } = loop;
  return {
    id: config.id,
    // Config fields
    name: config.name,
    directory: config.directory,
    prompt: config.prompt,
    created_at: config.createdAt,
    updated_at: config.updatedAt,
    workspace_id: config.workspaceId || null,
    model_provider_id: config.model?.providerID ?? null,
    model_model_id: config.model?.modelID ?? null,
    model_variant: config.model?.variant ?? null,
    cheap_model: JSON.stringify(config.cheapModel ?? DEFAULT_LOOP_CONFIG.cheapModel),
    max_iterations: config.maxIterations ?? null,
    max_consecutive_errors: config.maxConsecutiveErrors ?? null,
    activity_timeout_seconds: config.activityTimeoutSeconds ?? null,
    stop_pattern: config.stopPattern,
    git_branch_prefix: config.git.branchPrefix,
    git_commit_scope: config.git.commitScope,
    base_branch: config.baseBranch ?? null,
    use_worktree: config.useWorktree ? 1 : 0,
    clear_planning_folder: config.clearPlanningFolder ? 1 : 0,
    plan_mode: config.planMode ? 1 : 0,
    auto_accept_plan: (config.autoAcceptPlan ?? DEFAULT_LOOP_CONFIG.autoAcceptPlan) ? 1 : 0,
    fully_autonomous: config.fullyAutonomous ? 1 : 0,
    mode: config.mode ?? "loop",
    // State fields
    status: state.status,
    current_iteration: state.currentIteration,
    started_at: state.startedAt ?? null,
    completed_at: state.completedAt ?? null,
    last_activity_at: state.lastActivityAt ?? null,
    session_id: state.session?.id ?? null,
    session_server_url: state.session?.serverUrl ?? null,
    error_message: state.error?.message ?? null,
    error_iteration: state.error?.iteration ?? null,
    error_timestamp: state.error?.timestamp ?? null,
    git_original_branch: state.git?.originalBranch ?? null,
    git_working_branch: state.git?.workingBranch ?? null,
    git_worktree_path: state.git?.worktreePath ?? null,
    git_commits: state.git?.commits ? JSON.stringify(state.git.commits) : null,
    recent_iterations: JSON.stringify(state.recentIterations),
    logs: state.logs ? JSON.stringify(state.logs) : null,
    messages: state.messages ? JSON.stringify(state.messages) : null,
    tool_calls: state.toolCalls ? JSON.stringify(state.toolCalls) : null,
    consecutive_errors: state.consecutiveErrors ? JSON.stringify(state.consecutiveErrors) : null,
    pending_prompt: state.pendingPrompt ?? null,
    pending_model_provider_id: state.pendingModel?.providerID ?? null,
    pending_model_model_id: state.pendingModel?.modelID ?? null,
    pending_model_variant: state.pendingModel?.variant ?? null,
    plan_mode_active: state.planMode?.active ? 1 : 0,
    plan_session_id: state.planMode?.planSessionId ?? null,
    plan_server_url: state.planMode?.planServerUrl ?? null,
    plan_feedback_rounds: state.planMode?.feedbackRounds ?? 0,
    plan_content: state.planMode?.planContent ?? null,
    planning_folder_cleared: state.planMode?.planningFolderCleared ? 1 : 0,
    plan_is_ready: state.planMode?.isPlanReady ? 1 : 0,
    pending_plan_question: null,
    review_mode: state.reviewMode ? JSON.stringify(state.reviewMode) : null,
    pull_request_monitoring: state.pullRequestMonitoring ? JSON.stringify(state.pullRequestMonitoring) : null,
    automatic_pr_flow: state.automaticPrFlow ? JSON.stringify(state.automaticPrFlow) : null,
    fully_autonomous_pending: state.fullyAutonomousPending ? 1 : 0,
  };
}

/**
 * Safely parse a JSON string, returning the fallback value on parse failure.
 * This prevents a single corrupt row from crashing the entire listLoops() call.
 */
export function safeJsonParse<T>(json: string, fallback: T, fieldName: string, rowId: unknown): T {
  try {
    return JSON.parse(json);
  } catch (error) {
    log.warn(`Failed to parse JSON in field "${fieldName}" for loop ${String(rowId)}: ${String(error)}`);
    return fallback;
  }
}

/**
 * Normalize persisted loop modes to the loop-only contract.
 */
export function normalizeLoopMode(mode: unknown, rowId: unknown): LoopConfig["mode"] {
  if (mode === "loop" || mode === null || mode === undefined) {
    return "loop";
  }
  log.warn(`Normalizing legacy loop mode for loop ${String(rowId)}`, { rawMode: String(mode) });
  return "loop";
}

/**
 * Convert a database row to a Loop object.
 */
export function rowToLoop(row: Record<string, unknown>): Loop {
  // Handle model - required field, but may be missing in legacy data
  let model: { providerID: string; modelID: string; variant: string };
  if (row["model_provider_id"] && row["model_model_id"]) {
    model = {
      providerID: row["model_provider_id"] as string,
      modelID: row["model_model_id"] as string,
      variant: (row["model_variant"] as string | null) ?? "",
    };
  } else {
    // Legacy loops without model - provide a placeholder that indicates missing config
    model = {
      providerID: "unknown",
      modelID: "not-configured",
      variant: "",
    };
  }

  const config: LoopConfig = {
    id: row["id"] as string,
    name: row["name"] as string,
    directory: row["directory"] as string,
    prompt: row["prompt"] as string,
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
    workspaceId: (row["workspace_id"] as string | null) ?? "",
    stopPattern: row["stop_pattern"] as string,
    git: {
      branchPrefix: row["git_branch_prefix"] as string,
      commitScope: normalizeCommitScope(
        (row["git_commit_scope"] as string | null) ?? DEFAULT_LOOP_CONFIG.git.commitScope,
      ) ?? "",
    },
    model,
    // Mandatory fields with defaults for backward compatibility with old data
    maxIterations: (row["max_iterations"] as number | null) ?? Infinity,
    maxConsecutiveErrors: (row["max_consecutive_errors"] as number | null) ?? 10,
    activityTimeoutSeconds:
      (row["activity_timeout_seconds"] as number | null | undefined) ??
      DEFAULT_LOOP_CONFIG.activityTimeoutSeconds,
    useWorktree: row["use_worktree"] === 1,
    clearPlanningFolder: row["clear_planning_folder"] === 1,
    planMode: row["plan_mode"] === 1,
    autoAcceptPlan: row["auto_accept_plan"] === 1,
    fullyAutonomous: row["fully_autonomous"] === 1,
    mode: normalizeLoopMode(row["mode"], row["id"]),
    cheapModel: DEFAULT_LOOP_CONFIG.cheapModel,
  };

  // Optional config fields
  if (row["base_branch"] !== null) {
    config.baseBranch = row["base_branch"] as string;
  }
  if (typeof row["cheap_model"] === "string") {
    const parsedCheapModel = safeJsonParse(
      row["cheap_model"] as string,
      DEFAULT_LOOP_CONFIG.cheapModel,
      "cheap_model",
      row["id"],
    );
    const validation = CheapModelSelectionSchema.safeParse(parsedCheapModel);
    if (validation.success) {
      config.cheapModel = validation.data;
    } else {
      log.warn(`Failed to validate cheap model selection for loop ${String(row["id"])}`, {
        issues: validation.error.issues.map((issue) => issue.message),
      });
    }
  }

  const rowId = row["id"];
  const state: LoopState = {
    id: row["id"] as string,
    status: row["status"] as LoopState["status"],
    currentIteration: row["current_iteration"] as number,
    recentIterations: row["recent_iterations"]
      ? safeJsonParse(row["recent_iterations"] as string, [], "recent_iterations", rowId)
      : [],
    // Mandatory array fields - always initialize as empty arrays if null
    logs: row["logs"] ? safeJsonParse(row["logs"] as string, [], "logs", rowId) : [],
    messages: row["messages"] ? safeJsonParse(row["messages"] as string, [], "messages", rowId) : [],
    toolCalls: row["tool_calls"] ? safeJsonParse(row["tool_calls"] as string, [], "tool_calls", rowId) : [],
  };

  // Optional state fields
  if (row["started_at"] !== null) {
    state.startedAt = row["started_at"] as string;
  }
  if (row["completed_at"] !== null) {
    state.completedAt = row["completed_at"] as string;
  }
  if (row["last_activity_at"] !== null) {
    state.lastActivityAt = row["last_activity_at"] as string;
  }
  if (row["session_id"] !== null) {
    state.session = {
      id: row["session_id"] as string,
      serverUrl: row["session_server_url"] as string | undefined,
    };
  }
  if (row["error_message"] !== null) {
    state.error = {
      message: row["error_message"] as string,
      iteration: row["error_iteration"] as number,
      timestamp: row["error_timestamp"] as string,
    };
  }
  if (row["git_original_branch"] !== null && row["git_working_branch"] !== null) {
    state.git = {
      originalBranch: row["git_original_branch"] as string,
      workingBranch: row["git_working_branch"] as string,
      commits: row["git_commits"] ? safeJsonParse(row["git_commits"] as string, [], "git_commits", rowId) : [],
    };
    if (row["git_worktree_path"] !== null && row["git_worktree_path"] !== undefined) {
      state.git.worktreePath = row["git_worktree_path"] as string;
    }
  }
  if (row["consecutive_errors"] !== null) {
    state.consecutiveErrors = safeJsonParse<ConsecutiveErrorTracker | undefined>(row["consecutive_errors"] as string, undefined, "consecutive_errors", rowId);
  }
  if (row["pending_prompt"] !== null) {
    state.pendingPrompt = row["pending_prompt"] as string;
  }
  // Reconstruct pendingModel from provider/model columns
  if (row["pending_model_provider_id"] !== null && row["pending_model_model_id"] !== null) {
    state.pendingModel = {
      providerID: row["pending_model_provider_id"] as string,
      modelID: row["pending_model_model_id"] as string,
      variant: (row["pending_model_variant"] as string | null) ?? "",
    };
  }
  // Reconstruct planMode if any plan mode field is set (not just when active)
  if (row["plan_mode_active"] !== null || row["planning_folder_cleared"] === 1 ||
      row["plan_session_id"] !== null || row["plan_feedback_rounds"] !== null) {
    state.planMode = {
      active: row["plan_mode_active"] === 1,
      planSessionId: row["plan_session_id"] as string | undefined,
      planServerUrl: row["plan_server_url"] as string | undefined,
      feedbackRounds: (row["plan_feedback_rounds"] as number) ?? 0,
      planContent: row["plan_content"] as string | undefined,
      planningFolderCleared: row["planning_folder_cleared"] === 1,
      isPlanReady: row["plan_is_ready"] === 1,
    };
  }
  // Reconstruct reviewMode from JSON
  if (row["review_mode"] !== null) {
    state.reviewMode = safeJsonParse(row["review_mode"] as string, undefined, "review_mode", rowId);
  }
  if (typeof row["pull_request_monitoring"] === "string") {
    state.pullRequestMonitoring = safeJsonParse(
      row["pull_request_monitoring"] as string,
      undefined,
      "pull_request_monitoring",
      rowId,
    );
  }
  if (typeof row["automatic_pr_flow"] === "string") {
    state.automaticPrFlow = safeJsonParse(
      row["automatic_pr_flow"] as string,
      undefined,
      "automatic_pr_flow",
      rowId,
    );
  }

  if (row["fully_autonomous_pending"] === 1) {
    state.fullyAutonomousPending = true;
  }

  return { config, state };
}
