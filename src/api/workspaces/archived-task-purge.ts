/**
 * Shared helpers for purging tasks in terminal states.
 */

import { taskManager } from "../../core/task-manager";
import { isArchivedTask } from "../../utils";

const ARCHIVED_TASK_PURGE_CONCURRENCY = 4;

type TaskRecord = Awaited<ReturnType<typeof taskManager.getAllTasks>>[number];

export interface ArchivedTaskPurgeSummary {
  workspaceId: string;
  totalArchived: number;
  purgedCount: number;
  purgedTaskIds: string[];
  failures: Array<{ taskId: string; error: string }>;
}

type ArchivedTaskPurgeResult =
  | { success: true; taskId: string }
  | { success: false; taskId: string; error: string };

async function purgeArchivedTasksWithConcurrency(
  archivedTasks: TaskRecord[],
): Promise<ArchivedTaskPurgeResult[]> {
  const results: ArchivedTaskPurgeResult[] = new Array(archivedTasks.length);
  let nextIndex = 0;

  const workerCount = Math.min(ARCHIVED_TASK_PURGE_CONCURRENCY, archivedTasks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < archivedTasks.length) {
      const currentIndex = nextIndex;
      nextIndex++;
      const task = archivedTasks[currentIndex]!;

      try {
        const result = await taskManager.purgeTask(task.config.id);
        if (result.success) {
          results[currentIndex] = { success: true, taskId: task.config.id };
          continue;
        }

        results[currentIndex] = {
          success: false,
          taskId: task.config.id,
          error: result.error ?? "Unknown error",
        };
      } catch (error) {
        results[currentIndex] = {
          success: false,
          taskId: task.config.id,
          error: String(error),
        };
      }
    }
  });

  await Promise.allSettled(workers);
  return results;
}

export async function purgeArchivedWorkspaceTasks(
  workspaceId: string,
  tasks?: TaskRecord[],
): Promise<ArchivedTaskPurgeSummary> {
  const allTasks = tasks ?? await taskManager.getAllTasks();
  const archivedTasks = allTasks.filter(
    (task) =>
      task.config.workspaceId === workspaceId &&
      isArchivedTask(task.state.status, task.state.reviewMode?.addressable),
  );

  const purgeResults = await purgeArchivedTasksWithConcurrency(archivedTasks);
  const purgedTaskIds = purgeResults
    .filter((result): result is Extract<ArchivedTaskPurgeResult, { success: true }> => result.success)
    .map((result) => result.taskId);
  const failures = purgeResults
    .filter((result): result is Extract<ArchivedTaskPurgeResult, { success: false }> => !result.success)
    .map(({ taskId, error }) => ({ taskId, error }));

  return {
    workspaceId,
    totalArchived: archivedTasks.length,
    purgedCount: purgedTaskIds.length,
    purgedTaskIds,
    failures,
  };
}
