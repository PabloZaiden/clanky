import type { LoopCtx } from "./context";
import type { ModelConfig } from "../../types/loop";
import type { MessageImageAttachment } from "../../types/message-attachments";
import { createLogger } from "../logger";
import { isStaleLoopStatus, loadLoop, resetStaleLoop } from "../../persistence/loops";
import { jumpstartLoopFromEngine } from "./loop-jumpstart";

const log = createLogger("loop:pending");

export async function setPendingPromptImpl(
  ctx: LoopCtx,
  loopId: string,
  prompt: string,
  attachments: MessageImageAttachment[] = [],
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(loopId);
  if (!engine) {
    const loop = await loadLoop(loopId);
    if (!loop) {
      return { success: false, error: "Loop not found" };
    }
    return { success: false, error: "Loop is not running. Pending prompts can only be set for running loops." };
  }

  const status = engine.state.status;
  if (status !== "running" && status !== "starting") {
    return { success: false, error: `Loop is not running (status: ${status}). Pending prompts can only be set for running loops.` };
  }

  engine.setPendingPrompt(prompt, attachments);

  return { success: true };
}

export async function clearPendingPromptImpl(
  ctx: LoopCtx,
  loopId: string
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(loopId);
  if (!engine) {
    const loop = await loadLoop(loopId);
    if (!loop) {
      return { success: false, error: "Loop not found" };
    }
    return { success: false, error: "Loop is not running. Pending prompts can only be cleared for running loops." };
  }

  const status = engine.state.status;
  if (status !== "running" && status !== "starting") {
    return { success: false, error: `Loop is not running (status: ${status}). Pending prompts can only be cleared for running loops.` };
  }

  engine.clearPendingPrompt();

  return { success: true };
}

export async function setPendingModelImpl(
  ctx: LoopCtx,
  loopId: string,
  model: ModelConfig
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(loopId);
  if (!engine) {
    const loop = await loadLoop(loopId);
    if (!loop) {
      return { success: false, error: "Loop not found" };
    }
    return { success: false, error: "Loop is not running. Pending model can only be set for running loops." };
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    return { success: false, error: `Loop is not in an active state (status: ${status}). Pending model can only be set for active loops.` };
  }

  if (!model.providerID || !model.modelID) {
    return { success: false, error: "Invalid model config: providerID and modelID are required" };
  }

  engine.setPendingModel(model);

  return { success: true };
}

export async function clearPendingModelImpl(
  ctx: LoopCtx,
  loopId: string
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(loopId);
  if (!engine) {
    const loop = await loadLoop(loopId);
    if (!loop) {
      return { success: false, error: "Loop not found" };
    }
    return { success: false, error: "Loop is not running. Pending model can only be cleared for running loops." };
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    return { success: false, error: `Loop is not in an active state (status: ${status}). Pending model can only be cleared for active loops.` };
  }

  engine.clearPendingModel();

  return { success: true };
}

export async function clearPendingImpl(
  ctx: LoopCtx,
  loopId: string
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(loopId);
  if (!engine) {
    const loop = await loadLoop(loopId);
    if (!loop) {
      return { success: false, error: "Loop not found" };
    }
    return { success: false, error: "Loop is not running. Pending values can only be cleared for running loops." };
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    return { success: false, error: `Loop is not in an active state (status: ${status}). Pending values can only be cleared for active loops.` };
  }

  engine.clearPending();

  return { success: true };
}

export async function setPendingImpl(
  ctx: LoopCtx,
  loopId: string,
  options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] }
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(loopId);
  if (!engine) {
    const loop = await loadLoop(loopId);
    if (!loop) {
      return { success: false, error: "Loop not found" };
    }
    return { success: false, error: "Loop is not running. Pending values can only be set for running loops." };
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    return { success: false, error: `Loop is not in an active state (status: ${status}). Pending values can only be set for active loops.` };
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
  ctx: LoopCtx,
  loopId: string,
  options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] }
): Promise<{ success: boolean; error?: string }> {
  const engine = ctx.engines.get(loopId);

  if (options.model && (!options.model.providerID || !options.model.modelID)) {
    return { success: false, error: "Invalid model config: providerID and modelID are required" };
  }

  if (!engine) {
    const loop = await loadLoop(loopId);
    if (!loop) {
      return { success: false, error: "Loop not found" };
    }

    if (isStaleLoopStatus(loop.state.status)) {
      const reconciled = await resetStaleLoop(loopId);
      if (reconciled) {
        log.warn(`Reconciled stale active loop ${loopId} from persisted status ${loop.state.status} before pending injection`);
        return jumpstartLoopFromEngine(ctx, loopId, options);
      }
    }

    const jumpstartableStates = ["completed", "stopped", "failed", "max_iterations", "planning"];
    if (jumpstartableStates.includes(loop.state.status)) {
      return jumpstartLoopFromEngine(ctx, loopId, options);
    }

    return { success: false, error: "Loop is not running. Pending values can only be injected for running loops." };
  }

  const status = engine.state.status;
  if (!["running", "waiting", "planning", "starting"].includes(status)) {
    const jumpstartableStates = ["completed", "stopped", "failed", "max_iterations"];
    if (jumpstartableStates.includes(status)) {
      return jumpstartLoopFromEngine(ctx, loopId, options);
    }
    return { success: false, error: `Loop is not in an active state (status: ${status}). Pending values can only be injected for active loops.` };
  }

  await engine.injectPendingNow(options);

  return { success: true };
}
