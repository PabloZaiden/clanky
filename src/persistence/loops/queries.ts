/**
 * Specialized query operations for loops persistence.
 * Handles directory-based lookups and stale loop cleanup.
 */

import type { Loop, LoopStatus } from "../../types";
import { getDatabase } from "../database";
import { createLogger } from "../../core/logger";
import { rowToLoop } from "./helpers";

const log = createLogger("persistence:loops");
const STALE_LOOP_RESET_MESSAGE = "Forcefully stopped by connection reset";

/**
 * Active loop statuses that should block new loops on the same directory.
 * These are non-terminal, non-draft states where the loop is actively
 * using or about to use the working directory.
 */
const ACTIVE_LOOP_STATUSES: LoopStatus[] = [
  "idle",      // Created but not started (transitional)
  "planning",  // Loop is in plan creation/review mode
  "starting",  // Initializing backend connection and git branch
  "running",   // Actively executing an iteration
  "waiting",   // Between iterations, preparing for next
];

/**
 * Get an active (non-draft, non-terminal) loop for a specific directory and workspace.
 *
 * Active loops are those in states: idle, planning, starting, running, waiting.
 * Draft and terminal states (completed, stopped, failed, max_iterations, merged, pushed, deleted)
 * are not considered active.
 *
 * @param directory - The absolute path to the working directory
 * @param workspaceId - The workspace ID to scope the lookup to
 * @returns The active loop if one exists, null otherwise
 */
export async function getActiveLoopByDirectory(directory: string, workspaceId: string): Promise<Loop | null> {
  log.debug("Getting active loop by directory and workspace", { directory, workspaceId });
  const db = getDatabase();

  // Build placeholders for the IN clause
  const placeholders = ACTIVE_LOOP_STATUSES.map(() => "?").join(", ");

  const stmt = db.prepare(`
    SELECT * FROM loops 
    WHERE directory = ? AND workspace_id = ? AND status IN (${placeholders})
    LIMIT 1
  `);

  const row = stmt.get(directory, workspaceId, ...ACTIVE_LOOP_STATUSES) as Record<string, unknown> | null;

  if (!row) {
    log.debug("No active loop found for directory", { directory, workspaceId });
    return null;
  }

  const loop = rowToLoop(row);
  log.debug("Active loop found", { directory, workspaceId, loopId: loop.config.id, status: loop.state.status });
  return loop;
}

/**
 * Stale loop statuses that should be reset when force-resetting connections.
 * These are non-planning active states where the loop appears to be running
 * but may have a stale in-memory engine.
 *
 * Note: "planning" is excluded because planning loops can reconnect to their
 * session when the user sends feedback. We don't want to break their state.
 */
const STALE_LOOP_STATUSES: LoopStatus[] = [
  "idle",      // Created but not started (transitional)
  "starting",  // Initializing backend connection and git branch
  "running",   // Actively executing an iteration
  "waiting",   // Between iterations, preparing for next
];

export function isStaleLoopStatus(status: LoopStatus): boolean {
  return STALE_LOOP_STATUSES.includes(status);
}

export async function resetStaleLoop(loopId: string): Promise<boolean> {
  log.debug("Resetting stale loop", { loopId });
  const db = getDatabase();
  const now = new Date().toISOString();

  const placeholders = STALE_LOOP_STATUSES.map(() => "?").join(", ");

  const stmt = db.prepare(`
    UPDATE loops
    SET status = 'stopped',
        error_message = ?,
        error_timestamp = ?,
        completed_at = ?
    WHERE id = ? AND status IN (${placeholders})
  `);

  const result = stmt.run(
    STALE_LOOP_RESET_MESSAGE,
    now,
    now,
    loopId,
    ...STALE_LOOP_STATUSES,
  );

  if (result.changes > 0) {
    log.info("Reset stale loop", { loopId });
    return true;
  }

  log.debug("No stale loop reset needed", { loopId });
  return false;
}

/**
 * Reset all stale loops to "stopped" status.
 *
 * This is used when force-resetting connections to clear loops that appear
 * active in the database but have no running engine (e.g., after a crash or
 * when connections become stale).
 *
 * Loops in "planning" status are NOT reset because they can reconnect to
 * their existing session when the user sends feedback.
 *
 * @returns The number of loops that were reset
 */
export async function resetStaleLoops(): Promise<number> {
  log.debug("Resetting stale loops");
  const db = getDatabase();
  const now = new Date().toISOString();

  // Build placeholders for the IN clause
  const placeholders = STALE_LOOP_STATUSES.map(() => "?").join(", ");

  const stmt = db.prepare(`
    UPDATE loops 
    SET status = 'stopped',
        error_message = ?,
        error_timestamp = ?,
        completed_at = ?
    WHERE status IN (${placeholders})
  `);

  const result = stmt.run(STALE_LOOP_RESET_MESSAGE, now, now, ...STALE_LOOP_STATUSES);

  if (result.changes > 0) {
    log.info("Reset stale loops", { count: result.changes });
  } else {
    log.debug("No stale loops to reset");
  }
  return result.changes;
}
