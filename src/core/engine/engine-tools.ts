/**
 * Agent event processing helpers for TaskEngine.
 */

import type { TaskConfig, TaskState } from "../../types/task";
import type { LogLevel, TaskEvent, MessageData, ToolCallData } from "../../types/events";
import { createTimestamp } from "../../types/events";
import type { AgentEvent } from "../../backends/types";
import type { TaskBackend, IterationContext } from "./engine-types";

export interface ToolProcessingContext {
  taskId: string;
  config: TaskConfig;
  state: TaskState;
  backend: TaskBackend;
  sessionId: string | null;
  emitLog: (level: LogLevel, message: string, details?: Record<string, unknown>, id?: string, consoleLevel?: "trace" | "debug" | "info" | "warn" | "error") => string;
  emitLogDelta: (level: LogLevel, message: string, delta: string, fullContent: string, logKind: "response" | "reasoning", id: string) => void;
  emit: (event: TaskEvent) => void;
  updateState: (update: Partial<TaskState>) => void;
  persistMessage: (message: MessageData) => void;
  persistToolCall: (toolCall: ToolCallData) => void;
  triggerPersistence: () => Promise<void>;
  scheduleToolImagePreview: (toolCall: ToolCallData, iteration: number) => void;
}

export async function processTaskAgentEvent(event: AgentEvent, ctx: IterationContext, toolCtx: ToolProcessingContext): Promise<void> {
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
        type: "task.progress",
        taskId: toolCtx.taskId,
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
      handleMessageComplete(event, ctx, toolCtx);
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
      toolCtx.emitLogDelta("agent", logMsg, content, ctx.currentResponseLogContent, "response", ctx.currentResponseLogId);
    } else {
      ctx.currentResponseLogId = toolCtx.emitLog("agent", logMsg, { logKind: "response", responseContent: ctx.currentResponseLogContent }, undefined, "trace");
    }
  } else {
    ctx.currentReasoningLogContent += content;
    const logMsg = "AI reasoning...";
    if (ctx.currentReasoningLogId) {
      toolCtx.emitLogDelta("agent", logMsg, content, ctx.currentReasoningLogContent, "reasoning", ctx.currentReasoningLogId);
    } else {
      ctx.currentReasoningLogId = toolCtx.emitLog("agent", logMsg, { logKind: "reasoning", responseContent: ctx.currentReasoningLogContent }, undefined, "trace");
    }
  }
}

function handleMessageComplete(
  event: AgentEvent & { type: "message.complete" },
  ctx: IterationContext,
  toolCtx: ToolProcessingContext,
): void {
  const finalResponseContent = event.content.length > 0 ? event.content : ctx.responseContent;
  ctx.responseContent = finalResponseContent;
  if (ctx.currentResponseLogId && ctx.currentResponseLogContent !== finalResponseContent) {
    toolCtx.emitLog(
      "agent",
      "AI generating response...",
      { logKind: "response", responseContent: finalResponseContent },
      ctx.currentResponseLogId,
      "trace",
    );
  }
  ctx.currentResponseLogId = null;
  ctx.currentResponseLogContent = "";
  ctx.currentReasoningLogId = null;
  ctx.currentReasoningLogContent = "";
  toolCtx.emitLog("agent", "AI finished generating response", {
    logKind: "system",
    responseLength: finalResponseContent.length,
  });
  const messageData: MessageData = {
    id: ctx.currentMessageId || `msg-${Date.now()}`,
    role: "assistant",
    content: finalResponseContent,
    timestamp: createTimestamp(),
  };
  toolCtx.persistMessage(messageData);
  toolCtx.emit({
    type: "task.message",
    taskId: toolCtx.taskId,
    iteration: ctx.iteration,
    message: messageData,
    timestamp: createTimestamp(),
  });
}

function handleToolStart(event: AgentEvent & { type: "tool.start" }, ctx: IterationContext, toolCtx: ToolProcessingContext): void {
  ctx.responseContent = "";
  ctx.currentResponseLogId = null;
  ctx.currentResponseLogContent = "";
  ctx.currentReasoningLogId = null;
  ctx.currentReasoningLogContent = "";
  const toolId = event.toolCallId ?? `tool-${ctx.iteration}-${event.toolName}-${ctx.toolCallCount}`;
  const toolKey = event.toolCallId ?? event.toolName;
  ctx.toolCalls.set(toolKey, { id: toolId, name: event.toolName, input: event.input });
  ctx.toolCallCount++;
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
    type: "task.tool_call",
    taskId: toolCtx.taskId,
    iteration: ctx.iteration,
    tool: toolCallData,
    timestamp,
  });
}

async function handleToolComplete(event: AgentEvent & { type: "tool.complete" }, ctx: IterationContext, toolCtx: ToolProcessingContext): Promise<void> {
  const toolKey = event.toolCallId ?? event.toolName;
  const toolInfo = ctx.toolCalls.get(toolKey);
  const completedInput = event.input ?? toolInfo?.input;
  if (toolInfo) {
    ctx.toolCalls.set(toolKey, { ...toolInfo, input: completedInput });
  }
  const timestamp = createTimestamp();
  const toolCompleteData: ToolCallData = {
    id: event.toolCallId ?? toolInfo?.id ?? `tool-${ctx.iteration}-${event.toolName}`,
    name: event.toolName,
    input: completedInput,
    output: event.output,
    status: "completed",
    timestamp,
  };
  toolCtx.persistToolCall(toolCompleteData);
  toolCtx.emit({
    type: "task.tool_call",
    taskId: toolCtx.taskId,
    iteration: ctx.iteration,
    tool: toolCompleteData,
    timestamp,
  });
  toolCtx.scheduleToolImagePreview(toolCompleteData, ctx.iteration);
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
