import type { TaskCtx } from "./context";
import type { Task } from "@/shared/task";
import { createTimestamp } from "@/shared/events";
import {
  loadTask,
  updateTaskOperationalState,
  deleteTask as deleteTaskFile,
  resetStaleTasks,
} from "../../persistence/tasks";
import { getWorkspace } from "../../persistence/workspaces";
import { backendManager } from "../backend-manager";
import { GitService } from "../git";
import { log } from "@pablozaiden/webapp/server";
import { assertValidTransition } from "../task-state-machine";
import { terminalSessionManager } from "../terminal-session-manager";
import { managedContextIdentityResolver } from "../managed-context-identity";
import { managedCredentialService } from "../managed-credential-service";
import { taskFailure, taskFailureFromUnknown, type TaskResult } from "./task-errors";
import { resolveCommandExecutorDirectory } from "../command-executor";
import { assertTaskHarnessWorkspaceSafe } from "./task-harness";
import type { TaskEngine } from "../task-engine";
import { getCurrentUser, runWithCurrentUser } from "../../context/user-context";
import {
  runTaskLifecycleOperation,
  runTaskLifecycleOperationWithDeferredCleanup,
} from "./task-lifecycle-operations";

type TaskCleanupOperation = "delete" | "discard" | "purge";

async function disconnectTaskEngine(ctx: TaskCtx, taskId: string): Promise<void> {
  ctx.engines.delete(taskId);
  await backendManager.disconnectTask(taskId);
}

async function deleteLinkedTaskChat(
  taskId: string,
  operation: TaskCleanupOperation,
): Promise<{ cleanup: Promise<boolean> }> {
  try {
    const { chatManager } = await import("../chat-manager");
    const result = await chatManager.deleteTaskChat(taskId);
    return { cleanup: result.cleanup };
  } catch (error) {
    log.warn("Failed to delete linked task chat after task deletion", {
      taskId,
      operation,
      error: String(error),
    });
    return { cleanup: Promise.resolve(false) };
  }
}

