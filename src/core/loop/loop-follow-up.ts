import type { LoopCtx } from "./context";
import type { ModelConfig } from "../../types/loop";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type { SendFollowUpResult } from "./loop-types";
import { loadLoop } from "../../persistence/loops";
import { jumpstartLoopFromEngine } from "./loop-jumpstart";

export async function sendFollowUpImpl(
  ctx: LoopCtx,
  loopId: string,
  options: { message: string; model?: ModelConfig; attachments?: MessageImageAttachment[] }
): Promise<SendFollowUpResult> {
  const message = options.message.trim();
  if (message === "") {
    return { success: false, error: "Follow-up message cannot be empty" };
  }
  if (options.model && (!options.model.providerID || !options.model.modelID)) {
    return { success: false, error: "Invalid model config: providerID and modelID are required" };
  }

  const loop = await loadLoop(loopId);
  if (!loop) {
    return { success: false, error: "Loop not found" };
  }

  if (loop.state.status === "pushed" || loop.state.status === "merged") {
    return ctx.startFeedbackCycle(loopId, {
      prompt: message,
      model: options.model,
      attachments: options.attachments,
    });
  }

  if (loop.state.status === "deleted") {
    return jumpstartLoopFromEngine(ctx, loopId, {
      message,
      model: options.model,
      attachments: options.attachments,
    });
  }

  return jumpstartLoopFromEngine(ctx, loopId, {
    message,
    model: options.model,
    attachments: options.attachments,
  });
}
