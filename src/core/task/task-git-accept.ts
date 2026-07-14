import type { TaskCtx } from "./context";
import type { AcceptTaskResult } from "./task-types";
import { createTimestamp } from "@/shared/events";
import { updateTaskState } from "../../persistence/tasks";
import { backendManager } from "../backend-manager";
import { log } from "../logger";
import { assertValidTransition } from "../task-state-machine";

export async function acceptTaskImpl(ctx: TaskCtx, taskId: string): Promise<AcceptTaskResult> {
  if (ctx.tasksBeingAccepted.has(taskId)) {
    log.warn(`[TaskManager] acceptTask: Already accepting task ${taskId}, ignoring duplicate call`);
    return { success: false, error: "Accept operation already in progress" };
  }

  const task = await ctx.getTask(taskId);
  if (!task) {
    return { success: false, error: "Task not found" };
  }

  if (task.state.status !== "completed" && task.state.status !== "max_iterations") {
    return { success: false, error: `Cannot accept task in status: ${task.state.status}` };
  }

  if (!task.state.git) {
    return { success: false, error: "No git branch was created for this task" };
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
    return { success: false, error: String(error) };
  } finally {
    ctx.tasksBeingAccepted.delete(taskId);
    log.debug(`[TaskManager] acceptTask: Finished accept for task ${taskId}`);
  }
}
