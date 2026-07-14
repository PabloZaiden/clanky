import type { TaskCtx } from "./context";
import type { AcceptTaskResult } from "./task-types";
import { createTimestamp } from "@/shared/events";
import { updateTaskState } from "../../persistence/tasks";
import { backendManager } from "../backend-manager";
import { log } from "../logger";
import { assertValidTransition } from "../task-state-machine";
import { taskFailure, taskFailureFromUnknown } from "./task-errors";

export async function acceptTaskImpl(ctx: TaskCtx, taskId: string): Promise<AcceptTaskResult> {
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
    const reviewMode = task.state.reviewMode
      ? {
          ...task.state.reviewMode,
          addressable: true,
          completionAction: "local" as const,
        }
      : {
          addressable: true,
          completionAction: "local" as const,
          reviewCycles: 0,
        };

    assertValidTransition(task.state.status, "accepted_local", "acceptTask");
    const updatedState = {
      ...task.state,
      status: "accepted_local" as const,
      reviewMode,
    };
    await updateTaskState(taskId, updatedState);

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
