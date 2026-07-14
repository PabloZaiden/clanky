import type { TaskCtx } from "./context";
import type { ModelConfig } from "@/shared/task";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import { createLogger } from "../logger";
import { isStaleTaskStatus, loadTask, resetStaleTask } from "../../persistence/tasks";
import { jumpstartTaskFromEngine } from "./task-jumpstart";
import { taskFailure, type TaskResult } from "./task-errors";

const log = createLogger("task:pending");

export async function setPendingPromptImpl(
  ctx: TaskCtx,
  taskId: string,
  prompt: string,
  attachments: MessageImageAttachment[] = [],
): Promise<TaskResult> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return taskFailure("task_not_found", "Task not found", { details: { taskId } });
    }
    return taskFailure(
      "task_not_running",
      "Task is not running. Pending prompts can only be set for running tasks.",
      { details: { taskId } },
    );
  }

  const status = engine.state.status;
  if (status !== "running" && status !== "starting") {
    return taskFailure(
      "task_not_running",
      `Task is not running (status: ${status}). Pending prompts can only be set for running tasks.`,
      { details: { taskId, status } },
    );
  }

  engine.setPendingPrompt(prompt, attachments);

  return { success: true };
}

export async function clearPendingPromptImpl(
  ctx: TaskCtx,
  taskId: string,
): Promise<TaskResult> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return taskFailure("task_not_found", "Task not found", { details: { taskId } });
    }
    return taskFailure(
      "task_not_running",
      "Task is not running. Pending prompts can only be cleared for running tasks.",
      { details: { taskId } },
    );
  }

  const status = engine.state.status;
  if (status !== "running" && status !== "starting") {
    return taskFailure(
      "task_not_running",
      `Task is not running (status: ${status}). Pending prompts can only be cleared for running tasks.`,
      { details: { taskId, status } },
    );
  }

  engine.clearPendingPrompt();

  return { success: true };
}

export async function setPendingModelImpl(
  ctx: TaskCtx,
  taskId: string,
  model: ModelConfig,
): Promise<TaskResult> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return taskFailure("task_not_found", "Task not found", { details: { taskId } });
    }
    return taskFailure(
      "task_not_running",
      "Task is not running. Pending model can only be set for running tasks.",
      { details: { taskId } },
    );
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    return taskFailure(
      "invalid_task_state",
      `Task is not in an active state (status: ${status}). Pending model can only be set for active tasks.`,
      { details: { taskId, status } },
    );
  }

  if (!model.providerID || !model.modelID) {
    return taskFailure(
      "invalid_model_config",
      "Invalid model config: providerID and modelID are required",
      { details: { taskId } },
    );
  }

  engine.setPendingModel(model);

  return { success: true };
}

export async function clearPendingModelImpl(
  ctx: TaskCtx,
  taskId: string,
): Promise<TaskResult> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return taskFailure("task_not_found", "Task not found", { details: { taskId } });
    }
    return taskFailure(
      "task_not_running",
      "Task is not running. Pending model can only be cleared for running tasks.",
      { details: { taskId } },
    );
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    return taskFailure(
      "invalid_task_state",
      `Task is not in an active state (status: ${status}). Pending model can only be cleared for active tasks.`,
      { details: { taskId, status } },
    );
  }

  engine.clearPendingModel();

  return { success: true };
}

export async function clearPendingImpl(
  ctx: TaskCtx,
  taskId: string,
): Promise<TaskResult> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return taskFailure("task_not_found", "Task not found", { details: { taskId } });
    }
    return taskFailure(
      "task_not_running",
      "Task is not running. Pending values can only be cleared for running tasks.",
      { details: { taskId } },
    );
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    return taskFailure(
      "invalid_task_state",
      `Task is not in an active state (status: ${status}). Pending values can only be cleared for active tasks.`,
      { details: { taskId, status } },
    );
  }

  engine.clearPending();

  return { success: true };
}

export async function setPendingImpl(
  ctx: TaskCtx,
  taskId: string,
  options: {
    message?: string;
    model?: ModelConfig;
    attachments?: MessageImageAttachment[];
  },
): Promise<TaskResult> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return taskFailure("task_not_found", "Task not found", { details: { taskId } });
    }
    return taskFailure(
      "task_not_running",
      "Task is not running. Pending values can only be set for running tasks.",
      { details: { taskId } },
    );
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    return taskFailure(
      "invalid_task_state",
      `Task is not in an active state (status: ${status}). Pending values can only be set for active tasks.`,
      { details: { taskId, status } },
    );
  }

  if (options.model && (!options.model.providerID || !options.model.modelID)) {
    return taskFailure(
      "invalid_model_config",
      "Invalid model config: providerID and modelID are required",
      { details: { taskId } },
    );
  }

  if (options.message !== undefined) {
    engine.setPendingPrompt(options.message, options.attachments);
  }
  if (options.model !== undefined) {
    engine.setPendingModel(options.model);
  }

  return { success: true };
}

export async function injectPendingImpl(
  ctx: TaskCtx,
  taskId: string,
  options: {
    message?: string;
    model?: ModelConfig;
    attachments?: MessageImageAttachment[];
  },
): Promise<TaskResult> {
  const engine = ctx.engines.get(taskId);

  if (options.model && (!options.model.providerID || !options.model.modelID)) {
    return taskFailure(
      "invalid_model_config",
      "Invalid model config: providerID and modelID are required",
      { details: { taskId } },
    );
  }

  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return taskFailure("task_not_found", "Task not found", { details: { taskId } });
    }

    if (isStaleTaskStatus(task.state.status)) {
      const reconciled = await resetStaleTask(taskId);
      if (reconciled) {
        log.warn(
          `Reconciled stale active task ${taskId} from persisted status ${task.state.status} before pending injection`,
        );
        return jumpstartTaskFromEngine(ctx, taskId, options);
      }
    }

    const jumpstartableStates = ["completed", "stopped", "failed", "max_iterations", "planning"];
    if (jumpstartableStates.includes(task.state.status)) {
      return jumpstartTaskFromEngine(ctx, taskId, options);
    }

    return taskFailure(
      "task_not_running",
      "Task is not running. Pending values can only be injected for running tasks.",
      { details: { taskId, status: task.state.status } },
    );
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    const jumpstartableStates = ["completed", "stopped", "failed", "max_iterations"];
    if (jumpstartableStates.includes(status)) {
      return jumpstartTaskFromEngine(ctx, taskId, options);
    }
    return taskFailure(
      "invalid_task_state",
      `Task is not in an active state (status: ${status}). Pending values can only be injected for active tasks.`,
      { details: { taskId, status } },
    );
  }

  await engine.injectPendingNow(options);

  return { success: true };
}
