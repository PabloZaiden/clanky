/**
 * Core maintenance operations for destructive settings actions.
 *
 * This service owns connection reset ordering and terminal-task purge
 * orchestration. API routes only apply authorization and response mapping.
 */

import { deleteAndReinitializeDatabase } from "../persistence/database";
import { isArchivedTask } from "../utils";
import { backendManager } from "./backend-manager";
import { DomainError } from "./domain-error";
import { createLogger } from "./logger";
import { taskManager } from "./task-manager";
import { workspaceManager } from "./workspace-manager";

const log = createLogger("core:settings-maintenance");
const ARCHIVED_TASK_PURGE_CONCURRENCY = 4;

type TaskRecord = Awaited<ReturnType<typeof taskManager.getAllTasks>>[number];

export interface ArchivedTaskPurgeSummary {
  workspaceId: string;
  totalArchived: number;
  purgedCount: number;
  purgedTaskIds: string[];
  failures: Array<{ taskId: string; error: string }>;
}

export interface TerminalTaskPurgeResult {
  totalWorkspaces: number;
  totalArchived: number;
  purgedCount: number;
  purgedTaskIds: string[];
  failures: Array<{
    workspaceId: string;
    taskId: string;
    error: string;
  }>;
  workspaces: ArchivedTaskPurgeSummary[];
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
        results[currentIndex] = result.success
          ? { success: true, taskId: task.config.id }
          : {
              success: false,
              taskId: task.config.id,
              error: result.error.message,
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

export class SettingsMaintenanceService {
  async resetAll(): Promise<void> {
    log.debug("Resetting all backend connections before database reset");
    try {
      await backendManager.resetAllConnections();
      log.debug("Deleting and reinitializing database");
      await deleteAndReinitializeDatabase();
    } catch (error) {
      throw new DomainError("reset_failed", String(error), { cause: error });
    }
  }

  async purgeArchivedWorkspaceTasks(
    workspaceId: string,
    tasks?: TaskRecord[],
  ): Promise<ArchivedTaskPurgeSummary> {
    await workspaceManager.requireWorkspace(workspaceId);
    const allTasks = tasks ?? await taskManager.getAllTasks();
    const archivedTasks = allTasks.filter(
      (task) =>
        task.config.workspaceId === workspaceId
        && isArchivedTask(task.state.status, task.state.reviewMode?.addressable),
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

  async purgeTerminalTasks(): Promise<TerminalTaskPurgeResult> {
    try {
      const [workspaces, tasks] = await Promise.all([
        workspaceManager.listWorkspaces(),
        taskManager.getAllTasks(),
      ]);
      const workspacesResults: ArchivedTaskPurgeSummary[] = [];
      for (const workspace of workspaces) {
        workspacesResults.push(
          await this.purgeArchivedWorkspaceTasks(workspace.id, tasks),
        );
      }

      return {
        totalWorkspaces: workspaces.length,
        totalArchived: workspacesResults.reduce(
          (total, result) => total + result.totalArchived,
          0,
        ),
        purgedCount: workspacesResults.reduce(
          (total, result) => total + result.purgedCount,
          0,
        ),
        purgedTaskIds: workspacesResults.flatMap((result) => result.purgedTaskIds),
        failures: workspacesResults.flatMap((result) =>
          result.failures.map((failure) => ({
            workspaceId: result.workspaceId,
            ...failure,
          }))),
        workspaces: workspacesResults,
      };
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        "purge_terminal_tasks_failed",
        `Failed to purge terminal-state tasks: ${String(error)}`,
        { cause: error },
      );
    }
  }
}

export const settingsMaintenanceService = new SettingsMaintenanceService();

export const purgeArchivedWorkspaceTasks = (
  workspaceId: string,
  tasks?: TaskRecord[],
): Promise<ArchivedTaskPurgeSummary> =>
  settingsMaintenanceService.purgeArchivedWorkspaceTasks(workspaceId, tasks);
