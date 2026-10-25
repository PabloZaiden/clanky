import type { TaskCtx } from "./context";
import { TaskEngine } from "../task-engine";
import { loadTask, updateTaskState } from "../../persistence/tasks";
import { backendManager } from "../backend-manager";
import { log } from "@pablozaiden/webapp/server";
import { GitService } from "../git";
import { getTaskWorkingDirectory } from "./task-types";
import { ensureTaskBranchCheckedOutImpl } from "./task-git-validation";
import { startStatePersistenceImpl } from "./task-state-persistence";
import { handleFullyAutonomousCompletionImpl } from "./task-fully-autonomous";
import { TaskOperationError } from "./task-errors";
import { harnessActivityService } from "../harness-activity-service";
import { runTaskLifecycleOperation } from "./task-lifecycle-operations";

type NativeEngineRecoveryPurpose = "finalization" | "input-recovery";
type OwnedNativeRecoveryPurpose = NativeEngineRecoveryPurpose | "workspace-safety";

async function createOwnedNativeTaskEngine(
  ctx: TaskCtx,
  taskId: string,
  purpose: OwnedNativeRecoveryPurpose,
): Promise<{ engine: TaskEngine; createdBackend: boolean }> {
  const task = await loadTask(taskId);
  if (!task) throw new TaskOperationError("task_not_found", "The task is unavailable.");
  if (task.state.status === "deleted") {
    throw new TaskOperationError("invalid_task_state", "Cannot recover a deleted task session.", {
      details: { taskId, status: task.state.status },
    });
  }
  const binding = task.state.session?.binding;
  if (
    !binding
    || binding.adapter === "acp"
    || (purpose === "finalization" && task.state.status !== "completed")
  ) {
    throw new TaskOperationError("invalid_task_state", "Recovery requires the owned native conversation.");
  }
  const directory = getTaskWorkingDirectory(task);
  if (!directory) throw new TaskOperationError("task_worktree_missing", "The task worktree is unavailable.");
  const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, task.config.directory);
  const git = GitService.withExecutor(executor);
  if (task.config.useWorktree) await git.assertCanonicalManagedWorktreePath(task.config.directory, taskId, directory);
  const previousBackend = backendManager.getInitializedContextBackend(taskId);
  const backend = backendManager.getTaskBackend(taskId, task.config.workspaceId);
  try {
    return {
      engine: new TaskEngine({
        task,
        backend,
        gitService: git, eventEmitter: ctx.emitter, skipGitSetup: true,
        onPersistState: async (state, options) => { await updateTaskState(taskId, state, options); },
      }),
      createdBackend: previousBackend !== backend,
    };
  } catch (error) {
    if (previousBackend !== backend) {
      try {
        await disconnectRecoveryBackend(taskId);
      } catch (cleanupError) {
        log.error("Failed to release native task backend after engine construction failed", {
          taskId,
          error: String(cleanupError),
        });
      }
    }
    throw error;
  }
}

async function disconnectRecoveryBackend(taskId: string): Promise<void> {
  if (!await backendManager.disconnectTask(taskId)) {
    throw new TaskOperationError(
      "task_background_work_unsettled",
      "The temporary native task backend could not be released.",
      { details: { taskId } },
    );
  }
}

export function recoverOwnedNativeEngineImpl(
  ctx: TaskCtx,
  taskId: string,
  purpose: NativeEngineRecoveryPurpose,
): Promise<TaskEngine> {
  return runTaskLifecycleOperation(taskId, () => recoverOwnedNativeEngineLocked(ctx, taskId, purpose));
}

export async function recoverOwnedNativeEngineLocked(
  ctx: TaskCtx,
  taskId: string,
  purpose: NativeEngineRecoveryPurpose,
): Promise<TaskEngine> {
  const existing = ctx.engines.get(taskId);
  if (existing) return existing;
  const { engine } = await createOwnedNativeTaskEngine(ctx, taskId, purpose);
  try {
    // Recovery attaches the exact owned session; it never starts another task turn.
    await engine.reconnectSession();
    ctx.engines.set(taskId, engine);
    startStatePersistenceImpl(ctx, taskId);
    return engine;
  } catch (error) {
    await harnessActivityService.close({ kind: "task", id: taskId });
    await backendManager.disconnectTask(taskId);
    throw new TaskOperationError(
      "task_session_reconnect_failed",
      "Cannot recover the owned native task session.",
      { cause: error },
    );
  }
}

export function withOwnedNativeEngineForWorkspaceSafetyImpl<T>(
  ctx: TaskCtx,
  taskId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return runTaskLifecycleOperation(
    taskId,
    () => withOwnedNativeEngineForWorkspaceSafetyLocked(ctx, taskId, operation),
  );
}

export async function withOwnedNativeEngineForWorkspaceSafetyLocked<T>(
  ctx: TaskCtx,
  taskId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const existing = ctx.engines.get(taskId);
  if (existing) {
    const backend = backendManager.getInitializedContextBackend(taskId);
    if (backend?.isConnected()) return await operation();
    try {
      await existing.reconnectSession();
    } catch (error) {
      ctx.engines.delete(taskId);
      await harnessActivityService.close({ kind: "task", id: taskId });
      await backendManager.disconnectTask(taskId);
      throw new TaskOperationError(
        "task_session_reconnect_failed",
        "Cannot recover native workspace safety.",
        { cause: error },
      );
    }
    return await operation();
  }

  const { engine, createdBackend } = await createOwnedNativeTaskEngine(ctx, taskId, "workspace-safety");
  try {
    await engine.reconnectSession({ observeHarnessActivity: false });
  } catch (error) {
    if (createdBackend) {
      try {
        await disconnectRecoveryBackend(taskId);
      } catch (cleanupError) {
        log.error("Failed to release temporary native task backend after safety recovery failed", {
          taskId,
          error: String(cleanupError),
        });
      }
    }
    throw new TaskOperationError(
      "task_session_reconnect_failed",
      "Cannot recover the owned native task session for workspace safety.",
      { cause: error },
    );
  }

  let operationFailed = false;
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    if (createdBackend) {
      try {
        await disconnectRecoveryBackend(taskId);
      } catch (cleanupError) {
        if (operationFailed) {
          log.error("Failed to release temporary native task backend after workspace safety check failed", {
            taskId,
            cleanupError: String(cleanupError),
            operationError: String(operationError),
          });
        } else {
          throw cleanupError;
        }
      }
    }
  }
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
