/**
 * Agent event processing helpers for LoopEngine.
 */

import type { LoopConfig, LoopState, PendingPlanQuestion } from "../../types/loop";
import type { LogLevel, LoopEvent, MessageData, ToolCallData } from "../../types/events";
import { createTimestamp } from "../../types/events";
import type { AgentEvent } from "../../backends/types";
import type { LoopBackend, IterationContext } from "./engine-types";

export interface ToolProcessingContext {
  loopId: string;
  config: LoopConfig;
  state: LoopState;
  backend: LoopBackend;
  sessionId: string | null;
  emitLog: (level: LogLevel, message: string, details?: Record<string, unknown>, id?: string, consoleLevel?: "trace" | "debug" | "info" | "warn" | "error") => string;
  emit: (event: LoopEvent) => void;
  updateState: (update: Partial<LoopState>) => void;
  persistMessage: (message: MessageData) => void;
  persistToolCall: (toolCall: ToolCallData) => void;
  triggerPersistence: () => Promise<void>;
  setPendingPlanQuestion: (question: PendingPlanQuestion | undefined) => void;
  waitForPendingPlanQuestionAnswer: (requestId: string) => Promise<void>;
  clearPendingPlanQuestion: () => Promise<void>;
}

export async function processLoopAgentEvent(event: AgentEvent, ctx: IterationContext, toolCtx: ToolProcessingContext): Promise<void> {
  switch (event.type) {
    case "message.start":
      ctx.currentMessageId = event.messageId;
      ctx.messageCount++;
      ctx.currentResponseLogId = null;
      ctx.currentResponseLogContent = "";
      ctx.currentReasoningLogId = null;
      ctx.currentReasoningLogContent = "";
      toolCtx.emitLog("agent", "AI started generating response", { logKind: "system" });
      break;

    case "message.delta":
      ctx.responseContent += event.content;
      handleStreamingDelta(event.content, ctx, "response", toolCtx);
      toolCtx.emit({
        type: "loop.progress",
        loopId: toolCtx.loopId,
        iteration: ctx.iteration,
        content: event.content,
        timestamp: createTimestamp(),
      });
      break;

    case "reasoning.delta":
      ctx.reasoningContent += event.content;
      handleStreamingDelta(event.content, ctx, "reasoning", toolCtx);
      break;

    case "message.complete":
      handleMessageComplete(ctx, toolCtx);
      break;

    case "tool.start":
      handleToolStart(event, ctx, toolCtx);
      break;

    case "tool.complete":
      await handleToolComplete(event, ctx, toolCtx);
      break;

    case "error":
      ctx.outcome = "error";
      ctx.error = event.message;
      toolCtx.emitLog("error", `AI backend error: ${event.message}`);
      break;

    case "permission.asked":
      await handlePermissionAsked(event, toolCtx);
      break;

    case "question.asked":
      await handleQuestionAsked(event, toolCtx);
      break;

    case "session.status":
      toolCtx.emitLog("debug", `Session status: ${event.status}`, {
        sessionId: event.sessionId,
        attempt: event.attempt,
        message: event.message,
      });
      break;
  }
}

function handleStreamingDelta(
  content: string,
  ctx: IterationContext,
  kind: "response" | "reasoning",
  toolCtx: ToolProcessingContext,
): void {
  if (!content) return;

  if (kind === "response") {
    ctx.currentResponseLogContent += content;
    const logMsg = "AI generating response...";
    if (ctx.currentResponseLogId) {
      toolCtx.emitLog("agent", logMsg, { logKind: "response", responseContent: ctx.currentResponseLogContent }, ctx.currentResponseLogId, "trace");
    } else {
      ctx.currentResponseLogId = toolCtx.emitLog("agent", logMsg, { logKind: "response", responseContent: ctx.currentResponseLogContent }, undefined, "trace");
    }
  } else {
    ctx.currentReasoningLogContent += content;
    const logMsg = "AI reasoning...";
    if (ctx.currentReasoningLogId) {
      toolCtx.emitLog("agent", logMsg, { logKind: "reasoning", responseContent: ctx.currentReasoningLogContent }, ctx.currentReasoningLogId, "trace");
    } else {
      ctx.currentReasoningLogId = toolCtx.emitLog("agent", logMsg, { logKind: "reasoning", responseContent: ctx.currentReasoningLogContent }, undefined, "trace");
    }
  }
}

function handleMessageComplete(ctx: IterationContext, toolCtx: ToolProcessingContext): void {
  ctx.currentResponseLogId = null;
  ctx.currentResponseLogContent = "";
  ctx.currentReasoningLogId = null;
  ctx.currentReasoningLogContent = "";
  toolCtx.emitLog("agent", "AI finished generating response", {
    logKind: "system",
    responseLength: ctx.responseContent.length,
  });
  const messageData: MessageData = {
    id: ctx.currentMessageId || `msg-${Date.now()}`,
    role: "assistant",
    content: ctx.responseContent,
    timestamp: createTimestamp(),
  };
  toolCtx.persistMessage(messageData);
  toolCtx.emit({
    type: "loop.message",
    loopId: toolCtx.loopId,
    iteration: ctx.iteration,
    message: messageData,
    timestamp: createTimestamp(),
  });
}

