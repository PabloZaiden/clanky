import type { Loop, LoopConfig, LoopState, LoopStatus, PersistedMessage } from "../../types/loop";
import { DEFAULT_LOOP_CONFIG } from "../../types/loop";
import { createTimestamp } from "../../types/events";
import { loadLoop, updateLoopConfig, updateLoopState } from "../../persistence/loops";
import { log } from "../logger";
import { assertValidTransition } from "../loop-state-machine";
import type { LoopCtx } from "./context";

const CONVERTIBLE_CHAT_STATUSES = new Set<LoopStatus>(["completed", "max_iterations"]);

function formatTranscriptMessage(message: PersistedMessage): string {
  const speaker = message.role === "user" ? "User" : "Assistant";
  const content = message.content.trim();
  const attachmentSummary = message.attachments?.length
    ? `\n[${message.attachments.length} image attachment${message.attachments.length === 1 ? "" : "s"} included with this message]`
    : "";
  return `${speaker}:\n${content}${attachmentSummary}`;
}

function buildConvertedPlanPrompt(loop: Loop): string {
  const transcriptMessages = loop.state.messages
    .map((message) => ({
      ...message,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0);

  if (transcriptMessages.length === 0 && loop.config.prompt.trim().length === 0) {
    throw new Error("Cannot convert chat to loop because there is no chat history to build a plan from.");
  }

  const transcript = transcriptMessages.map(formatTranscriptMessage).join("\n\n");
  const originalPrompt = loop.config.prompt.trim();

  return [
    "Use this chat conversation as the complete source of truth for the plan.",
    "Preserve the intent, constraints, requirements, and decisions already discussed.",
    "If the chat contains open questions or unresolved details, include them explicitly in the plan.",
    "",
    "Original chat prompt:",
    originalPrompt || "(no original prompt recorded)",
    "",
    "Recent chat transcript:",
    transcript || "(no additional transcript messages were persisted)",
  ].join("\n");
}

function buildConvertedLoopConfig(loop: Loop, prompt: string): LoopConfig {
  const now = createTimestamp();
  return {
    ...loop.config,
    prompt,
    updatedAt: now,
    mode: "loop",
    planMode: true,
    maxIterations: DEFAULT_LOOP_CONFIG.maxIterations,
  };
}

function buildConvertedLoopState(loop: Loop): LoopState {
  assertValidTransition(loop.state.status, "planning", "convertChatToLoop");

  return {
    ...loop.state,
    status: "planning",
    currentIteration: 0,
    completedAt: undefined,
    error: undefined,
    recentIterations: [],
    pendingPrompt: undefined,
    pendingModel: undefined,
    consecutiveErrors: undefined,
    syncState: undefined,
    planMode: {
      active: true,
      feedbackRounds: 0,
      planningFolderCleared: false,
      isPlanReady: false,
      planSessionId: loop.state.session?.id,
      planServerUrl: loop.state.session?.serverUrl,
    },
  };
}

async function persistConvertedLoop(
  loopId: string,
  config: LoopConfig,
  state: LoopState,
): Promise<void> {
  const configUpdated = await updateLoopConfig(loopId, config);
  if (!configUpdated) {
    throw new Error(`Loop not found: ${loopId}`);
  }

  const stateUpdated = await updateLoopState(loopId, state);
  if (!stateUpdated) {
    throw new Error(`Loop not found: ${loopId}`);
  }
}

export async function convertChatToLoopImpl(ctx: LoopCtx, loopId: string): Promise<Loop> {
  const existingEngine = ctx.engines.get(loopId);
  if (existingEngine) {
    await existingEngine.waitForLoopIdle();
  }

  const currentLoop = existingEngine
    ? { config: existingEngine.config, state: existingEngine.state }
    : await loadLoop(loopId);

  if (!currentLoop) {
    throw new Error(`Loop not found: ${loopId}`);
  }

  if (currentLoop.config.mode !== "chat") {
    throw new Error(`Loop is not a chat (mode: ${currentLoop.config.mode})`);
  }

  if (!CONVERTIBLE_CHAT_STATUSES.has(currentLoop.state.status)) {
    throw new Error(`Cannot convert chat to loop in status: ${currentLoop.state.status}`);
  }

  if (!currentLoop.state.session?.id) {
    throw new Error("Cannot convert chat to loop because the original agent session is unavailable.");
  }

  const prompt = buildConvertedPlanPrompt(currentLoop);
  const updatedConfig = buildConvertedLoopConfig(currentLoop, prompt);
  const updatedState = buildConvertedLoopState(currentLoop);

  if (existingEngine) {
    Object.assign(existingEngine.config, updatedConfig);
    Object.assign(existingEngine.state, updatedState);
    await persistConvertedLoop(loopId, existingEngine.config, existingEngine.state);
    ctx.startStatePersistence(loopId);
    existingEngine.runPlanIteration().catch((error) => {
      log.error(`Converted chat planning iteration failed for loop ${loopId}: ${String(error)}`);
    });
    return { config: existingEngine.config, state: existingEngine.state };
  }

  await persistConvertedLoop(loopId, updatedConfig, updatedState);
  const planningEngine = await ctx.recoverPlanningEngine(loopId);
  planningEngine.runPlanIteration().catch((error) => {
    log.error(`Recovered converted chat planning iteration failed for loop ${loopId}: ${String(error)}`);
  });
  return { config: planningEngine.config, state: planningEngine.state };
}
