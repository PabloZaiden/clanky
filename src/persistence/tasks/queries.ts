/**
 * Specialized query operations for tasks persistence.
 * Handles directory-based lookups and stale task cleanup.
 */

import type { Task, TaskStatus } from "../../types";
import { getDatabase } from "../database";
import { createLogger } from "../../core/logger";
import { rowToTask } from "./helpers";
import { requirePersistenceUserId } from "../ownership";

const log = createLogger("persistence:tasks");
const STALE_TASK_RESET_MESSAGE = "Forcefully stopped by connection reset";
const STALE_TASK_RESET_ERROR_ITERATION = "COALESCE(current_iteration, 0)";

/**
 * Active task statuses that should block new tasks on the same directory.
 * These are non-terminal, non-draft states where the task is actively
 * using or about to use the working directory.
 */
const ACTIVE_TASK_STATUSES: TaskStatus[] = [
  "idle",      // Created but not started (transitional)
  "planning",  // Task is in plan creation/review mode
  "starting",  // Initializing backend connection and git branch
  "running",   // Actively executing an iteration
  "waiting",   // Between iterations, preparing for next
];

/**
 * Get an active (non-draft, non-terminal) task for a specific directory and workspace.
 *
 * Active tasks are those in states: idle, planning, starting, running, waiting.
 * Draft and terminal states (completed, stopped, failed, max_iterations, merged, pushed, deleted)
 * are not considered active.
 *
 * @param directory - The absolute path to the working directory
 * @param workspaceId - The workspace ID to scope the lookup to
 * @returns The active task if one exists, null otherwise
 */
export async function getActiveTaskByDirectory(directory: string, workspaceId: string): Promise<Task | null> {
  log.debug("Getting active task by directory and workspace", { directory, workspaceId });
  const db = getDatabase();
  const userId = requirePersistenceUserId();

  // Build placeholders for the IN clause
  const placeholders = ACTIVE_TASK_STATUSES.map(() => "?").join(", ");

  const stmt = db.prepare(`
    SELECT * FROM tasks 
    WHERE directory = ? AND workspace_id = ? AND user_id = ? AND status IN (${placeholders})
    LIMIT 1
  `);

  const row = stmt.get(directory, workspaceId, userId, ...ACTIVE_TASK_STATUSES) as Record<string, unknown> | null;

  if (!row) {
    log.debug("No active task found for directory", { directory, workspaceId });
    return null;
  }

  const task = rowToTask(row);
  log.debug("Active task found", { directory, workspaceId, taskId: task.config.id, status: task.state.status });
  return task;
}

/**
 * Stale task statuses that should be reset when force-resetting connections.
 * These are non-planning active states where the task appears to be running
 * but may have a stale in-memory engine.
 *
 * Note: "planning" is excluded because planning tasks can reconnect to their
 * session when the user sends feedback. We don't want to break their state.
 */
const STALE_TASK_STATUSES: TaskStatus[] = [
  "idle",      // Created but not started (transitional)
  "starting",  // Initializing backend connection and git branch
  "running",   // Actively executing an iteration
  "waiting",   // Between iterations, preparing for next
];

export function isStaleTaskStatus(status: TaskStatus): boolean {
  return STALE_TASK_STATUSES.includes(status);
}

export async function resetStaleTask(taskId: string): Promise<boolean> {
  log.debug("Resetting stale task", { taskId });
  const db = getDatabase();
  const now = new Date().toISOString();
  const userId = requirePersistenceUserId();

  const placeholders = STALE_TASK_STATUSES.map(() => "?").join(", ");

  const stmt = db.prepare(`
    UPDATE tasks
    SET status = 'stopped',
        error_message = ?,
        error_iteration = ${STALE_TASK_RESET_ERROR_ITERATION},
        error_timestamp = ?,
        completed_at = ?
    WHERE id = ? AND user_id = ? AND status IN (${placeholders})
  `);

  const result = stmt.run(
    STALE_TASK_RESET_MESSAGE,
    now,
    now,
    taskId,
    userId,
    ...STALE_TASK_STATUSES,
  );

  if (result.changes > 0) {
    log.info("Reset stale task", { taskId });
    return true;
  }

  log.debug("No stale task reset needed", { taskId });
  return false;
}

/**
 * Reset all stale tasks to "stopped" status.
 *
 * This is used when force-resetting connections to clear tasks that appear
 * active in the database but have no running engine (e.g., after a crash or
 * when connections become stale).
 *
 * Tasks in "planning" status are NOT reset because they can reconnect to
 * their existing session when the user sends feedback.
 *
 * @returns The number of tasks that were reset
 */
export async function resetStaleTasks(): Promise<number> {
  log.debug("Resetting stale tasks");
  const db = getDatabase();
  const now = new Date().toISOString();
  const userId = requirePersistenceUserId();

  // Build placeholders for the IN clause
  const placeholders = STALE_TASK_STATUSES.map(() => "?").join(", ");

  const stmt = db.prepare(`
    UPDATE tasks 
    SET status = 'stopped',
        error_message = ?,
        error_iteration = ${STALE_TASK_RESET_ERROR_ITERATION},
        error_timestamp = ?,
        completed_at = ?
    WHERE user_id = ? AND status IN (${placeholders})
  `);

  const result = stmt.run(STALE_TASK_RESET_MESSAGE, now, now, userId, ...STALE_TASK_STATUSES);

  if (result.changes > 0) {
    log.info("Reset stale tasks", { count: result.changes });
  } else {
    log.debug("No stale tasks to reset");
  }
  return result.changes;
}
