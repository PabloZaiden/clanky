import type { TaskCtx } from "./context";
import type { AcceptTaskResult } from "./task-types";
import { createTimestamp } from "@/shared/events";
import { updateTaskOperationalState } from "../../persistence/tasks";
import { backendManager } from "../backend-manager";
import { log } from "@pablozaiden/webapp/server";
import { assertValidTransition } from "../task-state-machine";
import { taskFailure, taskFailureFromUnknown } from "./task-errors";
import { assertTaskHarnessWorkspaceSafe } from "./task-harness";
import { runTaskLifecycleOperation } from "./task-lifecycle-operations";

export async function acceptTaskImpl(ctx: TaskCtx, taskId: string): Promise<AcceptTaskResult> {
  await ctx.engines.get(taskId)?.waitForCompletionSettlement();
  return await runTaskLifecycleOperation(taskId, () => acceptTaskLocked(ctx, taskId));
}

async function acceptTaskLocked(ctx: TaskCtx, taskId: string): Promise<AcceptTaskResult> {
  if (ctx.tasksBeingAccepted.has(taskId)) {
    log.warn(`[TaskManager] acceptTask: Already accepting task ${taskId}, ignoring duplicate call`);
    return taskFailure(
      "operation_in_progress",
      "Accept operation already in progress",
      { details: { taskId } },
    );
  }

  const task = await ctx.getTask(taskId);
  if (!task) {
    return taskFailure("task_not_found", "Task not found", { details: { taskId } });
  }

  if (task.state.status !== "completed" && task.state.status !== "max_iterations") {
    return taskFailure(
      "invalid_task_state",
      `Cannot accept task in status: ${task.state.status}`,
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
  log.debug(`[TaskManager] acceptTask: Starting accept for task ${taskId}`);

  try {
    await assertTaskHarnessWorkspaceSafe(ctx, taskId, { lifecycleOperationLocked: true });
    const settledTask = await ctx.getTask(taskId);
    if (!settledTask) {
      return taskFailure("task_not_found", "Task not found", { details: { taskId } });
    }
    if (settledTask.state.status !== "completed" && settledTask.state.status !== "max_iterations") {
      return taskFailure(
        "invalid_task_state",
        `Cannot accept task in status: ${settledTask.state.status}`,
        { details: { taskId, status: settledTask.state.status } },
      );
    }
    if (!settledTask.state.git) {
      return taskFailure(
        "task_branch_missing",
        "No git branch was created for this task",
        { details: { taskId } },
      );
    }

    const reviewMode = settledTask.state.reviewMode
      ? {
          ...settledTask.state.reviewMode,
          addressable: true,
          completionAction: "local" as const,
        }
      : {
          addressable: true,
          completionAction: "local" as const,
          reviewCycles: 0,
        };

    assertValidTransition(settledTask.state.status, "accepted_local", "acceptTask");
    const updatedState = {
      ...settledTask.state,
      status: "accepted_local" as const,
      reviewMode,
    };
    await updateTaskOperationalState(taskId, updatedState);

    await backendManager.disconnectTask(taskId);

    ctx.engines.delete(taskId);

    ctx.emitter.emit({
      type: "task.accepted",
      taskId,
      timestamp: createTimestamp(),
    });

    return { success: true };
  } catch (error) {
    return taskFailureFromUnknown(
      error,
      "task_operation_failed",
      "Failed to accept task",
    );
  } finally {
    ctx.tasksBeingAccepted.delete(taskId);
    log.debug(`[TaskManager] acceptTask: Finished accept for task ${taskId}`);
  }
}