async function revokeTaskContext(task: Task): Promise<void> {
  const identity = managedContextIdentityResolver.forTaskSnapshot(task);
  await managedCredentialService.revokeContextIfConfigured(identity);
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
    const cleanupDirectory = await resolveCommandExecutorDirectory(
      executor,
      directory,
    );
    const directoryExists = await executor.directoryExists(cleanupDirectory);
    if (!directoryExists) {
      log.warn("Skipping task git cleanup because the workspace directory is unavailable", {
        workspaceId: workspace.id,
        directory,
      });
      return null;
    }

    return {
      git: GitService.withExecutor(executor),
      cleanupDirectory,
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

async function markTaskDeleted(
  task: Task,
  operation: "deleteTask" | "discardTask",
): Promise<Task | null> {
  if (task.state.status !== "deleted") {
    assertValidTransition(task.state.status, "deleted", operation);
  }

  const updatedState = {
    ...task.state,
    status: "deleted" as const,
    reviewMode: task.state.reviewMode
      ? { ...task.state.reviewMode, addressable: false }
      : undefined,
  };
  const saved = await updateTaskOperationalState(task.config.id, updatedState);
  return saved ? { ...task, state: updatedState } : null;
}

function needsTaskGitCleanup(task: Task, operation: TaskCleanupOperation): boolean {
  if (operation === "purge") {
    return task.state.status !== "draft"
      && Boolean(task.state.git?.worktreePath || task.state.git?.workingBranch);
  }
  return !task.config.useWorktree && Boolean(task.state.git?.workingBranch);
}

async function runDeferredTaskCleanupStep(
  taskId: string,
  operation: TaskCleanupOperation,
  step: string,
  cleanup: () => Promise<unknown>,
): Promise<boolean> {
  try {
    const result = await cleanup();
    if (result === false) {
      log.warn("Deferred task cleanup step reported incomplete", {
        taskId,
        operation,
        step,
      });
      return false;
    }
    return true;
  } catch (error) {
    log.warn("Deferred task cleanup step failed", {
      taskId,
      operation,
      step,
      error: String(error),
    });
    return false;
  }
}

async function stopTaskRuntimeForDeletion(
  ctx: TaskCtx,
  task: Task,
  engine: TaskEngine | undefined,
  operation: TaskCleanupOperation,
): Promise<boolean> {
  const needsGitCleanup = needsTaskGitCleanup(task, operation);
  let workspaceSafe = !needsGitCleanup;
  if (engine) {
    try {
      const engineWorkspaceSafe = await engine.stopForDeletion();
      workspaceSafe = !needsGitCleanup || engineWorkspaceSafe;
    } catch (error) {
      workspaceSafe = !needsGitCleanup;
      log.warn("Failed to stop task engine during deferred cleanup", {
        taskId: task.config.id,
        operation,
        error: String(error),
      });
    }
  } else if (needsGitCleanup) {
    try {
      await assertTaskHarnessWorkspaceSafe(ctx, task.config.id, {
        requireFinalCommit: false,
        taskSnapshot: task,
        persistProjection: operation !== "purge",
      });
      workspaceSafe = true;
    } catch (error) {
      workspaceSafe = false;
      log.warn("Skipping task Git cleanup because workspace safety could not be confirmed", {
        taskId: task.config.id,
        operation,
        error: String(error),
      });
    }
  }

  const disconnectedSuccessfully = await runDeferredTaskCleanupStep(
    task.config.id,
    operation,
    "provider session",
    () => backendManager.disconnectTask(task.config.id),
  );
  if (needsGitCleanup && !workspaceSafe) {
    log.warn("Skipping task Git cleanup because workspace safety could not be confirmed", {
      taskId: task.config.id,
      operation,
    });
  }
  return workspaceSafe && disconnectedSuccessfully;
}

async function cleanupTaskGit(
  task: Task,
  operation: TaskCleanupOperation,
): Promise<void> {
  const gitState = task.state.git;
  if (!gitState) {
    return;
  }

  const cleanupContext = await getTaskGitCleanupContext(
    task.config.workspaceId,
    task.config.directory,
  );
  if (!cleanupContext) {
    return;
  }

  const { git, cleanupDirectory } = cleanupContext;
  if (operation === "purge") {
    if (task.state.status === "draft") {
      return;
    }
    const worktreePath = gitState.worktreePath;
    if (worktreePath) {
      const managedWorktreePath = await git.assertCanonicalManagedWorktreePath(
        cleanupDirectory,
        task.config.id,
        worktreePath,
      );
      await git.ensureWorktreeRemoved(cleanupDirectory, managedWorktreePath, { force: true });
      log.debug("Removed task worktree and pruned metadata", {
        taskId: task.config.id,
        worktreePath: managedWorktreePath,
      });
    }

    const workingBranch = gitState.workingBranch;
    if (workingBranch && workingBranch !== gitState.originalBranch) {
      try {
        await git.deleteBranch(cleanupDirectory, workingBranch);
        log.debug("Deleted task working branch", { taskId: task.config.id, workingBranch });
      } catch (error) {
        log.warn("Could not delete task working branch", {
          taskId: task.config.id,
          workingBranch,
          error: String(error),
        });
      }
    }
    return;
  }

  if (!task.config.useWorktree && gitState.workingBranch && gitState.originalBranch) {
    await git.resetHard(cleanupDirectory, {
      expectedBranch: gitState.workingBranch,
    });
    await git.checkoutBranch(cleanupDirectory, gitState.originalBranch);
  }
}

function createDeferredTaskCleanup(
  ctx: TaskCtx,
  task: Task,
  engine: TaskEngine | undefined,
  operation: TaskCleanupOperation,
  linkedChatCleanup: Promise<boolean>,
): () => Promise<void> {
  const user = getCurrentUser();
  return async () => {
    if (!user) {
      log.error("Cannot run deferred task cleanup without a current user", {
        taskId: task.config.id,
        operation,
      });
      return;
    }

    await runWithCurrentUser(user, async () => {
      const runtimeCleanup = stopTaskRuntimeForDeletion(ctx, task, engine, operation);
      const terminalSessionCleanup = runDeferredTaskCleanupStep(
        task.config.id,
        operation,
        "terminal session",
        () => terminalSessionManager.deleteSessionByTaskId(task.config.id),
      );
      const credentialCleanup = runDeferredTaskCleanupStep(
        task.config.id,
        operation,
        "managed credentials",
        () => revokeTaskContext(task),
      );
      const [runtimeSafe, terminalSessionCleaned, , chatCleaned] = await Promise.all([
        runtimeCleanup,
        terminalSessionCleanup,
        credentialCleanup,
        linkedChatCleanup,
      ]);

      if (!needsTaskGitCleanup(task, operation)) {
        return;
      }
      if (!runtimeSafe || !terminalSessionCleaned || !chatCleaned) {
        log.warn("Skipping task Git cleanup because workspace writers could not be stopped", {
          taskId: task.config.id,
          operation,
        });
        return;
      }
      await runDeferredTaskCleanupStep(
        task.config.id,
        operation,
        "Git",
        () => cleanupTaskGit(task, operation),
      );
    });
  };
}

function takeTaskEngineForCleanup(ctx: TaskCtx, taskId: string): TaskEngine | undefined {
  const engine = ctx.engines.get(taskId);
  ctx.engines.delete(taskId);
  return engine;
}

export async function deleteTaskImpl(ctx: TaskCtx, taskId: string): Promise<boolean> {
  return await runTaskLifecycleOperationWithDeferredCleanup(
    taskId,
    async (deferCleanup) => {
      log.info("Deleting task", { taskId, hasActiveEngine: ctx.engines.has(taskId) });
      const task = await loadTask(taskId);
      if (!task) {
        log.debug("Task not found during delete", { taskId });
        return false;
      }

      const deletedTask = await markTaskDeleted(task, "deleteTask");
      if (!deletedTask) {
        return false;
      }

      const engine = takeTaskEngineForCleanup(ctx, taskId);
      ctx.emitter.emit({
        type: "task.deleted",
        taskId,
        timestamp: createTimestamp(),
      });
      const linkedChatDeletion = await deleteLinkedTaskChat(taskId, "delete");
      deferCleanup(createDeferredTaskCleanup(ctx, deletedTask, engine, "delete", linkedChatDeletion.cleanup));

      log.info("Task deleted", { taskId });
      return true;
    },
    (error) => {
      log.error("Deferred task cleanup failed", {
        taskId,
        operation: "delete",
        error: String(error),
      });
    },
  );
}

export async function discardTaskImpl(ctx: TaskCtx, taskId: string): Promise<TaskResult> {
  return await runTaskLifecycleOperationWithDeferredCleanup(
    taskId,
    async (deferCleanup) => {
      log.info("Discarding task", { taskId });
      const task = await ctx.getTask(taskId);
      if (!task) {
        return taskFailure("task_not_found", "Task not found", { details: { taskId } });
      }

      try {
        const deletedTask = await markTaskDeleted(task, "discardTask");
        if (!deletedTask) {
          return taskFailure("task_not_found", "Task not found", { details: { taskId } });
        }

        const engine = takeTaskEngineForCleanup(ctx, taskId);
        ctx.emitter.emit({
          type: "task.discarded",
          taskId,
          timestamp: createTimestamp(),
        });
        const linkedChatDeletion = await deleteLinkedTaskChat(taskId, "discard");
        deferCleanup(createDeferredTaskCleanup(ctx, deletedTask, engine, "discard", linkedChatDeletion.cleanup));

        log.info("Task discarded", { taskId });
        return { success: true };
      } catch (error) {
        return taskFailureFromUnknown(
          error,
          "task_operation_failed",
          "Failed to discard task",
        );
      }
    },
    (error) => {
      log.error("Deferred task cleanup failed", {
        taskId,
        operation: "discard",
        error: String(error),
      });
    },
  );
}

export async function purgeTaskImpl(ctx: TaskCtx, taskId: string): Promise<TaskResult> {
  return await runTaskLifecycleOperationWithDeferredCleanup(
    taskId,
    async (deferCleanup) => {
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

      const deleted = await deleteTaskFile(taskId);
      if (!deleted) {
        return taskFailure(
          "task_file_operation_failed",
          "Failed to delete task file",
          { details: { taskId } },
        );
      }

      const engine = takeTaskEngineForCleanup(ctx, taskId);
      const linkedChatDeletion = await deleteLinkedTaskChat(taskId, "purge");
      deferCleanup(createDeferredTaskCleanup(ctx, task, engine, "purge", linkedChatDeletion.cleanup));

      log.info("Task purged", { taskId });
      return { success: true };
    },
    (error) => {
      log.error("Deferred task cleanup failed", {
        taskId,
        operation: "purge",
        error: String(error),
      });
    },
  );
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
    await updateTaskOperationalState(taskId, updatedState);

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
    await updateTaskOperationalState(taskId, {
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
  await ctx.engines.get(taskId)?.waitForCompletionSettlement();
  return await runTaskLifecycleOperation(taskId, () => manualCompleteTaskLocked(ctx, taskId));
}

async function manualCompleteTaskLocked(ctx: TaskCtx, taskId: string): Promise<TaskResult> {
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
    await assertTaskHarnessWorkspaceSafe(ctx, taskId, {
      requireFinalCommit: false,
      lifecycleOperationLocked: true,
    });
    const settledTask = await ctx.getTask(taskId);
    if (!settledTask) {
      return taskFailure("task_not_found", "Task not found", { details: { taskId } });
    }
    if (!allowedStatuses.has(settledTask.state.status)) {
      return taskFailure(
        "invalid_task_state",
        `Cannot manually complete task in status: ${settledTask.state.status}. Only stopped or failed tasks can be manually completed.`,
        { details: { taskId, status: settledTask.state.status } },
      );
    }
    const settledGitState = settledTask.state.git;
    if (!settledGitState) {
      return taskFailure(
        "task_branch_missing",
        "No git branch was created for this task",
        { details: { taskId } },
      );
    }

    assertValidTransition(settledTask.state.status, "completed", "manualCompleteTask");

    const updatedState = {
      ...settledTask.state,
      status: "completed" as const,
      completedAt: createTimestamp(),
      error: undefined,
      consecutiveErrors: undefined,
      git: settledGitState,
    };

    const engine = ctx.engines.get(taskId);
    if (engine) {
      Object.assign(engine.state, updatedState);
      await disconnectTaskEngine(ctx, taskId);
    }

    await updateTaskOperationalState(taskId, updatedState);

    ctx.emitter.emit({
      type: "task.completed",
      taskId,
      totalIterations: settledTask.state.currentIteration,
      timestamp: createTimestamp(),
    });

    log.info("Task manually completed", { taskId, previousStatus: settledTask.state.status });
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
  const results = await Promise.allSettled(
    Array.from(ctx.engines, async ([taskId, engine]) => {
      await engine.shutdown();
      if (ctx.engines.get(taskId) === engine) ctx.engines.delete(taskId);
    }),
  );
  const errors: unknown[] = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length > 0) throw new AggregateError(errors, "Failed to checkpoint tasks during shutdown.");
}

export async function forceResetAllImpl(ctx: TaskCtx): Promise<{ enginesCleared: number; tasksReset: number }> {
  const engineCount = ctx.engines.size;

  const stopPromises = Array.from(ctx.engines.entries()).map(async ([taskId, engine]) => {
    try {
      if (engine.state.status === "planning") {
        log.info(`Preserving planning task ${taskId} status during force reset`);
        await updateTaskOperationalState(taskId, engine.state);
        await engine.abortSessionOnly();
      } else {
        await engine.stop("Force reset by user");
        await updateTaskOperationalState(taskId, engine.state);
      }
    } catch (error) {
      log.warn(`Failed to stop engine ${taskId} during force reset: ${String(error)}`);
    }
  });

  await Promise.allSettled(stopPromises);

  ctx.engines.clear();
  ctx.tasksBeingAccepted.clear();
  ctx.tasksBeingStarted.clear();

  const tasksReset = await resetStaleTasks();

  await backendManager.resetAllConnections();

  log.info(`Force reset completed: ${engineCount} engines cleared, ${tasksReset} tasks reset in database`);

  return {
    enginesCleared: engineCount,
    tasksReset,
  };
}
