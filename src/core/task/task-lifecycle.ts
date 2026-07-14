import type { TaskCtx } from "./context";
import { createTimestamp } from "@/shared/events";
import {
  loadTask,
  updateTaskConfig,
  updateTaskState,
  deleteTask as deleteTaskFile,
  resetStaleTasks,
} from "../../persistence/tasks";
import { getWorkspace } from "../../persistence/workspaces";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { log } from "../logger";
import { assertValidTransition } from "../task-state-machine";
import { sshSessionManager } from "../ssh-session-manager";
import { taskFailure, taskFailureFromUnknown, type TaskResult } from "./task-errors";

async function deleteLinkedTaskChat(taskId: string): Promise<void> {
  const { chatManager } = await import("../chat-manager");
  await chatManager.deleteTaskChat(taskId);
}

async function disconnectTaskEngine(ctx: TaskCtx, taskId: string): Promise<void> {
  ctx.engines.delete(taskId);
  await backendManager.disconnectTask(taskId);
}

async function detachTaskFromMissingWorkspace(taskId: string): Promise<void> {
  const task = await loadTask(taskId);
  if (!task || !task.config.workspaceId) {
    return;
  }

  const workspace = await getWorkspace(task.config.workspaceId);
  if (workspace) {
    return;
  }

  await updateTaskConfig(taskId, {
    ...task.config,
    workspaceId: "",
    updatedAt: createTimestamp(),
  });
}

async function getTaskGitCleanupContext(workspaceId: string, directory: string): Promise<{
  git: GitService;
  cleanupDirectory: string;
} | null> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    log.warn("Skipping task git cleanup because the workspace record is missing", { workspaceId, directory });
    return null;
  }

  try {
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    const directoryExists = await executor.directoryExists(directory);
    if (!directoryExists) {
      log.warn("Skipping task git cleanup because the workspace directory is unavailable", {
        workspaceId: workspace.id,
        directory,
      });
      return null;
    }

    return {
      git: GitService.withExecutor(executor),
      cleanupDirectory: directory,
    };
  } catch (error) {
    log.warn("Skipping task git cleanup because the workspace host is unavailable", {
      workspaceId: workspace.id,
      directory,
      error: String(error),
    });
    return null;
  }
}

export async function deleteTaskImpl(ctx: TaskCtx, taskId: string): Promise<boolean> {
  log.info("Deleting task", { taskId, hasActiveEngine: ctx.engines.has(taskId) });

  if (ctx.engines.has(taskId)) {
    log.debug(`[TaskManager] deleteTask: Stopping engine for task ${taskId}`);
    await ctx.stopTask(taskId, "Task deleted");
  }

  const task = await loadTask(taskId);
  if (!task) {
    log.debug(`[TaskManager] deleteTask: Task ${taskId} not found`);
    return false;
  }
  log.debug(`[TaskManager] deleteTask: Loaded task ${taskId}, status: ${task.state.status}, hasGitBranch: ${!!task.state.git?.workingBranch}`);

  if (task.state.git?.workingBranch) {
    log.debug(`[TaskManager] deleteTask: Discarding git branch for task ${taskId}`);
    const discardResult = await discardTaskImpl(ctx, taskId);
    if (!discardResult.success) {
      log.warn(`Failed to discard git branch during delete: ${discardResult.error.message}`);
    }
  }

  await detachTaskFromMissingWorkspace(taskId);

  log.debug(`[TaskManager] deleteTask: Updating status to deleted for task ${taskId}`);
  assertValidTransition(task.state.status, "deleted", "deleteTask");
  const updatedState = {
    ...task.state,
    status: "deleted" as const,
    reviewMode: task.state.reviewMode
      ? { ...task.state.reviewMode, addressable: false }
      : undefined,
  };
  await updateTaskState(taskId, updatedState);
  log.debug(`[TaskManager] deleteTask: Status updated to deleted for task ${taskId}`);

  await deleteLinkedTaskChat(taskId);

  ctx.emitter.emit({
    type: "task.deleted",
    taskId,
    timestamp: createTimestamp(),
  });

  log.info("Task deleted", { taskId });
  return true;
}

export async function discardTaskImpl(ctx: TaskCtx, taskId: string): Promise<TaskResult> {
  log.info("Discarding task", { taskId });
  let task = await ctx.getTask(taskId);
  if (!task) {
    return taskFailure("task_not_found", "Task not found", { details: { taskId } });
  }

  if (ctx.engines.has(taskId)) {
    await ctx.stopTask(taskId, "Task discarded");
    task = await ctx.getTask(taskId);
    if (!task) {
      return taskFailure("task_not_found", "Task not found", { details: { taskId } });
    }
  }

  if (!task.state.git) {
    return taskFailure(
      "task_branch_missing",
      "No git branch was created for this task",
      { details: { taskId } },
    );
  }

  try {
    await detachTaskFromMissingWorkspace(taskId);

    if (!task.config.useWorktree) {
      const cleanupContext = await getTaskGitCleanupContext(task.config.workspaceId, task.config.directory);
      if (cleanupContext) {
        await cleanupContext.git.resetHard(cleanupContext.cleanupDirectory, {
          expectedBranch: task.state.git.workingBranch,
        });
        await cleanupContext.git.checkoutBranch(cleanupContext.cleanupDirectory, task.state.git.originalBranch);
      }
    }

    assertValidTransition(task.state.status, "deleted", "discardTask");
    const updatedState = {
      ...task.state,
      status: "deleted" as const,
    };
    await updateTaskState(taskId, updatedState);

    await backendManager.disconnectTask(taskId);

    ctx.engines.delete(taskId);

    await deleteLinkedTaskChat(taskId);

    ctx.emitter.emit({
      type: "task.discarded",
      taskId,
      timestamp: createTimestamp(),
    });

    log.info("Task discarded", { taskId });
    return { success: true };
  } catch (error) {
    return taskFailureFromUnknown(
      error,
      "task_operation_failed",
      "Failed to discard task",
    );
  }
}

