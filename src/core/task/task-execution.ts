import type { TaskCtx } from "./context";
import type { Task } from "@/shared/task";
import type { StartTaskOptions } from "./task-types";
import { TaskEngine } from "../task-engine";
import { createTimestamp } from "@/shared/events";
import { loadTask, updateTaskState } from "../../persistence/tasks";
import { backendManager } from "../backend-manager";
import { GitService } from "../git";
import { log } from "../logger";
import { assertValidTransition } from "../task-state-machine";
import { startStatePersistenceImpl } from "./task-state-persistence";
import { validateMainCheckoutStartImpl } from "./task-git-validation";
import { clearPlanningFilesImpl } from "./task-planning-files";
import { handleFullyAutonomousCompletionImpl } from "./task-fully-autonomous";
import { TaskOperationError } from "./task-errors";

export { startStatePersistenceImpl } from "./task-state-persistence";
export { validateMainCheckoutStartImpl, ensureTaskBranchCheckedOutImpl } from "./task-git-validation";
export { clearPlanningFilesImpl } from "./task-planning-files";
export { recoverPlanningEngineImpl } from "./task-engine-recovery";

export async function startTaskImpl(ctx: TaskCtx, taskId: string, _options?: StartTaskOptions): Promise<void> {
  const task = await loadTask(taskId);
  if (!task) {
    throw new TaskOperationError("task_not_found", "Task not found", {
      details: { taskId },
    });
  }

  if (ctx.engines.has(taskId)) {
    throw new TaskOperationError("task_already_running", "Task is already running", {
      details: { taskId },
    });
  }

  log.info("Starting task execution", {
    taskId,
    workspaceId: task.config.workspaceId,
    mode: task.config.mode,
  });

  const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, task.config.directory);
  const git = GitService.withExecutor(executor);

  await validateMainCheckoutStartImpl(ctx, task, git);

  const backend = backendManager.getTaskBackend(taskId, task.config.workspaceId);

  const engine = new TaskEngine({
    task,
    backend,
    gitService: git,
    eventEmitter: ctx.emitter,
    onPersistState: async (state) => {
      await updateTaskState(taskId, state);
    },
    onCompleted: async () => {
      await handleFullyAutonomousCompletionImpl(ctx, taskId);
    },
    initialPromptAttachments: _options?.attachments,
  });

  ctx.engines.set(taskId, engine);

  startStatePersistenceImpl(ctx, taskId);

  log.info("Task execution started", {
    taskId,
    workspaceId: task.config.workspaceId,
  });
  engine.start().catch((error) => {
    log.error("Task execution failed after start", {
      taskId,
      error: String(error),
    });
  });
}

export async function stopTaskImpl(ctx: TaskCtx, taskId: string, reason = "User requested stop"): Promise<void> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    throw new TaskOperationError("task_not_running", "Task is not running", {
      details: { taskId },
    });
  }

  log.info("Stopping task execution", { taskId, reason });
  try {
    await engine.stop(reason);
    await engine.waitForTaskIdle();
  } finally {
    ctx.engines.delete(taskId);
    await backendManager.disconnectTask(taskId);
  }

  if (engine.state.syncState?.autoPushOnComplete) {
    engine.state.syncState.autoPushOnComplete = false;
  }

  await updateTaskState(taskId, engine.state);
  log.info("Task execution stopped", { taskId, reason, status: engine.state.status });
}

export async function startPlanModeImpl(ctx: TaskCtx, taskId: string, options?: StartTaskOptions): Promise<void> {
  const task = await loadTask(taskId);
  if (!task) {
    throw new TaskOperationError("task_not_found", "Task not found", {
      details: { taskId },
    });
  }

  if (task.state.status !== "planning") {
    throw new TaskOperationError(
      "task_not_planning",
      `Task is not in planning status: ${task.state.status}`,
      { details: { taskId, status: task.state.status } },
    );
  }

  if (ctx.engines.has(taskId)) {
    throw new TaskOperationError(
      "task_already_running",
      "Task plan mode is already running",
      { details: { taskId } },
    );
  }

  log.info("Starting task plan mode", {
    taskId,
    workspaceId: task.config.workspaceId,
  });

  const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, task.config.directory);
  const git = GitService.withExecutor(executor);

  await validateMainCheckoutStartImpl(ctx, task, git);

  if (!task.state.startedAt) {
    task.state.startedAt = createTimestamp();
  }
  await updateTaskState(taskId, task.state);

  const backend = backendManager.getTaskBackend(taskId, task.config.workspaceId);

  const engine = new TaskEngine({
    task,
    backend,
    gitService: git,
    eventEmitter: ctx.emitter,
    onPersistState: async (state) => {
      await updateTaskState(taskId, state);
    },
    onPlanReady: async () => {
      await ctx.acceptPlan(taskId);
    },
    onCompleted: async () => {
      await handleFullyAutonomousCompletionImpl(ctx, taskId);
    },
    initialPromptAttachments: options?.attachments,
  });

  try {
    await engine.setupGitBranchForPlanAcceptance();
  } catch (error) {
    throw new TaskOperationError(
      "task_git_operation_failed",
      "Failed to set up git branch for plan mode",
      { cause: error, details: { taskId } },
    );
  }

  const workingDirectory = engine.workingDirectory;

  await clearPlanningFilesImpl(ctx, taskId, task, executor, workingDirectory);

  ctx.engines.set(taskId, engine);

  startStatePersistenceImpl(ctx, taskId);

  log.info("Task plan mode started", {
    taskId,
    workspaceId: task.config.workspaceId,
  });
  engine.start().catch((error) => {
    log.error("Task plan mode failed after start", {
      taskId,
      error: String(error),
    });
  });
}

export async function startDraftImpl(
  ctx: TaskCtx,
  taskId: string,
  options: { planMode: boolean; attachments?: StartTaskOptions["attachments"] }
): Promise<Task> {
  const task = await loadTask(taskId);
  if (!task) {
    throw new TaskOperationError("task_not_found", "Task not found", {
      details: { taskId },
    });
  }

  if (task.state.status !== "draft") {
    throw new TaskOperationError(
      "invalid_task_state",
      `Task is not in draft status: ${task.state.status}`,
      { details: { taskId, status: task.state.status } },
    );
  }

  if (options.planMode) {
    assertValidTransition(task.state.status, "planning", "startDraft");
    task.state.status = "planning";
    task.state.planMode = {
      active: true,
      feedbackRounds: 0,
      planningFolderCleared: false,
      isPlanReady: false,
    };
    await updateTaskState(taskId, task.state);

    await startPlanModeImpl(ctx, taskId, { attachments: options.attachments });
  } else {
    assertValidTransition(task.state.status, "idle", "startDraft");
    task.state.status = "idle";
    await updateTaskState(taskId, task.state);

    await startTaskImpl(ctx, taskId, { attachments: options.attachments });
  }

  const updatedTask = await ctx.getTask(taskId);
  return updatedTask ?? task;
}
