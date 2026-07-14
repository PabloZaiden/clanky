/**
 * Shared task status helper functions.
 * These are used by TaskCard, TaskDetails, and other components
 * to determine what actions are available for a task.
 */

import type { Task, TaskConfig, TaskState, TaskStatus } from "@/shared";
import { createLogger } from "../lib/logger";

const log = createLogger("TaskStatus");
// The backend accepts `merged` for idempotency, but the UI only offers the
// action for pushed tasks where marking an external PR merge is still useful.
const MARK_MERGED_UI_ELIGIBLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "pushed",
]);
const MANUAL_COMPLETE_UI_ELIGIBLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "stopped",
  "failed",
]);
const ACTIVE_SYNC_CONFLICT_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "starting",
  "running",
  "waiting",
]);

export type TaskStatusPillVariant =
  | "default"
  | "idle"
  | "planning"
  | "running"
  | "completed"
  | "stopped"
  | "failed"
  | "merged"
  | "pushed"
  | "deleted"
  | "plan_ready";

export type TaskStatusPillKey =
  | "idle"
  | "draft"
  | "planning"
  | "plan_ready"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "stopped"
  | "failed"
  | "max_iterations"
  | "resolving_conflicts"
  | "merged"
  | "accepted_local"
  | "pushed"
  | "deleted";

export interface TaskStatusPill {
  key: TaskStatusPillKey | "unknown";
  label: string;
  variant: TaskStatusPillVariant;
}

type TaskStatusPillState = Pick<TaskState, "status" | "planMode"> & {
  syncState?: TaskState["syncState"] | null;
};

const TASK_STATUS_PILLS: Record<TaskStatusPillKey, Omit<TaskStatusPill, "key">> = {
  idle: { label: "Idle", variant: "idle" },
  draft: { label: "Draft", variant: "default" },
  planning: { label: "Planning", variant: "planning" },
  plan_ready: { label: "Plan Ready", variant: "plan_ready" },
  starting: { label: "Starting", variant: "running" },
  running: { label: "Running", variant: "running" },
  waiting: { label: "Waiting", variant: "running" },
  completed: { label: "Completed", variant: "completed" },
  stopped: { label: "Stopped", variant: "stopped" },
  failed: { label: "Failed", variant: "failed" },
  max_iterations: { label: "Max Iterations", variant: "stopped" },
  resolving_conflicts: { label: "Resolving Conflicts", variant: "running" },
  accepted_local: { label: "Accepted Locally", variant: "completed" },
  merged: { label: "Merged", variant: "merged" },
  pushed: { label: "Pushed", variant: "pushed" },
  deleted: { label: "Deleted", variant: "deleted" },
};

function resolveTaskStatusPillKey(
  state: TaskStatusPillState,
): TaskStatusPillKey | "unknown" {
  if (state.syncState?.status === "conflicts" && ACTIVE_SYNC_CONFLICT_STATUSES.has(state.status)) {
    return "resolving_conflicts";
  }

  if (state.status === "planning" && state.planMode?.isPlanReady === true) {
    return "plan_ready";
  }

  return state.status in TASK_STATUS_PILLS
    ? state.status as TaskStatusPillKey
    : "unknown";
}

function buildTaskStatusPill(
  state: TaskStatusPillState,
): TaskStatusPill {
  const key = resolveTaskStatusPillKey(state);

  if (key === "unknown") {
    return {
      key,
      label: state.status,
      variant: "default",
    };
  }

  return {
    key,
    ...TASK_STATUS_PILLS[key],
  };
}

/**
 * Get a human-readable label for a task status.
 * Optionally considers syncState to show "Resolving Conflicts" when
 * a task is running to resolve merge conflicts before push.
 */
export function getStatusLabel(status: TaskStatus, syncState?: TaskState["syncState"] | null): string {
  return buildTaskStatusPill({
    status,
    syncState,
    planMode: undefined,
  }).label;
}

/**
 * Check if a task can be accepted locally or pushed.
 * Only tasks that completed successfully or hit max iterations
 * can have their changes accepted. Failed tasks should be
 * reviewed manually or discarded.
 */
