/**
 * Prompt building helpers for LoopEngine.
 */

import { log } from "../logger";
import type { LoopConfig, LoopState, ModelConfig } from "../../types/loop";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type { LogLevel } from "../../types/events";
import type { PromptInput } from "../../backends/types";
import type { IterationContext } from "./engine-types";
import { StopPatternDetector } from "./engine-helpers";

export interface PromptBuildContext {
  config: LoopConfig;
  state: LoopState;
  workingDirectory: string;
  isChatMode: boolean;
  stopDetector: StopPatternDetector;
  emitUserMessage: (content: string, idSuffix?: string, attachments?: MessageImageAttachment[]) => void;
  emitLog: (level: LogLevel, message: string, details?: Record<string, unknown>) => string;
  updateState: (update: Partial<LoopState>) => void;
  consumeInitialPromptAttachments: () => MessageImageAttachment[];
  consumePendingPromptAttachments: () => MessageImageAttachment[];
}

function buildPromptParts(text: string, attachments: MessageImageAttachment[]): PromptInput["parts"] {
  return [
    { type: "text", text },
    ...attachments.map((attachment) => ({
      type: "image" as const,
      mimeType: attachment.mimeType,
      data: attachment.data,
      filename: attachment.filename,
    })),
  ];
}

function consumePendingOrInitialAttachments(ctx: PromptBuildContext): MessageImageAttachment[] {
  const pendingAttachments = ctx.consumePendingPromptAttachments();
  if (pendingAttachments.length > 0) {
    return pendingAttachments;
  }
  return ctx.consumeInitialPromptAttachments();
}

export function buildErrorContext(consecutiveErrors: LoopState["consecutiveErrors"]): string {
  if (!consecutiveErrors) {
    return "";
  }
  return `\n- **Previous Iteration Error**: The previous iteration failed with the following error (occurred ${consecutiveErrors.count} time(s) consecutively). Please try a different approach to avoid this error:\n\n  Error: ${consecutiveErrors.lastErrorMessage}\n`;
}

export function buildLoopPrompt(ctx: PromptBuildContext, _iteration: number): PromptInput {
  let model = ctx.config.model;
  if (ctx.state.pendingModel) {
    model = ctx.state.pendingModel;
    ctx.emitLog("info", "Using pending model for this iteration", {
      previousModel: ctx.config.model ? `${ctx.config.model.providerID}/${ctx.config.model.modelID}` : "default",
      newModel: `${model.providerID}/${model.modelID}`,
    });
    ctx.config.model = model;
    ctx.updateState({ pendingModel: undefined });
  }

  if (ctx.isChatMode) {
    return buildChatPrompt(ctx, model);
  }

  if (ctx.state.status === "planning" && ctx.state.planMode?.active) {
    return buildPlanModePrompt(ctx, model);
  }

  return buildExecutionPrompt(ctx, model);
}

function buildPlanModePrompt(ctx: PromptBuildContext, model: ModelConfig | undefined): PromptInput {
  const feedbackRounds = ctx.state.planMode!.feedbackRounds;

  if (feedbackRounds === 0) {
    const attachments = ctx.consumeInitialPromptAttachments();
    ctx.emitUserMessage(ctx.config.prompt, "initial-goal", attachments);

    const errorContext = buildErrorContext(ctx.state.consecutiveErrors);
    const text = `- Goal: ${ctx.config.prompt}
${errorContext}
- Create a detailed plan to achieve this goal. Write the plan to \`./.planning/plan.md\`.

- The plan should include:
  - Clear objectives
  - Step-by-step tasks with descriptions
  - Any dependencies between tasks
  - Estimated complexity per task

- Create a \`./.planning/status.md\` file to track progress.

- Do NOT start implementing yet. Only create the plan.

- When the plan is ready, end your response with:

<promise>PLAN_READY</promise>`;

    return {
      parts: buildPromptParts(text, attachments),
      model,
    };
  }

  const feedback = ctx.state.pendingPrompt ?? "Please refine the plan based on feedback.";
  const attachments = consumePendingOrInitialAttachments(ctx);

  if (ctx.state.pendingPrompt) {
    ctx.emitUserMessage(ctx.state.pendingPrompt, `plan-feedback-${feedbackRounds}`, attachments);
  }

  const errorContext = buildErrorContext(ctx.state.consecutiveErrors);
  const text = `The user has provided feedback on your plan:

---
${feedback}
---
${errorContext}
**FIRST**: Immediately add this feedback as a pending item in \`./.planning/status.md\` so it is tracked and preserved even if the conversation context is compacted.

Then, update the plan in \`./.planning/plan.md\` based on this feedback.

When the updated plan is ready, end your response with:

<promise>PLAN_READY</promise>`;

  ctx.updateState({ pendingPrompt: undefined });

  return {
    parts: buildPromptParts(text, attachments),
    model,
  };
}

