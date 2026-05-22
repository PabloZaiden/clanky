import type { TaskCtx } from "./context";
import type { ModelConfig } from "../../types/task";
import type { MessageImageAttachment } from "../../types/message-attachments";
import { createLogger } from "../logger";
import { isStaleTaskStatus, loadTask, resetStaleTask } from "../../persistence/tasks";
import { jumpstartTaskFromEngine } from "./task-jumpstart";

const log = createLogger("task:pending");

export async function setPendingPromptImpl(
  ctx: TaskCtx,
  taskId: string,
  prompt: string,
  attachments: MessageImageAttachment[] = [],
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return { success: false, error: "Task not found" };
    }
    return { success: false, error: "Task is not running. Pending prompts can only be set for running tasks." };
  }

  const status = engine.state.status;
  if (status !== "running" && status !== "starting") {
    return { success: false, error: `Task is not running (status: ${status}). Pending prompts can only be set for running tasks.` };
  }

  engine.setPendingPrompt(prompt, attachments);

  return { success: true };
}

export async function clearPendingPromptImpl(
  ctx: TaskCtx,
  taskId: string
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return { success: false, error: "Task not found" };
    }
    return { success: false, error: "Task is not running. Pending prompts can only be cleared for running tasks." };
  }

  const status = engine.state.status;
  if (status !== "running" && status !== "starting") {
    return { success: false, error: `Task is not running (status: ${status}). Pending prompts can only be cleared for running tasks.` };
  }

  engine.clearPendingPrompt();

  return { success: true };
}

export async function setPendingModelImpl(
  ctx: TaskCtx,
  taskId: string,
  model: ModelConfig
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return { success: false, error: "Task not found" };
    }
    return { success: false, error: "Task is not running. Pending model can only be set for running tasks." };
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    return { success: false, error: `Task is not in an active state (status: ${status}). Pending model can only be set for active tasks.` };
  }

  if (!model.providerID || !model.modelID) {
    return { success: false, error: "Invalid model config: providerID and modelID are required" };
  }

  engine.setPendingModel(model);

  return { success: true };
}

export async function clearPendingModelImpl(
  ctx: TaskCtx,
  taskId: string
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return { success: false, error: "Task not found" };
    }
    return { success: false, error: "Task is not running. Pending model can only be cleared for running tasks." };
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    return { success: false, error: `Task is not in an active state (status: ${status}). Pending model can only be cleared for active tasks.` };
  }

  engine.clearPendingModel();

  return { success: true };
}

export async function clearPendingImpl(
  ctx: TaskCtx,
  taskId: string
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return { success: false, error: "Task not found" };
    }
    return { success: false, error: "Task is not running. Pending values can only be cleared for running tasks." };
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    return { success: false, error: `Task is not in an active state (status: ${status}). Pending values can only be cleared for active tasks.` };
  }

  engine.clearPending();

  return { success: true };
}

export async function setPendingImpl(
  ctx: TaskCtx,
  taskId: string,
  options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] }
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return { success: false, error: "Task not found" };
    }
    return { success: false, error: "Task is not running. Pending values can only be set for running tasks." };
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    return { success: false, error: `Task is not in an active state (status: ${status}). Pending values can only be set for active tasks.` };
  }

  if (options.model && (!options.model.providerID || !options.model.modelID)) {
    return { success: false, error: "Invalid model config: providerID and modelID are required" };
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
  options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] }
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(taskId);

  if (options.model && (!options.model.providerID || !options.model.modelID)) {
    return { success: false, error: "Invalid model config: providerID and modelID are required" };
  }

  if (!engine) {
    const task = await loadTask(taskId);
    if (!task) {
      return { success: false, error: "Task not found" };
    }

    if (isStaleTaskStatus(task.state.status)) {
      const reconciled = await resetStaleTask(taskId);
      if (reconciled) {
        log.warn(`Reconciled stale active task ${taskId} from persisted status ${task.state.status} before pending injection`);
        return jumpstartTaskFromEngine(ctx, taskId, options);
      }
    }

    const jumpstartableStates = ["completed", "stopped", "failed", "max_iterations", "planning"];
    if (jumpstartableStates.includes(task.state.status)) {
      return jumpstartTaskFromEngine(ctx, taskId, options);
    }

    return { success: false, error: "Task is not running. Pending values can only be injected for running tasks." };
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    const jumpstartableStates = ["completed", "stopped", "failed", "max_iterations"];
    if (jumpstartableStates.includes(status)) {
      return jumpstartTaskFromEngine(ctx, taskId, options);
    }
    return { success: false, error: `Task is not in an active state (status: ${status}). Pending values can only be injected for active tasks.` };
  }

  await engine.injectPendingNow(options);

  return { success: true };
}
