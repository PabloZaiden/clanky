import type { LoopCtx } from "./context";
import type { Loop } from "../../types/loop";
import type { StartLoopOptions } from "./loop-types";
import { LoopEngine } from "../loop-engine";
import { createTimestamp } from "../../types/events";
import { loadLoop, updateLoopState } from "../../persistence/loops";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { log } from "../logger";
import { assertValidTransition } from "../loop-state-machine";
import { startStatePersistenceImpl } from "./loop-state-persistence";
import { validateMainCheckoutStartImpl } from "./loop-git-validation";
import { clearPlanningFilesImpl } from "./loop-planning-files";

export { startStatePersistenceImpl } from "./loop-state-persistence";
export { validateMainCheckoutStartImpl, ensureLoopBranchCheckedOutImpl } from "./loop-git-validation";
export { clearPlanningFilesImpl } from "./loop-planning-files";
export { recoverPlanningEngineImpl } from "./loop-engine-recovery";

export async function startLoopImpl(ctx: LoopCtx, loopId: string, _options?: StartLoopOptions): Promise<void> {
  const loop = await loadLoop(loopId);
  if (!loop) {
    throw new Error(`Loop not found: ${loopId}`);
  }

  if (ctx.engines.has(loopId)) {
    throw new Error("Loop is already running");
  }

  log.info("Starting loop execution", {
    loopId,
    workspaceId: loop.config.workspaceId,
    mode: loop.config.mode,
  });

  const executor = await backendManager.getCommandExecutorAsync(loop.config.workspaceId, loop.config.directory);
  const git = GitService.withExecutor(executor);

  await validateMainCheckoutStartImpl(ctx, loop, git);

  const backend = backendManager.getLoopBackend(loopId, loop.config.workspaceId);

  const engine = new LoopEngine({
    loop,
    backend,
    gitService: git,
    eventEmitter: ctx.emitter,
    onPersistState: async (state) => {
      await updateLoopState(loopId, state);
    },
    initialPromptAttachments: _options?.attachments,
  });

  ctx.engines.set(loopId, engine);

  startStatePersistenceImpl(ctx, loopId);

  log.info("Loop execution started", {
    loopId,
    workspaceId: loop.config.workspaceId,
  });
  engine.start().catch((error) => {
    log.error("Loop execution failed after start", {
      loopId,
      error: String(error),
    });
  });
}

export async function stopLoopImpl(ctx: LoopCtx, loopId: string, reason = "User requested stop"): Promise<void> {
  const engine = ctx.engines.get(loopId);
  if (!engine) {
    throw new Error("Loop is not running");
  }

  log.info("Stopping loop execution", { loopId, reason });
  await engine.stop(reason);
  ctx.engines.delete(loopId);

  await backendManager.disconnectLoop(loopId);

  if (engine.state.syncState?.autoPushOnComplete) {
    engine.state.syncState.autoPushOnComplete = false;
  }

  await updateLoopState(loopId, engine.state);
  log.info("Loop execution stopped", { loopId, reason, status: engine.state.status });
}

export async function startPlanModeImpl(ctx: LoopCtx, loopId: string, options?: StartLoopOptions): Promise<void> {
  const loop = await loadLoop(loopId);
  if (!loop) {
    throw new Error(`Loop not found: ${loopId}`);
  }

  if (loop.state.status !== "planning") {
    throw new Error(`Loop is not in planning status: ${loop.state.status}`);
  }

  if (ctx.engines.has(loopId)) {
    throw new Error("Loop plan mode is already running");
  }

  log.info("Starting loop plan mode", {
    loopId,
    workspaceId: loop.config.workspaceId,
  });

  const executor = await backendManager.getCommandExecutorAsync(loop.config.workspaceId, loop.config.directory);
  const git = GitService.withExecutor(executor);

  await validateMainCheckoutStartImpl(ctx, loop, git);

  if (!loop.state.startedAt) {
    loop.state.startedAt = createTimestamp();
  }
  await updateLoopState(loopId, loop.state);

  const backend = backendManager.getLoopBackend(loopId, loop.config.workspaceId);

  const engine = new LoopEngine({
    loop,
    backend,
    gitService: git,
    eventEmitter: ctx.emitter,
    onPersistState: async (state) => {
      await updateLoopState(loopId, state);
    },
    onPlanReady: async () => {
      await ctx.acceptPlan(loopId);
    },
    initialPromptAttachments: options?.attachments,
  });

  try {
    await engine.setupGitBranchForPlanAcceptance();
  } catch (error) {
    throw new Error(`Failed to set up git branch for plan mode: ${String(error)}`, { cause: error });
  }

  const workingDirectory = engine.workingDirectory;

  await clearPlanningFilesImpl(ctx, loopId, loop, executor, workingDirectory);

  ctx.engines.set(loopId, engine);

  startStatePersistenceImpl(ctx, loopId);

  log.info("Loop plan mode started", {
    loopId,
    workspaceId: loop.config.workspaceId,
  });
  engine.start().catch((error) => {
    log.error("Loop plan mode failed after start", {
      loopId,
      error: String(error),
    });
  });
}

export async function startDraftImpl(
  ctx: LoopCtx,
  loopId: string,
  options: { planMode: boolean; attachments?: StartLoopOptions["attachments"] }
): Promise<Loop> {
  const loop = await loadLoop(loopId);
  if (!loop) {
    throw new Error(`Loop not found: ${loopId}`);
  }

  if (loop.state.status !== "draft") {
    throw new Error(`Loop is not in draft status: ${loop.state.status}`);
  }

  if (options.planMode) {
    assertValidTransition(loop.state.status, "planning", "startDraft");
    loop.state.status = "planning";
    loop.state.planMode = {
      active: true,
      feedbackRounds: 0,
      planningFolderCleared: false,
      isPlanReady: false,
    };
    await updateLoopState(loopId, loop.state);

    await startPlanModeImpl(ctx, loopId, { attachments: options.attachments });
  } else {
    assertValidTransition(loop.state.status, "idle", "startDraft");
    loop.state.status = "idle";
    await updateLoopState(loopId, loop.state);

    await startLoopImpl(ctx, loopId, { attachments: options.attachments });
  }

  const updatedLoop = await ctx.getLoop(loopId);
  return updatedLoop ?? loop;
}
