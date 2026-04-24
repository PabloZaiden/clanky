import type { Loop } from "../../types/loop";
import { loadLoop, updateLoopState } from "../../persistence/loops";
import { createLogger } from "../logger";
import type { LoopCtx } from "./context";
import { emitAutomaticPrFlowUpdatedEvent } from "./loop-automatic-pr-flow-events";

const log = createLogger("core:loop-fully-autonomous");

function buildAutomationErrorState(loop: Loop, error: string): NonNullable<Loop["state"]["automaticPrFlow"]> {
  const now = new Date().toISOString();
  const existingState = loop.state.automaticPrFlow;
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

async function persistAutomationFailure(ctx: LoopCtx, loop: Loop, error: string): Promise<void> {
  loop.state.fullyAutonomousPending = false;
  loop.state.automaticPrFlow = buildAutomationErrorState(loop, error);
  await updateLoopState(loop.config.id, loop.state);
  emitAutomaticPrFlowUpdatedEvent(ctx.emitter, loop.config.id, loop.state.automaticPrFlow);
}

function isConcurrentCompletionNoop(error: string | undefined): boolean {
  return error === "Operation already in progress";
}

export async function finalizeFullyAutonomousPushImpl(ctx: LoopCtx, loopId: string): Promise<void> {
  const loop = await loadLoop(loopId);
  if (!loop || loop.state.fullyAutonomousPending !== true) {
    return;
  }

  if (loop.state.status !== "pushed") {
    log.debug("Skipping automatic PR flow start because loop is not yet pushed", {
      loopId,
      status: loop.state.status,
    });
    return;
  }

  const result = await ctx.startAutomaticPrFlow(loopId);
  if (!result.success) {
    const latestLoop = await loadLoop(loopId);
    if (latestLoop) {
      await persistAutomationFailure(
        ctx,
        latestLoop,
        result.error ?? "Fully autonomous loop failed to start the automatic PR flow after push.",
      );
    }
    return;
  }

  const latestLoop = await loadLoop(loopId);
  if (!latestLoop || latestLoop.state.fullyAutonomousPending !== true) {
    return;
  }

  latestLoop.state.fullyAutonomousPending = false;
  await updateLoopState(loopId, latestLoop.state);
}

export async function handleFullyAutonomousCompletionImpl(ctx: LoopCtx, loopId: string): Promise<void> {
  const loop = await loadLoop(loopId);
  if (!loop || loop.config.fullyAutonomous !== true || loop.state.fullyAutonomousPending !== true) {
    return;
  }

  if (loop.state.reviewMode?.reviewCycles && loop.state.reviewMode.reviewCycles > 0) {
    return;
  }

  if (loop.state.status !== "completed") {
    return;
  }

  const result = await ctx.pushLoop(loopId);
  if (!result.success) {
    if (isConcurrentCompletionNoop(result.error)) {
      return;
    }
    const latestLoop = await loadLoop(loopId);
    if (latestLoop) {
      await persistAutomationFailure(
        ctx,
        latestLoop,
        result.error ?? "Fully autonomous loop failed to push the completed branch.",
      );
    }
    return;
  }

  if (result.syncStatus === "conflicts_being_resolved") {
    return;
  }

  await finalizeFullyAutonomousPushImpl(ctx, loopId);
}
