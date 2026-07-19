import type { TaskCtx } from "./context";
import type { PushTaskResult } from "./task-types";
import { backendManager } from "../backend-manager";
import { GitService } from "../git";
import { log } from "@pablozaiden/webapp/server";
import { syncWorkingBranch, syncBaseBranchAndPush } from "./task-git-push-helpers";
import { taskFailure, taskFailureFromUnknown } from "./task-errors";

export async function pushTaskImpl(ctx: TaskCtx, taskId: string): Promise<PushTaskResult> {
  if (ctx.tasksBeingAccepted.has(taskId)) {
    log.warn(`[TaskManager] pushTask: Already processing task ${taskId}, ignoring duplicate call`);
    return taskFailure(
      "operation_in_progress",
      "Operation already in progress",
      { details: { taskId } },
    );
  }

  const task = await ctx.getTask(taskId);
  if (!task) {
    return taskFailure("task_not_found", "Task not found", { details: { taskId } });
  }

  if (
    task.state.status !== "completed" &&
    task.state.status !== "max_iterations" &&
    task.state.status !== "accepted_local"
  ) {
    return taskFailure(
      "invalid_task_state",
      `Cannot push task in status: ${task.state.status}`,
      { details: { taskId, status: task.state.status } },
    );
  }

  if (!task.state.git) {
    return taskFailure(
      "task_branch_missing",
      "No git branch was created for this task",
      { details: { taskId } },
    );
  }

  ctx.tasksBeingAccepted.add(taskId);
  log.info(`[TaskManager] pushTask: Starting push for task ${taskId}`);

  try {
    const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, task.config.directory);
    const git = GitService.withExecutor(executor);

    const baseBranch = task.config.baseBranch ?? task.state.git.originalBranch;
    const worktreePath = task.state.git.worktreePath ?? task.config.directory;
    const workingBranch = task.state.git.workingBranch;

    await git.ensureMergeStrategy(worktreePath);

    if (!(await git.hasRemote(task.config.directory))) {
      return {
        success: false,
        error: taskFailure(
          "task_no_remote",
          "Workspace has no git remote configured. Add an origin remote before pushing this task.",
          { details: { taskId } },
        ).error,
      };
    }

    const workingBranchConflictResult = await syncWorkingBranch(
      ctx, taskId, task, git, baseBranch, worktreePath, workingBranch, "pushTask"
    );
    if (workingBranchConflictResult) {
      return workingBranchConflictResult;
    }

    return await syncBaseBranchAndPush(ctx, taskId, task, git);
  } catch (error) {
    log.error("[TaskManager] pushTask: Failed to push task", {
      taskId,
      error: String(error),
    });
    return taskFailureFromUnknown(
      error,
      "task_git_operation_failed",
      "Failed to push task",
    );
  } finally {
    ctx.tasksBeingAccepted.delete(taskId);
    log.debug(`[TaskManager] pushTask: Finished push for task ${taskId}`);
  }
}

export async function updateBranchImpl(ctx: TaskCtx, taskId: string): Promise<PushTaskResult> {
  if (ctx.tasksBeingAccepted.has(taskId)) {
    log.warn(`[TaskManager] updateBranch: Already processing task ${taskId}, ignoring duplicate call`);
    return taskFailure(
      "operation_in_progress",
      "Operation already in progress",
      { details: { taskId } },
    );
  }
  ctx.tasksBeingAccepted.add(taskId);
  log.info(`[TaskManager] updateBranch: Starting branch update for task ${taskId}`);

  try {
    const task = await ctx.getTask(taskId);
    if (!task) {
      return taskFailure("task_not_found", "Task not found", { details: { taskId } });
    }

    if (task.state.status !== "pushed") {
      return taskFailure(
        "invalid_task_state",
        `Cannot update branch for task in status: ${task.state.status}`,
        { details: { taskId, status: task.state.status } },
      );
    }

    if (!task.state.git) {
      return taskFailure(
        "task_branch_missing",
        "No git branch was created for this task",
        { details: { taskId } },
      );
    }

    if (ctx.engines.has(taskId)) {
      return taskFailure(
        "task_already_running",
        "Task already has an active engine running",
        { details: { taskId } },
      );
    }

    const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, task.config.directory);
    const git = GitService.withExecutor(executor);

    const baseBranch = task.config.baseBranch ?? task.state.git.originalBranch;
    const worktreePath = task.state.git.worktreePath ?? task.config.directory;
    const workingBranch = task.state.git.workingBranch;

    await git.ensureMergeStrategy(worktreePath);

    if (!(await git.hasRemote(task.config.directory))) {
      return {
        success: false,
        error: taskFailure(
          "task_no_remote",
          "Workspace has no git remote configured. Add an origin remote before updating this task branch.",
          { details: { taskId } },
        ).error,
      };
    }

    const workingBranchConflictResult = await syncWorkingBranch(
      ctx, taskId, task, git, baseBranch, worktreePath, workingBranch, "updateBranch"
    );
    if (workingBranchConflictResult) {
      return workingBranchConflictResult;
    }

    return await syncBaseBranchAndPush(ctx, taskId, task, git);
  } catch (error) {
    log.error("[TaskManager] updateBranch: Failed to update branch for task", {
      taskId,
      error: String(error),
    });
    return taskFailureFromUnknown(
      error,
      "task_git_operation_failed",
      "Failed to update task branch",
    );
  } finally {
    ctx.tasksBeingAccepted.delete(taskId);
    log.debug(`[TaskManager] updateBranch: Finished branch update for task ${taskId}`);
  }
}
