/**
 * Prompt building helpers for TaskEngine.
 */

import { log } from "@pablozaiden/webapp/server";
import type { TaskConfig, TaskState, ModelConfig } from "@/shared/task";
import type { MessageAttachment } from "@/shared/message-attachments";
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
  emitUserMessage: (content: string, idSuffix?: string, attachments?: MessageAttachment[]) => void;
  emitLog: (level: LogLevel, message: string, details?: Record<string, unknown>) => string;
  updateState: (update: Partial<TaskState>) => void;
  consumeInitialPromptAttachments: () => MessageAttachment[];
  consumePendingPromptAttachments: () => MessageAttachment[];
  consumeSessionRecovery: () => boolean;
}

export interface SessionRecoveryContext {
  originalGoal: string;
  workingDirectory: string;
  workingBranch?: string;
}

export function addSessionRecoveryBootstrap(
  prompt: PromptInput,
  context: SessionRecoveryContext,
): PromptInput {
  const recoveryText = `This task is continuing in a new AI session because the previous session was unavailable.

- Original Goal: ${context.originalGoal}
- Working Directory: ${context.workingDirectory}
- Working Branch: ${context.workingBranch ?? "the current task branch"}
- Read the documents in the \`./.clanky-planning\` folder before making changes.

`;
  const firstTextIndex = prompt.parts.findIndex((part) => part.type === "text");
  if (firstTextIndex === -1) {
    return {
      ...prompt,
      parts: [{ type: "text", text: recoveryText }, ...prompt.parts],
    };
  }

  const firstTextPart = prompt.parts[firstTextIndex];
  if (firstTextPart?.type !== "text") {
    return prompt;
  }

  const parts = [...prompt.parts];
  parts[firstTextIndex] = {
    ...firstTextPart,
    text: recoveryText + firstTextPart.text,
  };
  return { ...prompt, parts };
}

const BLOCKED_OUTCOME_INSTRUCTION = `- If you are blocked by an external dependency, missing prerequisite, or issue you cannot safely work around, explain the blocker and end your response with:

<promise>BLOCKED</promise>

Do not claim completion. Clanky will stop the task without pushing it, and the user can resume it with a follow-up message.`;

function consumePendingOrInitialAttachments(ctx: PromptBuildContext): MessageAttachment[] {
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
  const sessionWasRecreated = ctx.consumeSessionRecovery();
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
    return buildPlanModePrompt(ctx, model, sessionWasRecreated);
  }

  if (ctx.state.pendingPromptMode === "direct_user") {
    return buildDirectUserPrompt(ctx, model, sessionWasRecreated);
  }

  return buildExecutionPrompt(ctx, model);
}

function buildPlanModePrompt(
  ctx: PromptBuildContext,
  model: ModelConfig | undefined,
  sessionWasRecreated: boolean,
): PromptInput {
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

    const prompt: PromptInput = {
      parts: buildPromptParts(text, attachments),
      model,
    };
    return sessionWasRecreated
      ? addSessionRecoveryBootstrap(prompt, getSessionRecoveryContext(ctx))
      : prompt;
  }

  const feedback = ctx.state.pendingPrompt ?? "Please refine the plan based on feedback.";
  const attachments = consumePendingOrInitialAttachments(ctx);

  if (ctx.state.pendingPrompt) {
    ctx.emitUserMessage(ctx.state.pendingPrompt, `plan-feedback-${feedbackRounds}`, attachments);
  }

  const text = `The user has provided feedback on your plan:

---
${feedback}
---

When the plan is ready, end your response with:

<promise>PLAN_READY</promise>`;

  ctx.updateState({ pendingPrompt: undefined, pendingPromptMode: undefined });

  const prompt: PromptInput = {
    parts: buildPromptParts(text, attachments),
    model,
  };
  return sessionWasRecreated
    ? addSessionRecoveryBootstrap(prompt, getSessionRecoveryContext(ctx))
    : prompt;
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
    ? `\n- Additional user input:\n${userMessage}\n`
    : "";

  const errorContext = buildErrorContext(ctx.state.consecutiveErrors);

  const text = `- Original Goal: ${ctx.config.prompt}
${userMessageSection}${errorContext}
- Execute the accepted plan in \`./.clanky-planning/plan.md\`.

- Never ask for input from the user or any questions. This will always run unattended

${BLOCKED_OUTCOME_INSTRUCTION}

- Update \`./.clanky-planning/status.md\` as you complete each task.

- Before your final response, update \`./.clanky-planning/status.md\` with:
  - The task you are currently working on and its current state
  - Updated status of all tasks in the plan
  - Any new learnings, discoveries, or important context gathered during this iteration
  - What the next steps should be when work resumes
  Keep this final status accurate so work can continue from the recorded state.

- When all tasks in the plan are complete, end your response with:

<promise>COMPLETE</promise>`;

  return {
    parts: buildPromptParts(text, attachments),
    model,
  };
}

