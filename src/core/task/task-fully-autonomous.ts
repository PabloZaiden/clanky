import type { Task } from "@/shared/task";
import { loadTask, updateTaskState } from "../../persistence/tasks";
import { createLogger } from "../logger";
import type { TaskCtx } from "./context";
import { emitAutomaticPrFlowUpdatedEvent } from "./task-automatic-pr-flow-events";
import type { TaskOperationError } from "./task-errors";

const log = createLogger("core:task-fully-autonomous");

function buildAutomationErrorState(task: Task, error: string): NonNullable<Task["state"]["automaticPrFlow"]> {
  const now = new Date().toISOString();
  const existingState = task.state.automaticPrFlow;
  return {
    enabled: false,
    status: "error",
    startedAt: existingState?.startedAt ?? now,
    updatedAt: now,
    lastCheckedAt: now,
    pullRequestNumber: existingState?.pullRequestNumber,
    pullRequestUrl: existingState?.pullRequestUrl,
    activeBatch: undefined,
    handledItems: existingState?.handledItems ?? [],
    lastError: error,
    stoppedAt: existingState?.stoppedAt,
  };
}

async function persistAutomationFailure(ctx: TaskCtx, task: Task, error: string): Promise<void> {
  task.state.fullyAutonomousPending = false;
  task.state.automaticPrFlow = buildAutomationErrorState(task, error);
  await updateTaskState(task.config.id, task.state);
  emitAutomaticPrFlowUpdatedEvent(ctx.emitter, task.config.id, task.state.automaticPrFlow);
}

function isConcurrentCompletionNoop(error: TaskOperationError | undefined): boolean {
  return error?.code === "operation_in_progress";
}

export async function finalizeFullyAutonomousPushImpl(ctx: TaskCtx, taskId: string): Promise<void> {
  const task = await loadTask(taskId);
  if (!task || task.state.fullyAutonomousPending !== true) {
    return;
  }

  if (task.state.status !== "pushed") {
    log.debug("Skipping automatic PR flow start because task is not yet pushed", {
      taskId,
      status: task.state.status,
    });
    return;
  }

  const result = await ctx.startAutomaticPrFlow(taskId);
  if (!result.success) {
    const latestTask = await loadTask(taskId);
    if (latestTask) {
      await persistAutomationFailure(
        ctx,
        latestTask,
        result.error.message,
      );
    }
    return;
  }

  const latestTask = await loadTask(taskId);
  if (!latestTask || latestTask.state.fullyAutonomousPending !== true) {
    return;
  }

  latestTask.state.fullyAutonomousPending = false;
  await updateTaskState(taskId, latestTask.state);
}

export async function handleFullyAutonomousCompletionImpl(ctx: TaskCtx, taskId: string): Promise<void> {
  const task = await loadTask(taskId);
  if (!task || task.config.fullyAutonomous !== true || task.state.fullyAutonomousPending !== true) {
    return;
  }

  if (task.state.reviewMode?.reviewCycles && task.state.reviewMode.reviewCycles > 0) {
    return;
  }

  if (task.state.status !== "completed") {
    return;
  }

  const result = await ctx.pushTask(taskId);
  if (!result.success) {
    if (isConcurrentCompletionNoop(result.error)) {
      return;
    }
    const latestTask = await loadTask(taskId);
    if (latestTask) {
      await persistAutomationFailure(
        ctx,
        latestTask,
        result.error.message,
      );
    }
    return;
  }

  if (result.syncStatus === "conflicts_being_resolved") {
    return;
  }

  await finalizeFullyAutonomousPushImpl(ctx, taskId);
}
