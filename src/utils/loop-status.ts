/**
 * Shared loop status helper functions.
 * These are used by LoopCard, LoopDetails, and other components
 * to determine what actions are available for a loop.
 */

import type { Loop, LoopConfig, LoopStatus } from "../types";
import { createLogger } from "../lib/logger";

const log = createLogger("LoopStatus");
const MARK_MERGED_UI_ELIGIBLE_STATUSES: ReadonlySet<LoopStatus> = new Set([
  "completed",
  "max_iterations",
  "pushed",
]);
const RECENT_ACTIVITY_STATUSES: ReadonlySet<LoopStatus> = new Set([
  "idle",
  "draft",
  "planning",
  "starting",
  "running",
  "waiting",
  "resolving_conflicts",
  "completed",
  "pushed",
]);
const MANUAL_COMPLETE_UI_ELIGIBLE_STATUSES: ReadonlySet<LoopStatus> = new Set([
  "stopped",
  "failed",
]);

/**
 * Get a human-readable label for a loop status.
 * Optionally considers syncState to show "Resolving Conflicts" when
 * a loop is running to resolve merge conflicts before push.
 */
export function getStatusLabel(status: LoopStatus, syncState?: { status: string } | null): string {
  // If the loop is actively running and has a sync conflict state, show the sync label
  if (syncState?.status === "conflicts" && (status === "running" || status === "starting" || status === "waiting")) {
    return "Resolving Conflicts";
  }

  switch (status) {
    case "idle":
      return "Idle";
    case "draft":
      return "Draft";
    case "planning":
      return "Planning";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Completed";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    case "max_iterations":
      return "Max Iterations";
    case "resolving_conflicts":
      return "Resolving Conflicts";
    case "merged":
      return "Merged";
    case "pushed":
      return "Pushed";
    case "deleted":
      return "Deleted";
    default:
      return status;
  }
}

/**
 * Check if a loop can be accepted (merged or pushed).
 * Only loops that completed successfully or hit max iterations
 * can have their changes accepted. Failed loops should be
 * reviewed manually or discarded.
 */
export function canAccept(status: LoopStatus): boolean {
  const result = status === "completed" || status === "max_iterations";
  log.trace("canAccept check", { status, result });
  return result;
}

/**
 * Check if a loop is in a final state (merged, pushed, or deleted).
 * Only purge is allowed in final states.
 */
export function isFinalState(status: LoopStatus): boolean {
  const result = status === "merged" || status === "pushed" || status === "deleted";
  log.trace("isFinalState check", { status, result });
  return result;
}

/**
 * Check if the UI should offer the "mark as merged" action.
 * This mirrors the subset of backend-accepted statuses where the action is still useful.
 * Already merged loops remain backend-valid for idempotency, but the UI hides the action.
 */
export function canMarkMerged(status: LoopStatus, hasGit: boolean): boolean {
  const result = hasGit && MARK_MERGED_UI_ELIGIBLE_STATUSES.has(status);
  log.trace("canMarkMerged check", { status, hasGit, result });
  return result;
}

/**
 * Check if the UI should offer the "manually complete loop" action.
 * This is only useful for halted loops that should be finalized without resuming execution.
 */
export function canManualComplete(status: LoopStatus, hasGit: boolean): boolean {
  const result = hasGit && MANUAL_COMPLETE_UI_ELIGIBLE_STATUSES.has(status);
  log.trace("canManualComplete check", { status, hasGit, result });
  return result;
}

/**
 * Check if a loop is actively running.
 * Used to determine if pending prompts can be set.
 */
export function isLoopActive(status: LoopStatus): boolean {
  const result = status === "running" || status === "waiting" || status === "starting";
  log.trace("isLoopActive check", { status, result });
  return result;
}

/**
 * Check if a loop is in a running state where iteration prompts can be set.
 */
export function isLoopRunning(status: LoopStatus): boolean {
  const result = status === "running" || status === "starting";
  log.trace("isLoopRunning check", { status, result });
  return result;
}

/**
 * Check if a loop is actively generating output right now.
 * Planning loops count as generating until the plan is ready for review.
 */
export function isLoopGenerating(loop: Loop): boolean {
  const result =
    loop.state.status === "running" ||
    loop.state.status === "starting" ||
    (loop.state.status === "planning" && loop.state.planMode?.isPlanReady !== true);
  log.trace("isLoopGenerating check", {
    status: loop.state.status,
    isPlanReady: loop.state.planMode?.isPlanReady,
    result,
  });
  return result;
}

/**
 * Check if a loop can be "jumpstarted" - restarted from a stopped state.
 * This allows users to send a message to restart the loop.
 */