export async function purgeTaskImpl(_ctx: TaskCtx, taskId: string): Promise<TaskResult> {
  log.info("Purging task", { taskId });
  const task = await loadTask(taskId);
  if (!task) {
    return taskFailure("task_not_found", "Task not found", { details: { taskId } });
  }

  const isDraft = task.state.status === "draft";

  if (!isDraft && task.state.status !== "accepted_local" && task.state.status !== "merged" && task.state.status !== "pushed" && task.state.status !== "deleted") {
    return taskFailure(
      "invalid_task_state",
      `Cannot purge task in status: ${task.state.status}. Only draft, accepted_local, merged, pushed, or deleted tasks can be purged.`,
      { details: { taskId, status: task.state.status } },
    );
  }

  try {
    await sshSessionManager.deleteSessionByTaskId(taskId);
  } catch (error) {
    return taskFailure(
      "task_ssh_session_failed",
      "Failed to delete linked SSH session",
      { cause: error, details: { taskId } },
    );
  }

  if (!isDraft) {
    try {
      await detachTaskFromMissingWorkspace(taskId);
      const cleanupContext = await getTaskGitCleanupContext(task.config.workspaceId, task.config.directory);
      if (cleanupContext) {
        const { git, cleanupDirectory } = cleanupContext;

        const worktreePath = task.state.git?.worktreePath;
        if (worktreePath) {
          const managedWorktreePath = git.assertCanonicalManagedWorktreePath(
            cleanupDirectory,
            task.config.id,
            worktreePath,
          );
          await git.ensureWorktreeRemoved(cleanupDirectory, managedWorktreePath, { force: true });
          log.debug(`[TaskManager] purgeTask: Removed worktree and pruned metadata for task ${taskId}: ${managedWorktreePath}`);
        }

        const workingBranch = task.state.git?.workingBranch;
        const originalBranch = task.state.git?.originalBranch;
        if (workingBranch && workingBranch !== originalBranch) {
          try {
            await git.deleteBranch(cleanupDirectory, workingBranch);
            log.debug(`[TaskManager] purgeTask: Deleted working branch for task ${taskId}`);
          } catch (error) {
            log.debug(`[TaskManager] purgeTask: Could not delete working branch: ${String(error)}`);
          }
        }

      }
    } catch (error) {
      return taskFailure(
        "task_git_operation_failed",
        "Failed to clean up git state during purge",
        { cause: error, details: { taskId } },
      );
    }
  }

  if (task.state.reviewMode) {
    await detachTaskFromMissingWorkspace(taskId);
    task.state.reviewMode.addressable = false;
    await updateTaskState(taskId, task.state);
  }

  const deleted = await deleteTaskFile(taskId);
  if (!deleted) {
    return taskFailure(
      "task_file_operation_failed",
      "Failed to delete task file",
      { details: { taskId } },
    );
  }

  await deleteLinkedTaskChat(taskId);

  log.info("Task purged", { taskId });
  return { success: true };
}

export async function markMergedImpl(ctx: TaskCtx, taskId: string): Promise<TaskResult> {
  log.info("Marking task as merged", { taskId });
  const task = await ctx.getTask(taskId);
  if (!task) {
    return taskFailure("task_not_found", "Task not found", { details: { taskId } });
  }

  const allowedStatuses = ["pushed", "merged"];
  if (!allowedStatuses.includes(task.state.status)) {
    return taskFailure(
      "invalid_task_state",
      `Cannot mark task as merged in status: ${task.state.status}. Only finished tasks can be marked as merged.`,
      { details: { taskId, status: task.state.status } },
    );
  }

  const persistedTask = await loadTask(taskId);
  const gitState = persistedTask ? persistedTask.state.git : task.state.git;

  if (!gitState) {
    return taskFailure(
      "task_branch_missing",
      "No git branch was created for this task",
      { details: { taskId } },
    );
  }

  try {
    const nextStatus = "merged" as const;
    if (task.state.status === nextStatus) {
      log.info("Task already marked as merged", { taskId });
      return { success: true };
    }
    assertValidTransition(task.state.status, nextStatus, "markMerged");

    const updatedState = {
      ...task.state,
      status: nextStatus,
      reviewMode: task.state.reviewMode
        ? { ...task.state.reviewMode, addressable: false }
        : undefined,
    };
    await updateTaskState(taskId, updatedState);

    await backendManager.disconnectTask(taskId);

    ctx.engines.delete(taskId);

    ctx.emitter.emit({
      type: "task.merged",
      taskId,
      timestamp: createTimestamp(),
    });

    log.info("Task marked as merged", { taskId });
    return { success: true };
  } catch (error) {
    return taskFailureFromUnknown(
      error,
      "task_operation_failed",
      "Failed to mark task as merged",
    );
  }
}

