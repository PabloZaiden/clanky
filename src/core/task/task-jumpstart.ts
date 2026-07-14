import type { TaskCtx } from "./context";
import type { Task, ModelConfig } from "@/shared/task";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import { TaskEngine } from "../task-engine";
import { createTimestamp } from "@/shared/events";
import { loadTask, updateTaskState, saveTask } from "../../persistence/tasks";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { log } from "../logger";
import { assertValidTransition } from "../task-state-machine";
import { getTaskWorkingDirectory } from "./task-types";
import { startStatePersistenceImpl } from "./task-execution";
import { taskFailure, taskFailureFromUnknown, type TaskResult } from "./task-errors";

export async function jumpstartTaskImpl(
  ctx: TaskCtx,
  taskId: string,
  options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] }
): Promise<TaskResult> {
  return jumpstartTaskFromEngine(ctx, taskId, options);
}

/** Internal helper used by pending-engine and follow-up modules. */
export async function jumpstartTaskFromEngine(
  ctx: TaskCtx,
  taskId: string,
  options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] }
): Promise<TaskResult> {
  const task = await loadTask(taskId);
  if (!task) {
    return taskFailure("task_not_found", "Task not found", { details: { taskId } });
  }

  const jumpstartableStates = ["completed", "stopped", "failed", "max_iterations", "planning", "deleted"];
  if (!jumpstartableStates.includes(task.state.status)) {
    return taskFailure(
      "invalid_task_state",
      `Task cannot be jumpstarted from status: ${task.state.status}`,
      { details: { taskId, status: task.state.status } },
    );
  }

  if (options.message !== undefined) {
    task.state.pendingPrompt = options.message;
  }
  if (options.model !== undefined) {
    task.state.pendingModel = options.model;
    task.config.model = options.model;
  }

  const wasInPlanningMode = task.state.planMode?.active === true;

  if (wasInPlanningMode) {
    assertValidTransition(task.state.status, "planning", "jumpstartTask");
    task.state.status = "planning";
    if (task.state.planMode) {
      task.state.planMode.isPlanReady = false;
    }
  } else {
    assertValidTransition(task.state.status, "stopped", "jumpstartTask");
    task.state.status = "stopped";
  }
  task.state.completedAt = undefined;
  task.state.error = undefined;
  task.state.syncState = undefined;

  await updateTaskState(taskId, task.state);
  await saveTask(task);

  ctx.emitter.emit({
    type: "task.pending.updated",
    taskId,
    pendingPrompt: options.message,
    pendingModel: options.model,
    timestamp: createTimestamp(),
  });

  const canReuse = await canReuseExistingBranch(task);

  if (wasInPlanningMode) {
    if (canReuse) {
      return jumpstartOnExistingBranch(ctx, taskId, task, true, options.attachments);
    } else {
      try {
        await ctx.startPlanMode(taskId, { attachments: options.attachments });
        log.info(`Jumpstarted planning task ${taskId} with pending message`);
        return { success: true };
      } catch (startError) {
        log.error(`Failed to jumpstart planning task ${taskId}: ${String(startError)}`);
        return taskFailureFromUnknown(
          startError,
          "task_operation_failed",
          "Failed to jumpstart planning task",
        );
      }
    }
  }

  if (canReuse) {
    return jumpstartOnExistingBranch(ctx, taskId, task, false, options.attachments);
  } else {
    try {
      await ctx.startTask(taskId, { attachments: options.attachments });
      log.info(`Jumpstarted task ${taskId} with pending message (new branch)`);
      return { success: true };
    } catch (startError) {
      log.error(`Failed to jumpstart task ${taskId}: ${String(startError)}`);
      return taskFailureFromUnknown(
        startError,
        "task_operation_failed",
        "Failed to jumpstart task",
      );
    }
  }
}

export async function canReuseExistingBranch(task: Task): Promise<boolean> {
  if (!task.state.git?.workingBranch) {
    return false;
  }

  if (!task.config.useWorktree) {
    return true;
  }

  const worktreePath = task.state.git.worktreePath;
  if (!worktreePath) {
    return false;
  }

  const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, task.config.directory);
  const git = GitService.withExecutor(executor);
  const managedWorktreePath = git.assertManagedWorktreePath(task.config.directory, worktreePath);
  return git.worktreeExists(task.config.directory, managedWorktreePath);
}

export async function reviveDeletedTask(taskId: string): Promise<TaskResult> {
  const task = await loadTask(taskId);
  if (!task) {
    return taskFailure("task_not_found", "Task not found", { details: { taskId } });
  }
  if (task.state.status !== "deleted") {
    return taskFailure(
      "invalid_task_state",
      `Task is not deleted (status: ${task.state.status})`,
      { details: { taskId, status: task.state.status } },
    );
  }

  const targetStatus = task.state.planMode?.active ? "planning" as const : "stopped" as const;
  assertValidTransition(task.state.status, targetStatus, "reviveDeletedTask");
  task.state.status = targetStatus;
  task.state.completedAt = undefined;
  task.state.error = undefined;
  task.state.syncState = undefined;
  if (task.state.planMode) {
    task.state.planMode.isPlanReady = false;
  }

  await saveTask(task);
  return { success: true };
}

async function jumpstartOnExistingBranch(
  ctx: TaskCtx,
  taskId: string,
  task: Task,
  isPlanning = false,
  attachments: MessageImageAttachment[] = [],
): Promise<TaskResult> {
  try {
    const workingDirectory = getTaskWorkingDirectory(task);
    if (!workingDirectory) {
      return taskFailure(
        "task_worktree_missing",
        "Task is configured to use a worktree, but no worktree path is available - cannot jumpstart",
        { details: { taskId } },
      );
    }
    const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, workingDirectory);
    const git = GitService.withExecutor(executor);
    const backend = backendManager.getTaskBackend(taskId, task.config.workspaceId);

    const workingBranch = task.state.git!.workingBranch;
    const taskType = isPlanning ? "planning task" : "task";
    log.info(`Jumpstarting ${taskType} ${taskId} on existing branch: ${workingBranch}`);

    await ctx.ensureTaskBranchCheckedOut(task, git, workingDirectory);

    const engine = new TaskEngine({
      task: { config: task.config, state: task.state },
      backend,
      gitService: git,
      eventEmitter: ctx.emitter,
      onPersistState: async (state) => {
        await updateTaskState(taskId, state);
      },
      skipGitSetup: true,
      initialPromptAttachments: attachments,
    });
    ctx.engines.set(taskId, engine);

    startStatePersistenceImpl(ctx, taskId);

    engine.start().catch((error) => {
      log.error(`${isPlanning ? "Planning task" : "Task"} ${taskId} failed to start after jumpstart:`, String(error));
    });

    log.info(`Jumpstarted ${taskType} ${taskId} with pending message on existing branch: ${workingBranch}`);
    return { success: true };
  } catch (error) {
    log.error(`Failed to jumpstart ${isPlanning ? "planning task" : "task"} ${taskId} on existing branch: ${String(error)}`);
    return taskFailureFromUnknown(
      error,
      "task_operation_failed",
      "Failed to jumpstart task",
    );
  }
}
