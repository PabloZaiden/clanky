/**
 * Partial update operations for tasks persistence.
 * Handles atomic state and config updates via transactions.
 */

import type { TaskConfig, TaskState, TranscriptChangeSet } from "@/shared";
import { createTranscriptChangeSet } from "@/shared";
import { getDatabase } from "../database";
import { createLogger } from "@pablozaiden/webapp/server";
import { taskToRow, rowToTask, validateColumnNames } from "./helpers";
import { requirePersistenceUserId } from "../ownership";
import {
  applyTranscriptChangeSetInTransaction,
  hydrateTranscriptStateForUser,
  syncTranscriptEntriesInTransaction,
} from "../transcripts/store";
import { TASK_LIST_COLUMNS } from "./crud";

const log = createLogger("persistence:tasks");

/**
 * Update only the state portion of a task.
 * Uses a transaction to ensure atomicity of SELECT + UPDATE.
 */
export async function updateTaskState(
  taskId: string,
  state: TaskState,
  options: UpdateTaskStateOptions = {},
): Promise<boolean> {
  log.debug("Updating task state", { taskId, status: state.status });
  return updateTaskStateForUser(taskId, state, requirePersistenceUserId(), options);
}

export interface UpdateTaskStateOptions {
  previousState?: TaskState;
  transcriptChanges?: TranscriptChangeSet;
}

/**
 * Persist task metadata without treating its in-memory transcript as a change.
 *
 * Active engines provide explicit change sets. This helper is for lifecycle
 * operations that only update task-owned operational fields after a stream
 * checkpoint has already been written.
 */
export async function updateTaskOperationalState(
  taskId: string,
  state: TaskState,
): Promise<boolean> {
  return updateTaskState(taskId, state, {
    transcriptChanges: createTranscriptChangeSet(state),
  });
}

export async function updateTaskStateForUser(
  taskId: string,
  state: TaskState,
  userId: string,
  options: UpdateTaskStateOptions = {},
): Promise<boolean> {
  const db = getDatabase();
  // Prepare statements outside transaction
  const selectStmt = db.prepare(`SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE id = ? AND user_id = ?`);

  // Use transaction to ensure atomic read-modify-write
  const updateInTransaction = db.transaction(() => {
    const row = selectStmt.get(taskId, userId) as Record<string, unknown> | null;
    if (!row) {
      log.debug("Task not found for state update", { taskId });
      return false;
    }

    const task = rowToTask(row);
    task.state = state;

    const newRow = taskToRow(task);
    const columns = Object.keys(newRow).filter(col => col !== "id" && col !== "user_id");
    // Validate column names to prevent SQL injection
    validateColumnNames(columns);

    // Use UPDATE instead of INSERT OR REPLACE to avoid triggering ON DELETE CASCADE
    // which would delete related records in review_comments table
    const setClause = columns.map(col => `${col} = ?`).join(", ");
    const values = columns.map(col => newRow[col as keyof typeof newRow]) as (string | number | null | Uint8Array)[];
    values.push(taskId, userId); // Add id and user_id for WHERE clause

    const updateStmt = db.prepare(`
      UPDATE tasks SET ${setClause} WHERE id = ? AND user_id = ?
    `);
    updateStmt.run(...values);
    if (options.transcriptChanges) {
      applyTranscriptChangeSetInTransaction(
        db,
        "task",
        taskId,
        userId,
        options.transcriptChanges,
      );
    } else {
      const previousState = options.previousState ?? (() => {
        const transcript = hydrateTranscriptStateForUser("task", taskId, userId);
        return {
          ...state,
          messages: transcript.messages,
          logs: transcript.logs,
          toolCalls: transcript.toolCalls,
        };
      })();
      syncTranscriptEntriesInTransaction(
        db,
        "task",
        taskId,
        userId,
        previousState,
        state,
      );
    }

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
  const userId = requirePersistenceUserId();

  // Prepare statements outside transaction
  const selectStmt = db.prepare(`SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE id = ? AND user_id = ?`);

  // Use transaction to ensure atomic read-modify-write
  const updateInTransaction = db.transaction(() => {
    const row = selectStmt.get(taskId, userId) as Record<string, unknown> | null;
    if (!row) {
      log.debug("Task not found for config update", { taskId });
      return false;
    }

    const task = rowToTask(row);
    task.config = config;

    const newRow = taskToRow(task);
    const columns = Object.keys(newRow).filter(col => col !== "id" && col !== "user_id");
    // Validate column names to prevent SQL injection
    validateColumnNames(columns);

    // Use UPDATE instead of INSERT OR REPLACE to avoid triggering ON DELETE CASCADE
    // which would delete related records in review_comments table
    const setClause = columns.map(col => `${col} = ?`).join(", ");
    const values = columns.map(col => newRow[col as keyof typeof newRow]) as (string | number | null | Uint8Array)[];
    values.push(taskId, userId); // Add id and user_id for WHERE clause

    const updateStmt = db.prepare(`
      UPDATE tasks SET ${setClause} WHERE id = ? AND user_id = ?
    `);
    updateStmt.run(...values);

    log.debug("Task config updated", { taskId, name: config.name });
    return true;
  });

  return updateInTransaction();
}