function buildDirectUserPrompt(
  ctx: PromptBuildContext,
  model: ModelConfig | undefined,
  sessionWasRecreated: boolean,
): PromptInput {
  const userMessage = ctx.state.pendingPrompt;
  if (!userMessage) {
    throw new Error("Direct user prompt requested without a pending message");
  }

  const attachments = consumePendingOrInitialAttachments(ctx);
  ctx.emitUserMessage(userMessage, `user-turn-${crypto.randomUUID()}`, attachments);
  ctx.emitLog("info", "User sent a direct message", {
    userMessage: userMessage.slice(0, 50) + (userMessage.length > 50 ? "..." : ""),
  });
  ctx.updateState({
    pendingPrompt: undefined,
    pendingPromptMode: undefined,
  });

  const prompt: PromptInput = {
    parts: buildPromptParts(userMessage, attachments),
    model,
  };
  return sessionWasRecreated
    ? addSessionRecoveryBootstrap(prompt, getSessionRecoveryContext(ctx))
    : prompt;
}

function getSessionRecoveryContext(ctx: PromptBuildContext): SessionRecoveryContext {
  return {
    originalGoal: ctx.config.prompt,
    workingDirectory: ctx.workingDirectory,
    workingBranch: ctx.state.git?.workingBranch,
  };
}

export function evaluateTaskOutcome(ctx: IterationContext, buildCtx: PromptBuildContext): void {
  buildCtx.emitLog("info", "Evaluating stop pattern...");

  if (ctx.outcome === "error") {
    return;
  }

  const responseContent = ctx.transcript.state.responseContent;
  const trailingMarker = detectTrailingPromiseMarker(responseContent);
  if (trailingMarker?.kind === "blocked") {
    buildCtx.emitLog("warn", "BLOCKED marker detected - stopping without completion");
    ctx.outcome = "blocked";
    return;
  }

  const isInPlanMode = buildCtx.state.status === "planning" && buildCtx.state.planMode?.active;
  const planReadyPattern = /<promise>PLAN_READY<\/promise>/i;

  if (isInPlanMode && (trailingMarker?.kind === "plan_ready" || planReadyPattern.test(responseContent))) {
    buildCtx.emitLog("info", "PLAN_READY marker detected - plan is ready for review");
    ctx.outcome = "plan_ready";
    if (buildCtx.state.planMode) {
      buildCtx.state.planMode.isPlanReady = true;
      log.debug(`[TaskEngine] runIteration: Set isPlanReady = true, planMode:`, JSON.stringify(buildCtx.state.planMode));
    }
  } else if (buildCtx.stopDetector.matches(responseContent)) {
    buildCtx.emitLog("info", "Stop pattern matched - task is complete");
    ctx.outcome = "complete";
  } else {
    buildCtx.emitLog("info", "Stop pattern not matched - will continue to next iteration");
  }
}
