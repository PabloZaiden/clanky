import type { TaskCtx } from "./context";
import { TaskEngine } from "../task-engine";
import { loadTask, updateTaskState } from "../../persistence/tasks";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { getTaskWorkingDirectory } from "./task-types";
import { ensureTaskBranchCheckedOutImpl } from "./task-git-validation";
import { startStatePersistenceImpl } from "./task-state-persistence";
import { handleFullyAutonomousCompletionImpl } from "./task-fully-autonomous";

export async function recoverPlanningEngineImpl(ctx: TaskCtx, taskId: string): Promise<TaskEngine> {
  const task = await loadTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (task.state.status !== "planning") {
    throw new Error("Task plan mode is not running");
  }

  const workingDirectory = getTaskWorkingDirectory(task);
  if (!workingDirectory) {
    throw new Error("Task is configured to use a worktree, but no worktree path is available - cannot recreate engine for planning recovery");
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
      throw new Error(
        `Failed to recover planning engine session for task ${taskId}: ${String(error)}`,
        { cause: error },
      );
    }
  }

  startStatePersistenceImpl(ctx, taskId);

  return engine;
}
