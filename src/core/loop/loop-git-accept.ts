import type { LoopCtx } from "./context";
import type { AcceptLoopResult } from "./loop-types";
import { createTimestamp } from "../../types/events";
import { updateLoopState } from "../../persistence/loops";
import { backendManager } from "../backend-manager";
import { log } from "../logger";
import { assertValidTransition } from "../loop-state-machine";

export async function acceptLoopImpl(ctx: LoopCtx, loopId: string): Promise<AcceptLoopResult> {
  if (ctx.loopsBeingAccepted.has(loopId)) {
    log.warn(`[LoopManager] acceptLoop: Already accepting loop ${loopId}, ignoring duplicate call`);
    return { success: false, error: "Accept operation already in progress" };
  }

  const loop = await ctx.getLoop(loopId);
  if (!loop) {
    return { success: false, error: "Loop not found" };
  }

  if (loop.state.status !== "completed" && loop.state.status !== "max_iterations") {
    return { success: false, error: `Cannot accept loop in status: ${loop.state.status}` };
  }

  if (!loop.state.git) {
    return { success: false, error: "No git branch was created for this loop" };
  }

  ctx.loopsBeingAccepted.add(loopId);
  log.debug(`[LoopManager] acceptLoop: Starting accept for loop ${loopId}`);

  try {
    const reviewMode = loop.state.reviewMode
      ? {
          ...loop.state.reviewMode,
          addressable: true,
          completionAction: "local" as const,
        }
      : {
          addressable: true,
          completionAction: "local" as const,
          reviewCycles: 0,
        };

    assertValidTransition(loop.state.status, "accepted_local", "acceptLoop");
    const updatedState = {
      ...loop.state,
      status: "accepted_local" as const,
      reviewMode,
    };
    await updateLoopState(loopId, updatedState);

    await backendManager.disconnectLoop(loopId);

    ctx.engines.delete(loopId);

    ctx.emitter.emit({
      type: "loop.accepted",
      loopId,
      timestamp: createTimestamp(),
    });

    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  } finally {
    ctx.loopsBeingAccepted.delete(loopId);
    log.debug(`[LoopManager] acceptLoop: Finished accept for loop ${loopId}`);
  }
}
