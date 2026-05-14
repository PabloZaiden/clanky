import type { LoopCtx } from "./context";
import type { Loop, LoopStatus, ModelConfig } from "../../types/loop";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type { SendFollowUpOptions, SendFollowUpResult } from "./loop-types";
import { loadLoop } from "../../persistence/loops";
import { updateLoopState } from "../../persistence/loops";
import { LoopEngine } from "../loop-engine";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { createTimestamp } from "../../types/events";
import { log } from "../logger";
import { assertValidTransition } from "../loop-state-machine";
import { canReuseExistingBranch, jumpstartLoopFromEngine } from "./loop-jumpstart";
import { getLoopWorkingDirectory } from "./loop-types";
import { startStatePersistenceImpl } from "./loop-state-persistence";

export async function sendFollowUpImpl(
  ctx: LoopCtx,
  loopId: string,
  options: SendFollowUpOptions,
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

  const promptMode = options.promptMode ?? "loop_context";
  if (promptMode === "plain_chat") {
    return startPlainChatFollowUp(ctx, loop, {
      message,
      model: options.model,
      attachments: options.attachments,
    });
  }

  if (loop.state.status === "pushed" || loop.state.status === "accepted_local") {
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

async function startPlainChatFollowUp(
  ctx: LoopCtx,
  loop: Loop,
  options: { message: string; model?: ModelConfig; attachments?: MessageImageAttachment[] },
): Promise<SendFollowUpResult> {
  const loopId = loop.config.id;
  const activeEngine = ctx.engines.get(loopId);
  if (activeEngine && isActiveSingleTurnStatus(activeEngine.state.status)) {
    return { success: false, error: `Loop is already active (status: ${activeEngine.state.status})` };
  }

  if (loop.state.planMode?.active || loop.state.status === "planning") {
    return { success: false, error: "Planning loops must receive feedback through plan feedback" };
  }

  if (loop.state.status !== "completed") {
    return { success: false, error: `Loop cannot accept a plain chat follow-up from status: ${loop.state.status}` };
  }

  if (!(await canReuseExistingBranch(loop))) {
    return { success: false, error: "Cannot resume conversation: the loop branch or worktree is no longer available" };
  }

  const workingDirectory = getLoopWorkingDirectory(loop);
  if (!workingDirectory) {
    return { success: false, error: "Loop is configured to use a worktree, but no worktree path is available - cannot resume conversation" };
  }

  const executor = await backendManager.getCommandExecutorAsync(loop.config.workspaceId, workingDirectory);
  const git = GitService.withExecutor(executor);
  await ctx.ensureLoopBranchCheckedOut(loop, git, workingDirectory);

  if (activeEngine) {
    ctx.engines.delete(loopId);
  }

  const engine = new LoopEngine({
    loop,
    backend: backendManager.getLoopBackend(loopId, loop.config.workspaceId),
    gitService: git,
    eventEmitter: ctx.emitter,
    onPersistState: async (state) => {
      await updateLoopState(loopId, state);
    },
    skipGitSetup: true,
  });

  const previousSessionId = engine.state.session?.id;
  try {
    await engine.reconnectSession();
  } catch (error) {
    if (ctx.engines.get(loopId) === engine) {
      ctx.engines.delete(loopId);
    }
    return { success: false, error: `Failed to reconnect loop session: ${String(error)}` };
  }
  if (previousSessionId && engine.state.session?.id && engine.state.session.id !== previousSessionId) {
    log.warn("Previous loop session expired; plain chat follow-up is starting with a fresh session", {
      loopId,
      previousSessionId,
      newSessionId: engine.state.session.id,
    });
  }

  preparePlainChatState(engine, options);
  await updateLoopState(loopId, engine.state);
  ctx.engines.set(loopId, engine);
  startStatePersistenceImpl(ctx, loopId);

  engine.runSingleTurn().catch(async (error) => {
    log.error(`Plain chat follow-up failed for loop ${loopId}: ${String(error)}`);
    if (engine.state.status === "running" || engine.state.status === "starting") {
      assertValidTransition(engine.state.status, "failed", "plainChatFollowUp");
      engine.state.status = "failed";
      engine.state.completedAt = createTimestamp();
      engine.state.error = {
        message: String(error),
        iteration: engine.state.currentIteration,
        timestamp: createTimestamp(),
      };
      await updateLoopState(loopId, engine.state);
    }
  });

  return { success: true };
}

function preparePlainChatState(
  engine: LoopEngine,
  options: { message: string; model?: ModelConfig; attachments?: MessageImageAttachment[] },
): void {
  const state = engine.state;
  if (state.status === "failed" || state.status === "max_iterations") {
    assertValidTransition(state.status, "stopped", "plainChatFollowUp");
    state.status = "stopped";
  }

  assertValidTransition(state.status, "starting", "plainChatFollowUp");
  state.status = "starting";
  assertValidTransition(state.status, "running", "plainChatFollowUp");
  state.status = "running";
  state.startedAt ??= createTimestamp();
  state.completedAt = undefined;
  state.error = undefined;
  state.syncState = undefined;
  engine.setPendingPrompt(options.message, options.attachments, "plain_chat");
  if (options.model) {
    engine.setPendingModel(options.model);
  }
}

function isActiveSingleTurnStatus(status: LoopStatus): boolean {
  return status === "starting" || status === "running" || status === "planning" || status === "resolving_conflicts";
}