function buildChatPrompt(ctx: PromptBuildContext, model: ModelConfig | undefined): PromptInput {
  const userMessage = ctx.state.pendingPrompt;
  const attachments = userMessage
    ? consumePendingOrInitialAttachments(ctx)
    : ctx.consumeInitialPromptAttachments();

  const messageToLog = userMessage ?? ctx.config.prompt;
  const userMessageIdSuffix = userMessage
    ? `chat-turn-${crypto.randomUUID()}`
    : "initial-goal";
  ctx.emitUserMessage(messageToLog, userMessageIdSuffix, attachments);

  ctx.updateState({ pendingPrompt: undefined });

  const errorContext = buildErrorContext(ctx.state.consecutiveErrors);

  const isFirstMessage = ctx.state.currentIteration <= 1;
  const contextSection = isFirstMessage
    ? `You are working in directory: ${ctx.workingDirectory}\n\n`
    : "";

  const text = `${contextSection}${errorContext}${userMessage ?? ctx.config.prompt}`;

  return {
    parts: buildPromptParts(text, attachments),
    model,
  };
}

function buildExecutionPrompt(ctx: PromptBuildContext, model: ModelConfig | undefined): PromptInput {
  const userMessage = ctx.state.pendingPrompt;
  const attachments = userMessage
    ? consumePendingOrInitialAttachments(ctx)
    : ctx.state.currentIteration <= 1
    ? ctx.consumeInitialPromptAttachments()
    : [];

  if (userMessage) {
    ctx.emitUserMessage(userMessage, `injected-${crypto.randomUUID()}`, attachments);
    ctx.emitLog("info", "User injected a new message", {
      originalGoal: ctx.config.prompt.slice(0, 50) + (ctx.config.prompt.length > 50 ? "..." : ""),
      userMessage: userMessage.slice(0, 50) + (userMessage.length > 50 ? "..." : ""),
    });
    ctx.updateState({
      pendingPrompt: undefined,
    });
  } else if (ctx.state.currentIteration <= 1) {
    ctx.emitUserMessage(ctx.config.prompt, "initial-goal", attachments);
  }

  const userMessageSection = userMessage
    ? `\n- **User Message**: The user has added the following message. This should be your primary focus for this iteration. Address it while keeping the original goal in mind. **Before starting work on this message, immediately add it as a pending task in \`./.planning/status.md\`** so it is tracked and preserved even if the conversation context is compacted:\n\n${userMessage}\n`
    : "";

  const errorContext = buildErrorContext(ctx.state.consecutiveErrors);

  const text = `- Original Goal: ${ctx.config.prompt}
${userMessageSection}${errorContext}
- Read AGENTS.md, read the document in the \`./.planning\` folder, pick up the most important task to continue with, and make sure you make a plan with coding tasks that includes updating the docs with your progress and what the next steps to work on are, at the end. Don't ask for confirmation and start working on it right away.

- If the \`./.planning\` folder does not exist or is empty, create it and add a file called \`plan.md\` where you outline your plan to achieve the goal, and a \`status.md\` file to track progress.

- If the user added a new message above, prioritize addressing it. It may change or add to the plan. If it contradicts something in the original goal or plan, follow the user's latest message.

- Make sure that the implementations and fixes you make don't contradict the core design principles outlined in AGENTS.md and the planning document.

- Add tasks to the plan to achieve the goal.

- Never ask for input from the user or any questions. This will always run unattended

- **IMPORTANT — Incremental progress tracking**: After completing each individual task, immediately update \`./.planning/status.md\` to mark the task as completed and note any relevant findings or context. Do NOT wait until the end of the iteration to update status — update it after every task so that progress is preserved even if the iteration is interrupted or the conversation context is compacted mid-work.

- **IMPORTANT — Pre-compaction persistence**: Before ending your response, you MUST also update \`./.planning/status.md\` with:
  - The task you are currently working on and its current state
  - Updated status of all tasks in the plan
  - Any new learnings, discoveries, or important context gathered during this iteration
  - What the next steps should be when work resumes
  This ensures that your progress is preserved even if the conversation context is compacted or summarized between iterations. The status file is your persistent memory — treat it as the source of truth for what has been done and what remains.

- When you think you're done, check the plan and status files to ensure all tasks are actually marked as completed.

- Only if you have completed every single non-manual task in the plan, end your response with:

<promise>COMPLETE</promise>`;

  return {
    parts: buildPromptParts(text, attachments),
    model,
  };
}

export function evaluateLoopOutcome(ctx: IterationContext, buildCtx: PromptBuildContext): void {
  buildCtx.emitLog("info", "Evaluating stop pattern...");

  if (ctx.outcome === "error") {
    return;
  }

  if (buildCtx.isChatMode) {
    buildCtx.emitLog("info", "Chat mode - turn completed");
    ctx.outcome = "complete";
    return;
  }

  const isInPlanMode = buildCtx.state.status === "planning" && buildCtx.state.planMode?.active;
  const planReadyPattern = /<promise>PLAN_READY<\/promise>/;

  if (isInPlanMode && planReadyPattern.test(ctx.responseContent)) {
    buildCtx.emitLog("info", "PLAN_READY marker detected - plan is ready for review");
    ctx.outcome = "plan_ready";
    if (buildCtx.state.planMode) {
      buildCtx.state.planMode.isPlanReady = true;
      log.debug(`[LoopEngine] runIteration: Set isPlanReady = true, planMode:`, JSON.stringify(buildCtx.state.planMode));
    }
  } else if (buildCtx.stopDetector.matches(ctx.responseContent)) {
    buildCtx.emitLog("info", "Stop pattern matched - task is complete");
    ctx.outcome = "complete";
  } else {
    buildCtx.emitLog("info", "Stop pattern not matched - will continue to next iteration");
  }
}
