/**
 * Loop state machine for Ralph Loops Management System.
 *
 * Defines all valid status transitions as a centralized transition table.
 * All status changes must go through this module to ensure consistency.
 *
 * @module core/loop-state-machine
 */

import type { LoopStatus } from "../types/loop";

/**
 * Transition table mapping each status to its set of valid target statuses.
 *
 * The transition table encodes every valid (fromStatus → toStatus) pair.
 * Any transition not listed here is invalid and will be rejected.
 */
const TRANSITION_TABLE: Record<LoopStatus, ReadonlySet<LoopStatus>> = {
  // idle is a transitional status after creation — moves to starting/planning when engine starts
  // → draft: createLoop sets status to draft for saved-but-not-started loops
  // → deleted: delete a loop in idle status (e.g., freshly created loop)
  idle: new Set(["starting", "planning", "draft", "deleted"]),

  // draft is a saved loop that hasn't been started yet
  // → idle: start immediately (API draft/start handler)
  // → planning: start in plan mode (API draft/start handler)
  // → deleted: delete the draft
  draft: new Set(["idle", "planning", "deleted"]),

  // planning: AI is generating a plan, awaiting user approval
  // → starting: plan accepted and pre-execution sync/setup begins (acceptPlan start_loop)
  // → completed: plan accepted directly into manual SSH handoff (acceptPlan open_ssh)
  // → stopped: user stops during planning
  // → failed: unrecoverable error during planning
  // → deleted: delete during planning
  planning: new Set(["starting", "completed", "stopped", "failed", "deleted"]),

  // starting: engine is initializing (git branch, session setup)
  // → running: initialization complete, first iteration begins
  // → resolving_conflicts: accepted-plan base sync encountered conflicts
  // → failed: initialization error
  // → stopped: user cancels during startup
  // → deleted: delete during startup
  starting: new Set(["running", "resolving_conflicts", "failed", "stopped", "deleted"]),

  // running: actively executing iterations
  // → completed: stop pattern matched
  // → stopped: user requested stop
  // → failed: failsafe exit (consecutive errors)
  // → max_iterations: hit iteration limit
  // → deleted: delete while running (engine stopped first)
  running: new Set(["completed", "stopped", "failed", "max_iterations", "deleted"]),

  // waiting: between iterations (currently unused but reserved)
  // Same transitions as running
  waiting: new Set(["running", "completed", "stopped", "failed", "max_iterations", "deleted"]),

  // completed: successfully finished
  // → merged: accepted (merged into original branch)
  // → pushed: pushed to remote
  // → deleted: discarded
  // → resolving_conflicts: push encountered merge conflicts
  // → starting: accepted-plan conflict resolution completed and execution is resuming
  // → idle: review comments restarting the loop
  // → stopped: jumpstart (engine.start accepts stopped)
  // → planning: jumpstart in planning mode
  completed: new Set(["merged", "pushed", "deleted", "resolving_conflicts", "starting", "idle", "stopped", "planning"]),

  // stopped: manually stopped by user
  // → starting: restart via engine.start
  // → planning: restart in plan mode via engine.start
  // → completed: manually finalize without resuming execution
  // → deleted: delete/discard
  // → stopped: jumpstart (re-enter stopped to allow engine.start)
  stopped: new Set(["starting", "planning", "completed", "deleted", "stopped"]),

  // failed: unrecoverable error occurred
  // → completed: manually finalize after reviewing the failure
  // → deleted: delete/discard
  // → stopped: jumpstart (reset to stopped for restart)
  // → planning: jumpstart in planning mode
  failed: new Set(["completed", "deleted", "stopped", "planning"]),

  // max_iterations: hit the iteration limit
  // → merged: accepted
  // → pushed: pushed to remote
  // → deleted: discarded
  // → resolving_conflicts: push encountered conflicts
  // → stopped: jumpstart
  // → planning: jumpstart in planning mode
  max_iterations: new Set(["merged", "pushed", "deleted", "resolving_conflicts", "stopped", "planning"]),

  // resolving_conflicts: engine is resolving merge conflicts before push or execution
  // → starting: engine.start for conflict resolution
  // → stopped: user stops conflict resolution
  // → failed: error during conflict resolution
  // → pushed: conflict resolution + push completed
  // → completed: conflict resolution engine iteration completes
  // → max_iterations: conflict resolution engine hit iteration limit
  // → deleted: delete during conflict resolution
  resolving_conflicts: new Set(["starting", "stopped", "failed", "pushed", "completed", "max_iterations", "deleted"]),

  // merged: changes merged into original branch (final state, can receive reviews)
  // → deleted: delete
  // → idle: review comments restarting the loop
  merged: new Set(["deleted", "idle"]),

  // pushed: branch pushed to remote (final state, can receive reviews)
  // → merged: branch merged externally
  // → deleted: delete
  // → idle: review comments restarting the loop
  // → resolving_conflicts: re-push encountered conflicts
  // → pushed: re-push after branch update (updateBranch)
  pushed: new Set(["merged", "deleted", "idle", "resolving_conflicts", "pushed"]),

  // deleted: soft-deleted, can be revived into a fresh feedback cycle before purge
  deleted: new Set(["stopped", "planning"]),
};

/**
 * Check whether a status transition is valid.
 *
 * @param from - Current status
 * @param to - Desired target status
 * @returns true if the transition is allowed
 */
export function isValidTransition(from: LoopStatus, to: LoopStatus): boolean {
  const allowed = TRANSITION_TABLE[from];
  return allowed !== undefined && allowed.has(to);
}

/**
 * Assert that a status transition is valid, throwing an error if not.
 *
 * @param from - Current status
 * @param to - Desired target status
 * @param context - Optional context string for the error message (e.g., method name)
 * @throws Error if the transition is invalid
 */
export function assertValidTransition(
  from: LoopStatus,
  to: LoopStatus,
  context?: string,
): void {
  if (!isValidTransition(from, to)) {
    const ctx = context ? ` (${context})` : "";
    throw new Error(
      `Invalid loop status transition: ${from} → ${to}${ctx}`,
    );
  }
}

/**
 * Get all valid target statuses from a given status.
 *
 * @param from - Current status
 * @returns ReadonlySet of valid target statuses
 */
export function getValidTransitions(from: LoopStatus): ReadonlySet<LoopStatus> {
  return TRANSITION_TABLE[from] ?? new Set();
}

/**
 * Check if a status is terminal (no outgoing transitions).
 *
 * @param status - Status to check
 * @returns true if the status has no valid outgoing transitions
 */
export function isTerminalStatus(status: LoopStatus): boolean {
  const transitions = TRANSITION_TABLE[status];
  return transitions === undefined || transitions.size === 0;
}

/**
 * Check if a status is an "active" status (loop engine may be running).
 * Active statuses are those where an engine is expected to be attached.
 */
export function isActiveStatus(status: LoopStatus): boolean {
  return status === "starting" || status === "running" || status === "planning" || status === "resolving_conflicts";
}