function handleToolStart(event: AgentEvent & { type: "tool.start" }, ctx: IterationContext, toolCtx: ToolProcessingContext): void {
  ctx.currentResponseLogId = null;
  ctx.currentResponseLogContent = "";
  ctx.currentReasoningLogId = null;
  ctx.currentReasoningLogContent = "";
  const toolId = `tool-${ctx.iteration}-${event.toolName}-${ctx.toolCallCount}`;
  ctx.toolCalls.set(event.toolName, { id: toolId, name: event.toolName, input: event.input });
  ctx.toolCallCount++;
  toolCtx.emitLog("agent", `AI calling tool: ${event.toolName}`, { logKind: "tool" });
  const timestamp = createTimestamp();
  const toolCallData: ToolCallData = {
    id: toolId,
    name: event.toolName,
    input: event.input,
    status: "running",
    timestamp,
  };
  toolCtx.persistToolCall(toolCallData);
  toolCtx.emit({
    type: "loop.tool_call",
    loopId: toolCtx.loopId,
    iteration: ctx.iteration,
    tool: toolCallData,
    timestamp,
  });
}

async function handleToolComplete(event: AgentEvent & { type: "tool.complete" }, ctx: IterationContext, toolCtx: ToolProcessingContext): Promise<void> {
  const toolInfo = ctx.toolCalls.get(event.toolName);
  const timestamp = createTimestamp();
  const toolCompleteData: ToolCallData = {
    id: toolInfo?.id ?? `tool-${ctx.iteration}-${event.toolName}`,
    name: event.toolName,
    input: toolInfo?.input,
    output: event.output,
    status: "completed",
    timestamp,
  };
  toolCtx.persistToolCall(toolCompleteData);
  toolCtx.emit({
    type: "loop.tool_call",
    loopId: toolCtx.loopId,
    iteration: ctx.iteration,
    tool: toolCompleteData,
    timestamp,
  });
  await toolCtx.triggerPersistence();
}

async function handlePermissionAsked(event: AgentEvent & { type: "permission.asked" }, toolCtx: ToolProcessingContext): Promise<void> {
  toolCtx.emitLog("info", `Auto-approving permission request: ${event.permission}`, {
    requestId: event.requestId,
    patterns: event.patterns,
  });
  try {
    await toolCtx.backend.replyToPermission(event.requestId, "always");
    toolCtx.emitLog("info", "Permission approved successfully");
  } catch (permErr) {
    toolCtx.emitLog("warn", `Failed to approve permission: ${String(permErr)}`);
  }
}

export async function handleQuestionAsked(event: AgentEvent & { type: "question.asked" }, toolCtx: ToolProcessingContext): Promise<void> {
  if (toolCtx.state.status === "planning" && toolCtx.config.planModeAutoReply === false) {
    const waitForAnswer = toolCtx.waitForPendingPlanQuestionAnswer(event.requestId);
    const pendingQuestion: PendingPlanQuestion = {
      requestId: event.requestId,
      sessionId: event.sessionId,
      questions: event.questions.map((question) => ({
        header: question.header,
        question: question.question,
        options: question.options.map((option) => ({
          label: option.label,
          description: option.description,
        })),
        multiple: question.multiple,
        custom: question.custom,
      })),
      askedAt: createTimestamp(),
    };

    toolCtx.setPendingPlanQuestion(pendingQuestion);
    toolCtx.emitLog("info", "Waiting for a user answer to a plan-mode question", {
      requestId: event.requestId,
      questionCount: event.questions.length,
    });
    await toolCtx.triggerPersistence();
    try {
      await waitForAnswer;
      toolCtx.emitLog("info", "Plan question answered successfully", {
        requestId: event.requestId,
      });
    } catch (error) {
      if (toolCtx.state.planMode?.pendingQuestion?.requestId === event.requestId) {
        await toolCtx.clearPendingPlanQuestion();
      }
      throw error;
    }
    return;
  }

  toolCtx.emitLog("info", "Auto-responding to question from AI", {
    requestId: event.requestId,
    questionCount: event.questions.length,
  });
  try {
    const answers = event.questions.map(() =>
      ["take the best course of action you recommend"]
    );
    await toolCtx.backend.replyToQuestion(event.requestId, answers);
    toolCtx.emitLog("info", "Question answered successfully");
  } catch (questionErr) {
    toolCtx.emitLog("warn", `Failed to answer question: ${String(questionErr)}`);
  }
}
