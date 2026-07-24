/**
 * Task persistence layer for Clanky Tasks Management System.
 * Handles reading and writing task data to SQLite database.
 *
 * Note: Exported functions are marked `async` despite using synchronous
 * bun:sqlite APIs. This is intentional for interface consistency — callers
 * already `await` these functions, and the persistence layer may switch to
 * async storage (e.g., remote database, async I/O) in the future.
 */

export {
  saveTask,
  loadTask,
  loadTaskForUser,
  loadTaskSummary,
  deleteTask,
  listTasks,
  listTasksForUser,
  listTaskSummaries,
  createTaskListSnapshot,
  taskExists,
  updateTaskState,
  updateTaskStateForUser,
  updateTaskConfig,
  getActiveTaskByDirectory,
  isStaleTaskStatus,
  resetStaleTask,
  resetStaleTasks,
  migrateLegacyTaskTranscripts,
  replaceTaskTranscriptEntriesForUser,
} from "./tasks/index";
