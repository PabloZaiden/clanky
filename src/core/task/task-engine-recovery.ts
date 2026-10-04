import type { TaskCtx } from "./context";
import { TaskEngine } from "../task-engine";
import { loadTask, updateTaskState } from "../../persistence/tasks";
import { backendManager } from "../backend-manager";
import { GitService } from "../git";
import { getTaskWorkingDirectory } from "./task-types";
import { ensureTaskBranchCheckedOutImpl } from "./task-git-validation";
import { startStatePersistenceImpl } from "./task-state-persistence";
import { handleFullyAutonomousCompletionImpl } from "./task-fully-autonomous";
import { TaskOperationError } from "./task-errors";
import { harnessActivityService } from "../harness-activity-service";
import { KeyedOperationQueue } from "../../utils/keyed-operation-queue";

const completionRecovery = new KeyedOperationQueue();

export function recoverOwnedNativeEngineImpl(
  ctx: TaskCtx,
  taskId: string,
  purpose: "finalization" | "input-recovery",
): Promise<TaskEngine> {
  return completionRecovery.run(taskId, async () => {
    const existing = ctx.engines.get(taskId);
    if (existing) return existing;
    const task = await loadTask(taskId);
    if (!task) throw new TaskOperationError("task_not_found", "The task is unavailable.");
    const binding = task.state.session?.binding;
    if (!binding || binding.adapter === "acp" || (purpose === "finalization" && task.state.status !== "completed")) {
      throw new TaskOperationError("invalid_task_state", "Recovery requires the owned native conversation.");
    }
    const directory = getTaskWorkingDirectory(task);
    if (!directory) throw new TaskOperationError("task_worktree_missing", "The task worktree is unavailable.");
    const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, task.config.directory);
    const git = GitService.withExecutor(executor);
    if (task.config.useWorktree) await git.assertCanonicalManagedWorktreePath(task.config.directory, taskId, directory);
    const engine = new TaskEngine({
      task,
      backend: backendManager.getTaskBackend(taskId, task.config.workspaceId),
      gitService: git, eventEmitter: ctx.emitter, skipGitSetup: true,
      onPersistState: async (state, options) => { await updateTaskState(taskId, state, options); },
    });
    try {
      // Recovery attaches the exact owned session; it never starts another task turn.
      await engine.reconnectSession();
      ctx.engines.set(taskId, engine);
      startStatePersistenceImpl(ctx, taskId);
      return engine;
    } catch (error) {
      await harnessActivityService.close({ kind: "task", id: taskId });
      await backendManager.disconnectTask(taskId);
      throw new TaskOperationError("task_session_reconnect_failed", "Cannot recover native finalization.", { cause: error });
    }
  });
}

export async function recoverPlanningEngineImpl(ctx: TaskCtx, taskId: string): Promise<TaskEngine> {
  const task = await loadTask(taskId);
  if (!task) {
    throw new TaskOperationError("task_not_found", "Task not found", {
      details: { taskId },
    });
  }

  if (task.state.status !== "planning") {
    throw new TaskOperationError(
      "task_not_planning",
      "Task plan mode is not running",
      { details: { taskId, status: task.state.status } },
    );
  }

  const workingDirectory = getTaskWorkingDirectory(task);
  if (!workingDirectory) {
    throw new TaskOperationError(
      "task_worktree_missing",
      "Task is configured to use a worktree, but no worktree path is available - cannot recreate engine for planning recovery",
      { details: { taskId } },
    );
  }
  const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, workingDirectory);
  const git = GitService.withExecutor(executor);
  await ensureTaskBranchCheckedOutImpl(ctx, task, git, workingDirectory);
  const backend = backendManager.getTaskBackend(taskId, task.config.workspaceId);

  const engine = new TaskEngine({
    task,
    backend,
    gitService: git,
    eventEmitter: ctx.emitter,
    onPersistState: async (state, options) => {
      await updateTaskState(taskId, state, options);
    },
    onPlanReady: async () => {
      await ctx.acceptPlan(taskId);
    },
    onCompleted: async () => {
      await handleFullyAutonomousCompletionImpl(ctx, taskId);
    },
  });

  ctx.engines.set(taskId, engine);

  if (task.state.session?.id) {
    try {
      await engine.reconnectSession();
    } catch (error) {
      ctx.engines.delete(taskId);
      throw new TaskOperationError(
        "task_session_reconnect_failed",
        "Failed to recover planning engine session",
        { cause: error, details: { taskId } },
      );
    }
  }

  startStatePersistenceImpl(ctx, taskId);

  return engine;
}
