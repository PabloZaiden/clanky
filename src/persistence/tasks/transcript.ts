import type { Task } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "../database";
import { rowToTask } from "./helpers";
import { hasLegacyTranscriptColumns, replaceTranscriptEntriesForUser } from "../transcripts/store";

const log = createLogger("persistence:task-transcripts");

export interface LegacyTaskTranscriptMigrationResult {
  candidates: number;
  migratedTasks: number;
  remainingTasks: number;
}

export function replaceTaskTranscriptEntriesForUser(task: Task, userId: string): void {
  replaceTranscriptEntriesForUser("task", task.config.id, userId, task.state);
}

/**
 * Backfill task transcripts before the server accepts requests.
 * Each task is written independently so an interrupted startup can resume.
 */
export function migrateLegacyTaskTranscripts(): LegacyTaskTranscriptMigrationResult {
  const db = getDatabase();
  if (!hasLegacyTranscriptColumns("task")) {
    return { candidates: 0, migratedTasks: 0, remainingTasks: 0 };
  }
  const candidates = db.prepare(`
    SELECT tasks.id, tasks.user_id
    FROM tasks
    LEFT JOIN task_transcript_meta
      ON task_transcript_meta.task_id = tasks.id
      AND task_transcript_meta.user_id = tasks.user_id
    WHERE task_transcript_meta.task_id IS NULL
    ORDER BY tasks.updated_at ASC, tasks.id ASC
  `).all() as Array<{ id: string; user_id: string }>;

  if (candidates.length === 0) {
    return { candidates: 0, migratedTasks: 0, remainingTasks: 0 };
  }

  log.info("Starting legacy task transcript backfill", {
    taskCount: candidates.length,
  });

  const loadTaskRow = db.prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?");
  const clearLegacyTranscript = db.prepare(`
    UPDATE tasks
    SET messages = NULL, logs = NULL, tool_calls = NULL
    WHERE id = ? AND user_id = ?
  `);
  let migratedTasks = 0;
  for (const candidate of candidates) {
    const row = loadTaskRow.get(candidate.id, candidate.user_id) as Record<string, unknown> | null;
    if (!row) {
      throw new Error(`Task disappeared during legacy transcript backfill: ${candidate.id}`);
    }

    try {
      replaceTaskTranscriptEntriesForUser(rowToTask(row), candidate.user_id);
      clearLegacyTranscript.run(candidate.id, candidate.user_id);
    } catch (error) {
      log.error("Failed to backfill legacy task transcript", {
        taskId: candidate.id,
        error: String(error),
      });
      throw new Error(`Failed to migrate legacy task transcript ${candidate.id}`, { cause: error });
    }
    migratedTasks += 1;
  }

  const remainingRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM tasks
    LEFT JOIN task_transcript_meta
      ON task_transcript_meta.task_id = tasks.id
      AND task_transcript_meta.user_id = tasks.user_id
    WHERE task_transcript_meta.task_id IS NULL
  `).get() as { count: number };
  if (remainingRow.count > 0) {
    throw new Error(`Legacy task transcript backfill incomplete: ${remainingRow.count} tasks remain`);
  }

  log.info("Completed legacy task transcript backfill", { migratedTasks });
  return {
    candidates: candidates.length,
    migratedTasks,
    remainingTasks: remainingRow.count,
  };
}
