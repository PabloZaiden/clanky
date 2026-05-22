/**
 * Basic CRUD operations for tasks persistence.
 */

import type { Task } from "../../types";
import { getDatabase } from "../database";
import { createLogger } from "../../core/logger";
import { taskToRow, rowToTask, validateColumnNames } from "./helpers";

const log = createLogger("persistence:tasks");

const TASK_LIST_COLUMNS = [
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
  "consecutive_errors",
  "pending_prompt",
  "pending_prompt_mode",
  "pending_model_provider_id",
  "pending_model_model_id",
  "pending_model_variant",
  "plan_mode_active",
  "plan_session_id",
  "plan_server_url",
  "plan_feedback_rounds",
  "planning_folder_cleared",
  "plan_is_ready",
  "review_mode",
  "pull_request_monitoring",
  "automatic_pr_flow",
  "fully_autonomous_pending",
  "git_worktree_path",
  "mode",
].join(", ");

export function createTaskListSnapshot(task: Task): Task {
  return {
    config: task.config,
    state: {
      ...task.state,
      logs: [],
      messages: [],
      toolCalls: [],
      planMode: task.state.planMode
        ? {
          ...task.state.planMode,
          planContent: undefined,
        }
        : undefined,
    },
  };
}

/**
 * Save a task to the database.
 * Uses INSERT ... ON CONFLICT DO UPDATE (upsert) to avoid triggering
 * ON DELETE CASCADE which would destroy related records (e.g. review_comments).
 */
export async function saveTask(task: Task): Promise<void> {
  log.debug("Saving task", { id: task.config.id, name: task.config.name, status: task.state.status });
  const db = getDatabase();
  const row = taskToRow(task);

  const columns = Object.keys(row);
  // Validate column names to prevent SQL injection
  validateColumnNames(columns);

  const placeholders = columns.map(() => "?").join(", ");
  const values = Object.values(row) as (string | number | null | Uint8Array)[];

  // Build the ON CONFLICT UPDATE clause for all columns except 'id'
  const updateColumns = columns.filter(col => col !== "id");
  const updateClause = updateColumns.map(col => `${col} = excluded.${col}`).join(", ");

  const stmt = db.prepare(`
    INSERT INTO tasks (${columns.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updateClause}
  `);

  stmt.run(...values);
  log.debug("Task saved to database", { id: task.config.id });
}

/**
 * Load a task from the database by ID.
 * Returns null if the task doesn't exist.
 */
export async function loadTask(taskId: string): Promise<Task | null> {
  log.debug("Loading task", { taskId });
  const db = getDatabase();

  const stmt = db.prepare("SELECT * FROM tasks WHERE id = ?");
  const row = stmt.get(taskId) as Record<string, unknown> | null;

  if (!row) {
    log.debug("Task not found", { taskId });
    return null;
  }

  const task = rowToTask(row);
  log.debug("Task loaded", { taskId, status: task.state.status });
  return task;
}

/**
 * Delete a task from the database.
 * Returns true if deleted, false if it didn't exist.
 */
export async function deleteTask(taskId: string): Promise<boolean> {
  log.debug("Deleting task", { taskId });
  const db = getDatabase();

  const stmt = db.prepare("DELETE FROM tasks WHERE id = ?");
  const result = stmt.run(taskId);

  const deleted = result.changes > 0;
  if (deleted) {
    log.info("Task deleted", { taskId });
  } else {
    log.debug("Task not found for deletion", { taskId });
  }
  return deleted;
}

/**
 * List all tasks from the database.
 * Sorted by creation date, newest first.
 */
export async function listTasks(): Promise<Task[]> {
  log.debug("Listing all tasks");
  const db = getDatabase();

  const stmt = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC");
  const rows = stmt.all() as Record<string, unknown>[];

  const tasks = rows.map(rowToTask);
  log.debug("Tasks listed", { count: tasks.length });
  return tasks;
}

/**
 * List lightweight task snapshots for collection endpoints.
 *
 * Excludes persisted transcript fields that are only needed by detail routes:
 * logs, messages, tool calls, and plan content.
 */
export async function listTaskSummaries(): Promise<Task[]> {
  log.debug("Listing task summaries");
  const db = getDatabase();

  const stmt = db.prepare(`SELECT ${TASK_LIST_COLUMNS} FROM tasks ORDER BY created_at DESC`);
  const rows = stmt.all() as Record<string, unknown>[];

  const tasks = rows.map((row) => createTaskListSnapshot(rowToTask(row)));
  log.debug("Task summaries listed", { count: tasks.length });
  return tasks;
}

/**
 * Check if a task exists.
 */
export async function taskExists(taskId: string): Promise<boolean> {
  log.debug("Checking if task exists", { taskId });
  const db = getDatabase();

  const stmt = db.prepare("SELECT 1 FROM tasks WHERE id = ? LIMIT 1");
  const row = stmt.get(taskId);

  const exists = row !== null;
  log.debug("Task exists check result", { taskId, exists });
  return exists;
}
