/**
 * Partial update operations for tasks persistence.
 * Handles atomic state and config updates via transactions.
 */

import type { TaskConfig, TaskState } from "../../types";
import { getDatabase } from "../database";
import { createLogger } from "../../core/logger";
import { taskToRow, rowToTask, validateColumnNames } from "./helpers";

const log = createLogger("persistence:tasks");

/**
 * Update only the state portion of a task.
 * Uses a transaction to ensure atomicity of SELECT + UPDATE.
 */
export async function updateTaskState(taskId: string, state: TaskState): Promise<boolean> {
  log.debug("Updating task state", { taskId, status: state.status });
  const db = getDatabase();

  // Prepare statements outside transaction
  const selectStmt = db.prepare("SELECT * FROM tasks WHERE id = ?");

  // Use transaction to ensure atomic read-modify-write
  const updateInTransaction = db.transaction(() => {
    const row = selectStmt.get(taskId) as Record<string, unknown> | null;
    if (!row) {
      log.debug("Task not found for state update", { taskId });
      return false;
    }

    const task = rowToTask(row);
    task.state = state;

    const newRow = taskToRow(task);
    const columns = Object.keys(newRow).filter(col => col !== "id");
    // Validate column names to prevent SQL injection
    validateColumnNames(columns);

    // Use UPDATE instead of INSERT OR REPLACE to avoid triggering ON DELETE CASCADE
    // which would delete related records in review_comments table
    const setClause = columns.map(col => `${col} = ?`).join(", ");
    const values = columns.map(col => newRow[col as keyof typeof newRow]) as (string | number | null | Uint8Array)[];
    values.push(taskId); // Add id for WHERE clause

    const updateStmt = db.prepare(`
      UPDATE tasks SET ${setClause} WHERE id = ?
    `);
    updateStmt.run(...values);

    log.debug("Task state updated", { taskId, status: state.status });
    return true;
  });

  return updateInTransaction();
}

/**
 * Update only the config portion of a task.
 * Uses a transaction to ensure atomicity of SELECT + UPDATE.
 */
export async function updateTaskConfig(taskId: string, config: TaskConfig): Promise<boolean> {
  log.debug("Updating task config", { taskId, name: config.name });
  const db = getDatabase();

  // Prepare statements outside transaction
  const selectStmt = db.prepare("SELECT * FROM tasks WHERE id = ?");

  // Use transaction to ensure atomic read-modify-write
  const updateInTransaction = db.transaction(() => {
    const row = selectStmt.get(taskId) as Record<string, unknown> | null;
    if (!row) {
      log.debug("Task not found for config update", { taskId });
      return false;
    }

    const task = rowToTask(row);
    task.config = config;

    const newRow = taskToRow(task);
    const columns = Object.keys(newRow).filter(col => col !== "id");
    // Validate column names to prevent SQL injection
    validateColumnNames(columns);

    // Use UPDATE instead of INSERT OR REPLACE to avoid triggering ON DELETE CASCADE
    // which would delete related records in review_comments table
    const setClause = columns.map(col => `${col} = ?`).join(", ");
    const values = columns.map(col => newRow[col as keyof typeof newRow]) as (string | number | null | Uint8Array)[];
    values.push(taskId); // Add id for WHERE clause

    const updateStmt = db.prepare(`
      UPDATE tasks SET ${setClause} WHERE id = ?
    `);
    updateStmt.run(...values);

    log.debug("Task config updated", { taskId, name: config.name });
    return true;
  });

  return updateInTransaction();
}
