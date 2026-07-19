/**
 * Prompt building helpers for TaskEngine.
 */

import { log } from "@pablozaiden/webapp/server";
import type { TaskConfig, TaskState, ModelConfig } from "@/shared/task";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import type { LogLevel } from "@/shared/events";
import type { PromptInput } from "../../backends/types";
import { buildPromptParts } from "../../backends/prompt-parts";
import type { IterationContext } from "./engine-types";
import { StopPatternDetector } from "./engine-helpers";
import { detectTrailingPromiseMarker } from "../../utils/promise-markers";

export interface PromptBuildContext {
  config: TaskConfig;
  state: TaskState;
  workingDirectory: string;
  stopDetector: StopPatternDetector;
  emitUserMessage: (content: string, idSuffix?: string, attachments?: MessageImageAttachment[]) => void;
  emitLog: (level: LogLevel, message: string, details?: Record<string, unknown>) => string;
  updateState: (update: Partial<TaskState>) => void;
  consumeInitialPromptAttachments: () => MessageImageAttachment[];
  consumePendingPromptAttachments: () => MessageImageAttachment[];
}

const BLOCKED_OUTCOME_INSTRUCTION = `- If you are blocked by an external dependency, missing prerequisite, or issue you cannot safely work around, explain the blocker and end your response with:

<promise>BLOCKED</promise>

Do not claim completion. Clanky will stop the task without pushing it, and the user can resume it with a follow-up message.`;

function consumePendingOrInitialAttachments(ctx: PromptBuildContext): MessageImageAttachment[] {
  const pendingAttachments = ctx.consumePendingPromptAttachments();
  if (pendingAttachments.length > 0) {
    return pendingAttachments;
  }
  return ctx.consumeInitialPromptAttachments();
}

export function buildErrorContext(consecutiveErrors: TaskState["consecutiveErrors"]): string {
  if (!consecutiveErrors) {
    return "";
  }
  return `\n- **Previous Iteration Error**: The previous iteration failed with the following error (occurred ${consecutiveErrors.count} time(s) consecutively). Please try a different approach to avoid this error:\n\n  Error: ${consecutiveErrors.lastErrorMessage}\n`;
}

export function buildTaskPrompt(ctx: PromptBuildContext, _iteration: number): PromptInput {
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

  if (ctx.state.status === "planning" && ctx.state.planMode?.active) {
    return buildPlanModePrompt(ctx, model);
  }

  if (ctx.state.pendingPromptMode === "plain_chat") {
    return buildPlainChatPrompt(ctx, model);
  }

  return buildExecutionPrompt(ctx, model);
}

