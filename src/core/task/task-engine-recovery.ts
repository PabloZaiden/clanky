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
    onPersistState: async (state) => {
      await updateTaskState(taskId, state);
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
