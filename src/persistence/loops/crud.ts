/**
 * Basic CRUD operations for loops persistence.
 */

import type { Loop } from "../../types";
import { getDatabase } from "../database";
import { createLogger } from "../../core/logger";
import { loopToRow, rowToLoop, validateColumnNames } from "./helpers";

const log = createLogger("persistence:loops");

const LOOP_LIST_COLUMNS = [
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

export function createLoopListSnapshot(loop: Loop): Loop {
  return {
    config: loop.config,
    state: {
      ...loop.state,
      logs: [],
      messages: [],
      toolCalls: [],
      planMode: loop.state.planMode
        ? {
          ...loop.state.planMode,
          planContent: undefined,
        }
        : undefined,
    },
  };
}

/**
 * Save a loop to the database.
 * Uses INSERT ... ON CONFLICT DO UPDATE (upsert) to avoid triggering
 * ON DELETE CASCADE which would destroy related records (e.g. review_comments).
 */
export async function saveLoop(loop: Loop): Promise<void> {
  log.debug("Saving loop", { id: loop.config.id, name: loop.config.name, status: loop.state.status });
  const db = getDatabase();
  const row = loopToRow(loop);

  const columns = Object.keys(row);
  // Validate column names to prevent SQL injection
  validateColumnNames(columns);

  const placeholders = columns.map(() => "?").join(", ");
  const values = Object.values(row) as (string | number | null | Uint8Array)[];

  // Build the ON CONFLICT UPDATE clause for all columns except 'id'
  const updateColumns = columns.filter(col => col !== "id");
  const updateClause = updateColumns.map(col => `${col} = excluded.${col}`).join(", ");

  const stmt = db.prepare(`
    INSERT INTO loops (${columns.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updateClause}
  `);

  stmt.run(...values);
  log.debug("Loop saved to database", { id: loop.config.id });
}

/**
 * Load a loop from the database by ID.
 * Returns null if the loop doesn't exist.
 */
export async function loadLoop(loopId: string): Promise<Loop | null> {
  log.debug("Loading loop", { loopId });
  const db = getDatabase();

  const stmt = db.prepare("SELECT * FROM loops WHERE id = ?");
  const row = stmt.get(loopId) as Record<string, unknown> | null;

  if (!row) {
    log.debug("Loop not found", { loopId });
    return null;
  }

  const loop = rowToLoop(row);
  log.debug("Loop loaded", { loopId, status: loop.state.status });
  return loop;
}

/**
 * Delete a loop from the database.
 * Returns true if deleted, false if it didn't exist.
 */
export async function deleteLoop(loopId: string): Promise<boolean> {
  log.debug("Deleting loop", { loopId });
  const db = getDatabase();

  const stmt = db.prepare("DELETE FROM loops WHERE id = ?");
  const result = stmt.run(loopId);

  const deleted = result.changes > 0;
  if (deleted) {
    log.info("Loop deleted", { loopId });
  } else {
    log.debug("Loop not found for deletion", { loopId });
  }
  return deleted;
}

/**
 * List all loops from the database.
 * Sorted by creation date, newest first.
 */
export async function listLoops(): Promise<Loop[]> {
  log.debug("Listing all loops");
  const db = getDatabase();

  const stmt = db.prepare("SELECT * FROM loops ORDER BY created_at DESC");
  const rows = stmt.all() as Record<string, unknown>[];

  const loops = rows.map(rowToLoop);
  log.debug("Loops listed", { count: loops.length });
  return loops;
}

/**
 * List lightweight loop snapshots for collection endpoints.
 *
 * Excludes persisted transcript fields that are only needed by detail routes:
 * logs, messages, tool calls, and plan content.
 */
export async function listLoopSummaries(): Promise<Loop[]> {
  log.debug("Listing loop summaries");
  const db = getDatabase();

  const stmt = db.prepare(`SELECT ${LOOP_LIST_COLUMNS} FROM loops ORDER BY created_at DESC`);
  const rows = stmt.all() as Record<string, unknown>[];

  const loops = rows.map((row) => createLoopListSnapshot(rowToLoop(row)));
  log.debug("Loop summaries listed", { count: loops.length });
  return loops;
}

/**
 * Check if a loop exists.
 */
export async function loopExists(loopId: string): Promise<boolean> {
  log.debug("Checking if loop exists", { loopId });
  const db = getDatabase();

  const stmt = db.prepare("SELECT 1 FROM loops WHERE id = ? LIMIT 1");
  const row = stmt.get(loopId);

  const exists = row !== null;
  log.debug("Loop exists check result", { loopId, exists });
  return exists;
}