function buildPlanModePrompt(ctx: PromptBuildContext, model: ModelConfig | undefined): PromptInput {
  const feedbackRounds = ctx.state.planMode!.feedbackRounds;

  if (feedbackRounds === 0 && !ctx.state.pendingPrompt) {
    const attachments = ctx.consumeInitialPromptAttachments();
    ctx.emitUserMessage(ctx.config.prompt, "initial-goal", attachments);

    const errorContext = buildErrorContext(ctx.state.consecutiveErrors);
    const questionsInstruction = ctx.config.autoAcceptPlan === true
      ? ""
      : "- Near the end of your plan, include all questions you need answered before implementation, if any. Ask only about genuine gray areas or ambiguities in the original requirements; do not ask about extra ideas, enhancements, preferences, or work beyond those requirements.";
    const finalInstructions = [
      "- Do NOT start implementing yet. Only create the plan.",
      questionsInstruction,
      BLOCKED_OUTCOME_INSTRUCTION,
      "- When the plan is ready, end your response with:\n\n<promise>PLAN_READY</promise>",
    ].filter((instruction) => instruction.length > 0).join("\n\n");
    const text = `- Goal: ${ctx.config.prompt}
${errorContext}
- Create a detailed plan to achieve this goal. Write the plan to \`./.clanky-planning/plan.md\`.

- The plan should include:
  - Clear objectives
  - Step-by-step tasks with descriptions
  - Any dependencies between tasks
  - Estimated complexity per task

- Create a \`./.clanky-planning/status.md\` file to track progress.

${finalInstructions}`;

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
**FIRST**: Immediately add this feedback as a pending item in \`./.clanky-planning/status.md\` so it is tracked and preserved even if the conversation context is compacted.

Then, update the plan in \`./.clanky-planning/plan.md\` based on this feedback.

${BLOCKED_OUTCOME_INSTRUCTION}

When the updated plan is ready, end your response with:

<promise>PLAN_READY</promise>`;

  ctx.updateState({ pendingPrompt: undefined, pendingPromptMode: undefined });

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
      pendingPromptMode: undefined,
    });
  } else if (ctx.state.currentIteration <= 1) {
    ctx.emitUserMessage(ctx.config.prompt, "initial-goal", attachments);
  }

  const userMessageSection = userMessage
    ? `\n- **User Message**: The user has added the following message. This should be your primary focus for this iteration. Address it while keeping the original goal in mind. **Before starting work on this message, immediately add it as a pending task in \`./.clanky-planning/status.md\`** so it is tracked and preserved even if the conversation context is compacted:\n\n${userMessage}\n`
    : "";

  const errorContext = buildErrorContext(ctx.state.consecutiveErrors);

  const text = `- Original Goal: ${ctx.config.prompt}
${userMessageSection}${errorContext}
- Read the documents in the \`./.clanky-planning\` folder, pick up the most important task to continue with, and make sure you make a plan with coding tasks that includes updating the docs with your progress and what the next steps to work on are, at the end. Don't ask for confirmation and start working on it right away.

- If the \`./.clanky-planning\` folder does not exist or is empty, create it and add a file called \`plan.md\` where you outline your plan to achieve the goal, and a \`status.md\` file to track progress.

- If the user added a new message above, prioritize addressing it. It may change or add to the plan. If it contradicts something in the original goal or plan, follow the user's latest message.

- Make sure that the implementations and fixes you make don't contradict the planning document, the existing codebase behavior, or established project conventions.

- Add tasks to the plan to achieve the goal.

- Never ask for input from the user or any questions. This will always run unattended

${BLOCKED_OUTCOME_INSTRUCTION}

- **IMPORTANT — Incremental progress tracking**: After completing each individual task, immediately update \`./.clanky-planning/status.md\` to mark the task as completed and note any relevant findings or context. Do NOT wait until the end of the iteration to update status — update it after every task so that progress is preserved even if the iteration is interrupted or the conversation context is compacted mid-work.

- **IMPORTANT — Pre-compaction persistence**: Before ending your response, you MUST also update \`./.clanky-planning/status.md\` with:
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

function buildPlainChatPrompt(ctx: PromptBuildContext, model: ModelConfig | undefined): PromptInput {
  const userMessage = ctx.state.pendingPrompt;
  if (!userMessage) {
    throw new Error("Plain chat prompt requested without a pending message");
  }

  const attachments = consumePendingOrInitialAttachments(ctx);
  ctx.emitUserMessage(userMessage, `plain-chat-${crypto.randomUUID()}`, attachments);
  ctx.emitLog("info", "User sent a plain chat message", {
    userMessage: userMessage.slice(0, 50) + (userMessage.length > 50 ? "..." : ""),
  });
  ctx.updateState({
    pendingPrompt: undefined,
    pendingPromptMode: undefined,
  });

  return {
    parts: buildPromptParts(userMessage, attachments),
    model,
  };
}

export function evaluateTaskOutcome(ctx: IterationContext, buildCtx: PromptBuildContext): void {
  buildCtx.emitLog("info", "Evaluating stop pattern...");

  if (ctx.outcome === "error") {
    return;
  }

  const trailingMarker = detectTrailingPromiseMarker(ctx.responseContent);
  if (trailingMarker?.kind === "blocked") {
    buildCtx.emitLog("warn", "BLOCKED marker detected - stopping without completion");
    ctx.outcome = "blocked";
    return;
  }

  const isInPlanMode = buildCtx.state.status === "planning" && buildCtx.state.planMode?.active;
  const planReadyPattern = /<promise>PLAN_READY<\/promise>/;

  if (isInPlanMode && planReadyPattern.test(ctx.responseContent)) {
    buildCtx.emitLog("info", "PLAN_READY marker detected - plan is ready for review");
    ctx.outcome = "plan_ready";
    if (buildCtx.state.planMode) {
      buildCtx.state.planMode.isPlanReady = true;
      log.debug(`[TaskEngine] runIteration: Set isPlanReady = true, planMode:`, JSON.stringify(buildCtx.state.planMode));
    }
  } else if (buildCtx.stopDetector.matches(ctx.responseContent)) {
    buildCtx.emitLog("info", "Stop pattern matched - task is complete");
    ctx.outcome = "complete";
  } else {
    buildCtx.emitLog("info", "Stop pattern not matched - will continue to next iteration");
  }
}
