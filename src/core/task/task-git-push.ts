import type { TaskCtx } from "./context";
import type { PushTaskResult } from "./task-types";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { log } from "../logger";
import { syncWorkingBranch, syncBaseBranchAndPush } from "./task-git-push-helpers";

export async function pushTaskImpl(ctx: TaskCtx, taskId: string): Promise<PushTaskResult> {
  if (ctx.tasksBeingAccepted.has(taskId)) {
    log.warn(`[TaskManager] pushTask: Already processing task ${taskId}, ignoring duplicate call`);
    return { success: false, error: "Operation already in progress" };
  }

  const task = await ctx.getTask(taskId);
  if (!task) {
    return { success: false, error: "Task not found" };
  }

  if (
    task.state.status !== "completed" &&
    task.state.status !== "max_iterations" &&
    task.state.status !== "accepted_local"
  ) {
    return { success: false, error: `Cannot push task in status: ${task.state.status}` };
  }

  if (!task.state.git) {
    return { success: false, error: "No git branch was created for this task" };
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
        error: "Workspace has no git remote configured. Add an origin remote before pushing this task.",
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
    return { success: false, error: String(error) };
  } finally {
    ctx.tasksBeingAccepted.delete(taskId);
    log.debug(`[TaskManager] pushTask: Finished push for task ${taskId}`);
  }
}

export async function updateBranchImpl(ctx: TaskCtx, taskId: string): Promise<PushTaskResult> {
  if (ctx.tasksBeingAccepted.has(taskId)) {
    log.warn(`[TaskManager] updateBranch: Already processing task ${taskId}, ignoring duplicate call`);
    return { success: false, error: "Operation already in progress" };
  }
  ctx.tasksBeingAccepted.add(taskId);
  log.info(`[TaskManager] updateBranch: Starting branch update for task ${taskId}`);

  try {
    const task = await ctx.getTask(taskId);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    if (task.state.status !== "pushed") {
      return { success: false, error: `Cannot update branch for task in status: ${task.state.status}` };
    }

    if (!task.state.git) {
      return { success: false, error: "No git branch was created for this task" };
    }

    if (ctx.engines.has(taskId)) {
      return { success: false, error: "Task already has an active engine running" };
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
        error: "Workspace has no git remote configured. Add an origin remote before updating this task branch.",
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
    return { success: false, error: String(error) };
  } finally {
    ctx.tasksBeingAccepted.delete(taskId);
    log.debug(`[TaskManager] updateBranch: Finished branch update for task ${taskId}`);
  }
}
