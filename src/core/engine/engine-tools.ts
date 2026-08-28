/**
 * Task-specific materialization of shared agent transcript projections.
 */

import type { TaskConfig, TaskState } from "@/shared/task";
import type { LogLevel, TaskEvent, MessageData, ToolCallData } from "@/shared/events";
import type { AgentEvent } from "../../backends/types";
import type {
  AgentEventTranscriptBlock,
  AgentEventTranscriptResult,
  AgentEventTranscriptTextDelta,
} from "../agent-event-transcript-interpreter";
import type { TaskBackend, IterationContext } from "./engine-types";

export interface ToolProcessingContext {
  taskId: string;
  config: TaskConfig;
  state: TaskState;
  backend: TaskBackend;
  sessionId: string | null;
  emitLog: (
    level: LogLevel,
    message: string,
    details?: Record<string, unknown>,
    id?: string,
    consoleLevel?: "trace" | "debug" | "info" | "warn" | "error",
  ) => string;
  emitLogDelta: (
    level: LogLevel,
    message: string,
    delta: string,
    fullContent: string,
    logKind: "response" | "reasoning",
    id: string,
  ) => void;
  emit: (event: TaskEvent) => void;
  persistMessage: (message: MessageData) => void;
  persistToolCall: (toolCall: ToolCallData) => void;
  scheduleToolImagePreview: (toolCall: ToolCallData, iteration: number) => void;
}

export async function processTaskAgentEvent(
  event: AgentEvent,
  ctx: IterationContext,
  toolCtx: ToolProcessingContext,
  transcriptResult: AgentEventTranscriptResult = ctx.transcript.handle(event),
): Promise<void> {
  switch (event.type) {
    case "message.start":
      emitFlushedBlocks(transcriptResult.flushedBlocks, toolCtx);
      toolCtx.emitLog("agent", "AI started generating response", { logKind: "system" });
      break;

    case "message.delta":
      emitTextDelta(transcriptResult.responseDelta, toolCtx);
      if (transcriptResult.responseDelta) {
        toolCtx.emit({
          type: "task.progress",
          taskId: toolCtx.taskId,
          iteration: ctx.iteration,
          content: transcriptResult.responseDelta.delta,
          timestamp: transcriptResult.timestamp,
        });
      }
      break;

    case "reasoning.delta":
      emitTextDelta(transcriptResult.reasoningDelta, toolCtx);
      break;

    case "message.complete":
      emitFlushedBlocks(transcriptResult.flushedBlocks, toolCtx);
      handleMessageComplete(transcriptResult, ctx, toolCtx);
      break;

    case "tool.start":
      emitFlushedBlocks(transcriptResult.flushedBlocks, toolCtx);
      handleToolProjection(transcriptResult, ctx, toolCtx);
      break;

    case "tool.complete":
      emitFlushedBlocks(transcriptResult.flushedBlocks, toolCtx);
      handleToolProjection(transcriptResult, ctx, toolCtx);
      break;

    case "error":
      emitFlushedBlocks(transcriptResult.flushedBlocks, toolCtx);
      ctx.outcome = "error";
      ctx.error = event.message;
      ctx.errorCode = event.code;
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

    case "user.message":
      break;
  }
}

function emitTextDelta(
  delta: AgentEventTranscriptTextDelta | undefined,
  toolCtx: ToolProcessingContext,
): void {
  if (!delta) {
    return;
  }

  const logMessage = delta.kind === "response"
    ? "AI generating response..."
    : "AI reasoning...";
  if (delta.isFirstInBlock) {
    toolCtx.emitLog(
      "agent",
      logMessage,
      {
        logKind: delta.kind,
        responseContent: delta.logContent,
      },
      delta.logId,
      "trace",
    );
    return;
  }

  toolCtx.emitLogDelta(
    "agent",
    logMessage,
    delta.delta,
    delta.logContent,
    delta.kind,
    delta.logId,
  );
}

function emitFlushedBlocks(
  blocks: AgentEventTranscriptBlock[],
  toolCtx: ToolProcessingContext,
): void {
  for (const block of blocks) {
    if (block.logContent.length === 0) {
      continue;
    }
    toolCtx.emitLog(
      "agent",
      block.kind === "response" ? "AI generating response..." : "AI reasoning...",
      {
        logKind: block.kind,
        responseContent: block.logContent,
      },
      block.logId,
      "trace",
    );
  }
}

function handleMessageComplete(
  transcriptResult: AgentEventTranscriptResult,
  ctx: IterationContext,
  toolCtx: ToolProcessingContext,
): void {
  const completed = transcriptResult.completedMessage;
  if (!completed) {
    return;
  }

  toolCtx.emitLog("agent", "AI finished generating response", {
    logKind: "system",
    responseLength: completed.responseLength,
  });
  toolCtx.persistMessage(completed.message);
  toolCtx.emit({
    type: "task.message",
    taskId: toolCtx.taskId,
    iteration: ctx.iteration,
    message: completed.message,
    timestamp: transcriptResult.timestamp,
  });
}

function handleToolProjection(
  transcriptResult: AgentEventTranscriptResult,
  ctx: IterationContext,
  toolCtx: ToolProcessingContext,
): void {
  const projection = transcriptResult.tool;
  if (!projection) {
    return;
  }

  toolCtx.persistToolCall(projection.tool);
  toolCtx.emit({
    type: "task.tool_call",
    taskId: toolCtx.taskId,
    iteration: ctx.iteration,
    tool: projection.tool,
    timestamp: transcriptResult.timestamp,
  });
  if (projection.phase === "complete") {
    toolCtx.scheduleToolImagePreview(projection.tool, ctx.iteration);
  }
}

async function handlePermissionAsked(
  event: AgentEvent & { type: "permission.asked" },
  toolCtx: ToolProcessingContext,
): Promise<void> {
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

export async function handleQuestionAsked(
  event: AgentEvent & { type: "question.asked" },
  toolCtx: ToolProcessingContext,
): Promise<void> {
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