export async function closeLocalTaskImpl(ctx: TaskCtx, taskId: string): Promise<TaskResult> {
  log.info("Closing locally accepted task", { taskId });
  const task = await ctx.getTask(taskId);
  if (!task) {
    return taskFailure("task_not_found", "Task not found", { details: { taskId } });
  }

  if (task.state.status !== "accepted_local") {
    return taskFailure(
      "invalid_task_state",
      `Cannot close local task in status: ${task.state.status}. Only locally accepted tasks can be closed.`,
      { details: { taskId, status: task.state.status } },
    );
  }

  if (!task.state.reviewMode?.addressable) {
    log.info("Locally accepted task already closed", { taskId });
    return { success: true };
  }

  try {
    assertValidTransition(task.state.status, "accepted_local", "closeLocalTask");
    await updateTaskState(taskId, {
      ...task.state,
      reviewMode: {
        ...task.state.reviewMode,
        addressable: false,
      },
    });

    await backendManager.disconnectTask(taskId);
    ctx.engines.delete(taskId);

    log.info("Locally accepted task closed", { taskId });
    return { success: true };
  } catch (error) {
    return taskFailureFromUnknown(
      error,
      "task_operation_failed",
      "Failed to close local task",
    );
  }
}

export async function manualCompleteTaskImpl(ctx: TaskCtx, taskId: string): Promise<TaskResult> {
  log.info("Manually completing task", { taskId });
  const task = await ctx.getTask(taskId);
  if (!task) {
    return taskFailure("task_not_found", "Task not found", { details: { taskId } });
  }

  const allowedStatuses = new Set(["stopped", "failed"]);
  if (!allowedStatuses.has(task.state.status)) {
    return taskFailure(
      "invalid_task_state",
      `Cannot manually complete task in status: ${task.state.status}. Only stopped or failed tasks can be manually completed.`,
      { details: { taskId, status: task.state.status } },
    );
  }

  const persistedTask = await loadTask(taskId);
  const gitState = persistedTask ? persistedTask.state.git : task.state.git;
  if (!gitState) {
    return taskFailure(
      "task_branch_missing",
      "No git branch was created for this task",
      { details: { taskId } },
    );
  }

  try {
    assertValidTransition(task.state.status, "completed", "manualCompleteTask");

    const updatedState = {
      ...task.state,
      status: "completed" as const,
      completedAt: createTimestamp(),
      error: undefined,
      consecutiveErrors: undefined,
      git: gitState,
    };

    const engine = ctx.engines.get(taskId);
    if (engine) {
      Object.assign(engine.state, updatedState);
      await disconnectTaskEngine(ctx, taskId);
    }

    await updateTaskState(taskId, updatedState);

    ctx.emitter.emit({
      type: "task.completed",
      taskId,
      totalIterations: task.state.currentIteration,
      timestamp: createTimestamp(),
    });

    log.info("Task manually completed", { taskId, previousStatus: task.state.status });
    return { success: true };
  } catch (error) {
    return taskFailureFromUnknown(
      error,
      "task_operation_failed",
      "Failed to manually complete task",
    );
  }
}

export async function shutdownImpl(ctx: TaskCtx): Promise<void> {
  const promises = Array.from(ctx.engines.keys()).map((taskId) =>
    ctx.stopTask(taskId, "Server shutdown")
  );
  await Promise.allSettled(promises);
}

export async function forceResetAllImpl(ctx: TaskCtx): Promise<{ enginesCleared: number; tasksReset: number }> {
  const engineCount = ctx.engines.size;

  const stopPromises = Array.from(ctx.engines.entries()).map(async ([taskId, engine]) => {
    try {
      if (engine.state.status === "planning") {
        log.info(`Preserving planning task ${taskId} status during force reset`);
        await updateTaskState(taskId, engine.state);
        await engine.abortSessionOnly();
      } else {
        await engine.stop("Force reset by user");
        await updateTaskState(taskId, engine.state);
      }
    } catch (error) {
      log.warn(`Failed to stop engine ${taskId} during force reset: ${String(error)}`);
    }
  });

  await Promise.allSettled(stopPromises);

  ctx.engines.clear();
  ctx.tasksBeingAccepted.clear();

  const tasksReset = await resetStaleTasks();

  await backendManager.resetAllConnections();

  log.info(`Force reset completed: ${engineCount} engines cleared, ${tasksReset} tasks reset in database`);

  return {
    enginesCleared: engineCount,
    tasksReset,
  };
}

export function resetForTestingImpl(ctx: TaskCtx): void {
  ctx.engines.clear();
  ctx.tasksBeingAccepted.clear();
}