export function canAccept(status: TaskStatus): boolean {
  const result = status === "completed" || status === "max_iterations";
  log.trace("canAccept check", { status, result });
  return result;
}

/**
 * Check if a task is in a final state (accepted locally, merged, pushed, or deleted).
 * Only purge is allowed in final states.
 */
export function isFinalState(status: TaskStatus): boolean {
  const result = status === "accepted_local" || status === "merged" || status === "pushed" || status === "deleted";
  log.trace("isFinalState check", { status, result });
  return result;
}

/**
 * Check if the UI should offer the "mark as merged" action.
 * This mirrors the subset of backend-accepted statuses where the action is still useful.
 * Already merged tasks remain backend-valid for idempotency, but the UI hides the action.
 */
export function canMarkMerged(status: TaskStatus, hasGit: boolean): boolean {
  const result = hasGit && MARK_MERGED_UI_ELIGIBLE_STATUSES.has(status);
  log.trace("canMarkMerged check", { status, hasGit, result });
  return result;
}

/**
 * Check if the UI should offer the "manually complete task" action.
 * This is only useful for halted tasks that should be finalized without resuming execution.
 */
export function canManualComplete(status: TaskStatus, hasGit: boolean): boolean {
  const result = hasGit && MANUAL_COMPLETE_UI_ELIGIBLE_STATUSES.has(status);
  log.trace("canManualComplete check", { status, hasGit, result });
  return result;
}

/**
 * Check if a task is actively running.
 * Used to determine if pending prompts can be set.
 */
export function isTaskActive(status: TaskStatus): boolean {
  const result = status === "running" || status === "waiting" || status === "starting";
  log.trace("isTaskActive check", { status, result });
  return result;
}

/**
 * Check if a task is in a running state where iteration prompts can be set.
 */
export function isTaskRunning(status: TaskStatus): boolean {
  const result = status === "running" || status === "starting";
  log.trace("isTaskRunning check", { status, result });
  return result;
}

/**
 * Check if a task is actively generating output right now.
 * Planning tasks count as generating until the plan is ready for review.
 */
export function isTaskGenerating(task: Task): boolean {
  const result =
    task.state.status === "running" ||
    task.state.status === "starting" ||
    (task.state.status === "planning" && task.state.planMode?.isPlanReady !== true);
  log.trace("isTaskGenerating check", {
    status: task.state.status,
    isPlanReady: task.state.planMode?.isPlanReady,
    result,
  });
  return result;
}

/**
 * Check if a task can be "jumpstarted" - restarted from a stopped state.
 * This allows users to send a message to restart the task.
 */
export function canJumpstart(status: TaskStatus): boolean {
  const result = status === "completed" || status === "stopped" || status === "failed" || status === "max_iterations";
  log.trace("canJumpstart check", { status, result });
  return result;
}

/**
 * Check if a task can start a new follow-up cycle from a user-perceived terminal state.
 * This includes jumpstartable execution states, addressable review states, and deleted tasks.
 */
export function canSendTerminalFollowUp(status: TaskStatus, reviewModeAddressable: boolean | undefined): boolean {
  const result = canJumpstart(status) || isAwaitingFeedback(status, reviewModeAddressable) || status === "deleted";
  log.trace("canSendTerminalFollowUp check", { status, reviewModeAddressable, result });
  return result;
}

/**
 * Check if a task is awaiting feedback (accepted locally or pushed but still addressable).
 * These tasks are in a final state but can still receive reviewer comments.
 */
export function isAwaitingFeedback(status: TaskStatus, reviewModeAddressable: boolean | undefined): boolean {
  const result = (status === "accepted_local" || status === "pushed") && reviewModeAddressable === true;
  log.trace("isAwaitingFeedback check", { status, reviewModeAddressable, result });
  return result;
}

/**
 * Check if a task belongs in the archived bucket.
 * Archived tasks are purgeable final-state tasks that are no longer
 * awaiting reviewer feedback.
 */