export function canJumpstart(status: LoopStatus): boolean {
  const result = status === "completed" || status === "stopped" || status === "failed" || status === "max_iterations";
  log.trace("canJumpstart check", { status, result });
  return result;
}

/**
 * Check if a loop can start a new follow-up cycle from a user-perceived terminal state.
 * This includes jumpstartable execution states, addressable review states, and deleted loops.
 */
export function canSendTerminalFollowUp(status: LoopStatus, reviewModeAddressable: boolean | undefined): boolean {
  const result = canJumpstart(status) || isAwaitingFeedback(status, reviewModeAddressable) || status === "deleted";
  log.trace("canSendTerminalFollowUp check", { status, reviewModeAddressable, result });
  return result;
}

/**
 * Check if a loop is awaiting feedback (pushed/merged but still addressable).
 * These loops are in a final state but can still receive reviewer comments.
 */
export function isAwaitingFeedback(status: LoopStatus, reviewModeAddressable: boolean | undefined): boolean {
  const result = (status === "merged" || status === "pushed") && reviewModeAddressable === true;
  log.trace("isAwaitingFeedback check", { status, reviewModeAddressable, result });
  return result;
}

/**
 * Check if a loop belongs in the archived bucket.
 * Archived loops are purgeable final-state loops that are no longer
 * awaiting reviewer feedback.
 */
export function isArchivedLoop(status: LoopStatus, reviewModeAddressable: boolean | undefined): boolean {
  const result =
    status === "deleted" ||
    ((status === "merged" || status === "pushed") && !isAwaitingFeedback(status, reviewModeAddressable));
  log.trace("isArchivedLoop check", { status, reviewModeAddressable, result });
  return result;
}

/**
 * Check if a loop should appear in the workspace screen's History list.
 * Workspace history is intentionally narrower than archived loop handling:
 * only merged and deleted loops move out of the Activity box.
 */
export function isWorkspaceHistoryLoop(status: LoopStatus): boolean {
  const result = status === "merged" || status === "deleted";
  log.trace("isWorkspaceHistoryLoop check", { status, result });
  return result;
}

/**
 * Check if a loop should appear in the shell overview's Recent activity list.
 * Recent activity includes active loops plus recently finished work that still
 * benefits from quick revisit, specifically completed and pushed loops.
 */
export function shouldShowInRecentActivity(status: LoopStatus): boolean {
  const result = RECENT_ACTIVITY_STATUSES.has(status);
  log.trace("shouldShowInRecentActivity check", { status, result });
  return result;
}

/**
 * Get the timestamp used to sort loops in the shell overview's Recent activity list.
 * Prefer actual loop activity over configuration timestamps so newly completed or
 * pushed loops surface based on when they most recently changed.
 */
export function getRecentActivityTimestamp(loop: Pick<Loop, "config" | "state">): string {
  return loop.state.lastActivityAt
    ?? loop.state.completedAt
    ?? loop.config.updatedAt
    ?? loop.config.createdAt;
}

/**
 * Get the appropriate status label for a planning loop based on plan readiness.
 * Returns "Plan Ready" when the plan is ready for human review,
 * or "Planning" when the AI is still generating/revising the plan.
 */
export function getPlanningStatusLabel(isPlanReady: boolean): string {
  return isPlanReady ? "Plan Ready" : "Planning";
}

/**
 * Get the appropriate human-readable status label for a loop, including
 * planning sub-states that need to distinguish ready plans from active planning.
 */
export function getLoopStatusLabel(loop: Loop): string {
  return loop.state.status === "planning"
    ? getPlanningStatusLabel(loop.state.planMode?.isPlanReady ?? false)
    : getStatusLabel(loop.state.status, loop.state.syncState);
}

/**
 * Check if a loop's plan is ready for human review.
 * Returns true only when the loop is in planning status AND the plan is marked as ready.
 */
export function isLoopPlanReady(loop: Loop): boolean {
  const result = loop.state.status === "planning" && loop.state.planMode?.isPlanReady === true;
  log.trace("isLoopPlanReady check", { status: loop.state.status, isPlanReady: loop.state.planMode?.isPlanReady, result });
  return result;
}

/**
 * Display labels for loop UI text.
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
 * Get display labels for loop UI text.
 */
export function getEntityLabel(_mode: LoopConfig["mode"] | undefined): EntityLabels {
  return {
    singular: "loop",
    plural: "loops",
    capitalized: "Loop",
    capitalizedPlural: "Loops",
    actionVerb: "Start Loop",
  };
}