export function isArchivedTask(status: TaskStatus, reviewModeAddressable: boolean | undefined): boolean {
  const result =
    status === "deleted" ||
    ((status === "accepted_local" || status === "merged" || status === "pushed") && !isAwaitingFeedback(status, reviewModeAddressable));
  log.trace("isArchivedTask check", { status, reviewModeAddressable, result });
  return result;
}

/**
 * Check if a task should appear in the workspace screen's History list.
 * Workspace history is intentionally narrower than archived task handling:
 * only merged and deleted tasks move out of the Activity box.
 */
export function isWorkspaceHistoryTask(status: TaskStatus): boolean {
  const result = status === "merged" || status === "deleted";
  log.trace("isWorkspaceHistoryTask check", { status, result });
  return result;
}

/**
 * Check if a task should appear in the shell overview's Recent activity list.
 * Recent activity includes active tasks plus recently finished work that still
 * benefits from quick revisit, specifically completed and pushed tasks.
 */
export function shouldShowInRecentActivity(status: TaskStatus): boolean {
  const result =
    !isWorkspaceHistoryTask(status) &&
    !MANUAL_COMPLETE_UI_ELIGIBLE_STATUSES.has(status) &&
    status !== "max_iterations";
  log.trace("shouldShowInRecentActivity check", { status, result });
  return result;
}

/**
 * Get the timestamp used to sort tasks in the shell overview's Recent activity list.
 * Prefer actual task activity over configuration timestamps so newly completed or
 * pushed tasks surface based on when they most recently changed.
 */
export function getRecentActivityTimestamp(task: {
  config: Pick<TaskConfig, "createdAt"> & Partial<Pick<TaskConfig, "updatedAt">>;
  state: Pick<TaskState, "lastActivityAt" | "completedAt">;
}): string {
  return task.state.lastActivityAt
    ?? task.state.completedAt
    ?? task.config.updatedAt
    ?? task.config.createdAt;
}

/**
 * Get the appropriate status label for a planning task based on plan readiness.
 * Returns "Plan Ready" when the plan is ready for human review,
 * or "Planning" when the AI is still generating/revising the plan.
 */
export function getPlanningStatusLabel(isPlanReady: boolean): string {
  return TASK_STATUS_PILLS[isPlanReady ? "plan_ready" : "planning"].label;
}

/**
 * Get the appropriate human-readable status label for a task, including
 * planning sub-states that need to distinguish ready plans from active planning.
 */
export function getTaskStatusLabel(task: Task): string {
  return getTaskStatusPill(task).label;
}

/**
 * Get the shared conceptual pill definition for a task status.
 * This is the single source of truth for task pill text and color.
 */
export function getTaskStatusPill(task: Pick<Task, "state">): TaskStatusPill {
  return buildTaskStatusPill(task.state);
}

/**
 * Get the shared conceptual pill definition from raw task-state inputs.
 */
export function getTaskStatusPillFromState(
  state: TaskStatusPillState,
): TaskStatusPill {
  return buildTaskStatusPill(state);
}

/**
 * Check if a task's plan is ready for human review.
 * Returns true only when the task is in planning status AND the plan is marked as ready.
 */
export function isTaskPlanReady(task: Task): boolean {
  const result = task.state.status === "planning" && task.state.planMode?.isPlanReady === true;
  log.trace("isTaskPlanReady check", { status: task.state.status, isPlanReady: task.state.planMode?.isPlanReady, result });
  return result;
}

/**
 * Display labels for task UI text.
 */
export interface EntityLabels {
  /** Lowercase singular label. */
  singular: string;
  /** Lowercase plural label. */
  plural: string;
  /** Capitalized singular label. */
  capitalized: string;
  /** Capitalized plural label. */
  capitalizedPlural: string;
  /** Action verb label. */
  actionVerb: string;
}

/**
 * Get display labels for task UI text.
 */
export function getEntityLabel(_mode: TaskConfig["mode"] | undefined): EntityLabels {
  return {
    singular: "task",
    plural: "tasks",
    capitalized: "Task",
    capitalizedPlural: "Tasks",
    actionVerb: "Start Task",
  };
}
