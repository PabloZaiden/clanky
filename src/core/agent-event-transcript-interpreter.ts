/**
 * Shared projection of normalized ACP agent events into transcript updates.
 *
 * This module owns turn-local transcript mechanics only. Task and chat
 * consumers decide how the projections are persisted, published, and mapped
 * to their own lifecycle and interaction policies.
 */

import type { AgentEvent } from "../backends/types";
import type { MessageData, PersistedToolCall } from "@/shared";
import { createTimestamp } from "@/shared/events";
import { mergeToolCallRecord } from "@/shared/tool-call";
import {
  AgentStreamCheckpointPolicy,
  getAgentStreamTextByteLength,
} from "./agent-stream-controller";

export type AgentTranscriptBlockKind = "response" | "reasoning";

export interface AgentEventTranscriptState {
  responseContent: string;
  reasoningContent: string;
  messageCount: number;
  toolCallCount: number;
  currentMessageId: string | null;
  activeBlockKind: AgentTranscriptBlockKind | null;
  activeResponseContent: string;
  activeReasoningContent: string;
  currentResponseMessageId: string | null;
  currentResponseTimestamp: string | null;
  currentResponseLogId: string | null;
  currentResponseLogContent: string;
  currentReasoningLogId: string | null;
  currentReasoningLogContent: string;
  responseSegmentCount: number;
  totalResponseLength: number;
  toolCalls: Map<string, PersistedToolCall>;
  runningToolIdsByName: Map<string, string[]>;
}

export interface AgentEventTranscriptIdFactories {
  createResponseMessageId: (state: AgentEventTranscriptState) => string;
  createResponseLogId: (
    kind: AgentTranscriptBlockKind,
    state: AgentEventTranscriptState,
  ) => string;
  createToolCallId: (
    event: Extract<AgentEvent, { type: "tool.start" | "tool.complete" }>,
    state: AgentEventTranscriptState,
  ) => string;
}

export interface AgentEventTranscriptInterpreterOptions {
  initialToolCalls?: readonly PersistedToolCall[];
  state?: AgentEventTranscriptState;
  checkpointPolicy?: AgentStreamCheckpointPolicy;
  createTimestamp?: () => string;
  idFactories?: Partial<AgentEventTranscriptIdFactories>;
}

export interface AgentEventTranscriptBlock {
  kind: AgentTranscriptBlockKind;
  content: string;
  timestamp: string;
  messageId?: string;
  logId: string;
  logContent: string;
}

export interface AgentEventTranscriptTextDelta {
  kind: AgentTranscriptBlockKind;
  delta: string;
  content: string;
  timestamp: string;
  messageId?: string;
  logId: string;
  logContent: string;
  isFirstInBlock: boolean;
}

export interface AgentEventTranscriptCompletedMessage {
  message: MessageData;
  responseLength: number;
  hadResponseBlock: boolean;
}

export interface AgentEventTranscriptToolProjection {
  phase: "start" | "complete";
  tool: PersistedToolCall;
}

export interface AgentEventTranscriptResult {
  event: AgentEvent;
  timestamp: string;
  flushedBlocks: AgentEventTranscriptBlock[];
  responseDelta?: AgentEventTranscriptTextDelta;
  reasoningDelta?: AgentEventTranscriptTextDelta;
  completedMessage?: AgentEventTranscriptCompletedMessage;
  tool?: AgentEventTranscriptToolProjection;
  checkpointRequested: boolean;
}

const defaultIdFactories: AgentEventTranscriptIdFactories = {
  createResponseMessageId: (state) =>
    state.currentMessageId ?? `agent-assistant-${crypto.randomUUID()}`,
  createResponseLogId: (kind) => `agent-${kind}-${crypto.randomUUID()}`,
  createToolCallId: (event) =>
    event.toolCallId ?? `agent-tool-${crypto.randomUUID()}`,
};

export function createAgentEventTranscriptState(
  initialToolCalls: readonly PersistedToolCall[] = [],
): AgentEventTranscriptState {
  const toolCalls = new Map<string, PersistedToolCall>();
  const runningToolIdsByName = new Map<string, string[]>();
  for (const toolCall of initialToolCalls) {
    toolCalls.set(toolCall.id, toolCall);
    if (toolCall.status !== "running") {
      continue;
    }
    const runningToolIds = runningToolIdsByName.get(toolCall.name) ?? [];
    runningToolIds.push(toolCall.id);
    runningToolIdsByName.set(toolCall.name, runningToolIds);
  }

  return {
    responseContent: "",
    reasoningContent: "",
    messageCount: 0,
    toolCallCount: 0,
    currentMessageId: null,
    activeBlockKind: null,
    activeResponseContent: "",
    activeReasoningContent: "",
    currentResponseMessageId: null,
    currentResponseTimestamp: null,
    currentResponseLogId: null,
    currentResponseLogContent: "",
    currentReasoningLogId: null,
    currentReasoningLogContent: "",
    responseSegmentCount: 0,
    totalResponseLength: 0,
    toolCalls,
    runningToolIdsByName,
  };
}

export class AgentEventTranscriptInterpreter {
  readonly state: AgentEventTranscriptState;
  private readonly checkpointPolicy: AgentStreamCheckpointPolicy;
  private readonly timestamp: () => string;
  private readonly idFactories: AgentEventTranscriptIdFactories;

  constructor(options: AgentEventTranscriptInterpreterOptions = {}) {
    this.state = options.state
      ?? createAgentEventTranscriptState(options.initialToolCalls);
    this.checkpointPolicy = options.checkpointPolicy ?? new AgentStreamCheckpointPolicy();
    this.timestamp = options.createTimestamp ?? createTimestamp;
    this.idFactories = {
      ...defaultIdFactories,
      ...options.idFactories,
    };
  }

  handle(event: AgentEvent): AgentEventTranscriptResult {
    const timestamp = this.timestamp();
    switch (event.type) {
      case "message.start":
        return this.handleMessageStart(event, timestamp);
      case "message.delta":
        return this.handleTextDelta(event, timestamp, "response");
      case "reasoning.delta":
        return this.handleTextDelta(event, timestamp, "reasoning");
      case "message.complete":
        return this.handleMessageComplete(event, timestamp);
      case "tool.start":
        return this.handleToolStart(event, timestamp);
      case "tool.complete":
        return this.handleToolComplete(event, timestamp);
      case "error":
        return this.handleTerminalEvent(event, timestamp);
      default:
        return this.createResult(event, timestamp, true);
    }
  }

  acknowledgeCheckpoint(): void {
    this.checkpointPolicy.markCheckpoint();
  }

  getPendingCheckpointBytes(): number {
    return this.checkpointPolicy.getPendingTextBytes();
  }

  flushActiveBlocks(timestamp = this.timestamp()): AgentEventTranscriptBlock[] {
    return this.flushActiveBlock(timestamp);
  }

  cancelRunningTools(
    timestamp = this.timestamp(),
    output = "Cancelled by user.",
  ): PersistedToolCall[] {
    const cancelled: PersistedToolCall[] = [];
    for (const tool of this.state.toolCalls.values()) {
      if (tool.status !== "running") {
        continue;
      }
      const cancelledTool: PersistedToolCall = {
        ...tool,
        status: "failed",
        output: tool.output ?? output,
        timestamp,
      };
      this.state.toolCalls.set(tool.id, cancelledTool);
      this.removeRunningTool(tool);
      cancelled.push(cancelledTool);
    }
    return cancelled;
  }

  reset(): void {
    const nextState = createAgentEventTranscriptState();
    Object.assign(this.state, nextState);
  }

  private handleMessageStart(
    event: Extract<AgentEvent, { type: "message.start" }>,
    timestamp: string,
  ): AgentEventTranscriptResult {
    this.resetActiveTurn();
    this.state.currentMessageId = event.messageId;
    this.state.messageCount += 1;
    return this.createResult(event, timestamp, true);
  }

  private handleTextDelta(
    event: Extract<AgentEvent, { type: "message.delta" | "reasoning.delta" }>,
    timestamp: string,
    kind: AgentTranscriptBlockKind,
  ): AgentEventTranscriptResult {
    const flushedBlocks = this.startBlock(kind, timestamp);
    if (event.content.length === 0) {
      return {
        ...this.createResult(event, timestamp, flushedBlocks.length > 0),
        flushedBlocks,
      };
    }

    const isFirstInBlock = kind === "response"
      ? this.state.activeResponseContent.length === 0
      : this.state.activeReasoningContent.length === 0;

    if (kind === "response") {
      this.state.activeResponseContent += event.content;
      this.state.currentResponseLogContent = this.state.activeResponseContent;
      this.state.responseContent += event.content;
      this.state.totalResponseLength += event.content.length;
    } else {
      this.state.activeReasoningContent += event.content;
      this.state.currentReasoningLogContent = this.state.activeReasoningContent;
      this.state.reasoningContent += event.content;
    }

    const checkpointRequested =
      this.checkpointPolicy.recordText(getAgentStreamTextByteLength(event.content))
      || flushedBlocks.length > 0;
    const delta: AgentEventTranscriptTextDelta = {
      kind,
      delta: event.content,
      content: kind === "response"
        ? this.state.activeResponseContent
        : this.state.activeReasoningContent,
      timestamp,
      logId: kind === "response"
        ? this.state.currentResponseLogId!
        : this.state.currentReasoningLogId!,
      logContent: kind === "response"
        ? this.state.currentResponseLogContent
        : this.state.currentReasoningLogContent,
      isFirstInBlock,
      ...(kind === "response" && this.state.currentResponseMessageId
        ? { messageId: this.state.currentResponseMessageId }
        : {}),
    };

    return {
      ...this.createResult(event, timestamp, checkpointRequested),
      flushedBlocks,
      ...(kind === "response"
        ? { responseDelta: delta }
        : { reasoningDelta: delta }),
    };
  }

  private handleMessageComplete(
    event: Extract<AgentEvent, { type: "message.complete" }>,
    timestamp: string,
  ): AgentEventTranscriptResult {
    const responseContent = event.content.length > 0
      ? event.content
      : this.state.responseContent;
    const activeResponseMessageId = this.state.currentResponseMessageId;
    const activeResponseTimestamp = this.state.currentResponseTimestamp;
    const hadResponseBlock = this.state.responseSegmentCount > 0;
    const flushedBlocks: AgentEventTranscriptBlock[] = [];

    if (event.content.length > 0) {
      this.state.responseContent = event.content;
      this.state.totalResponseLength = event.content.length;
      if (this.state.activeBlockKind === "response") {
        this.state.activeResponseContent = event.content;
        this.state.currentResponseLogContent = event.content;
      }
    }

    flushedBlocks.push(...this.flushActiveBlock(timestamp));
    let messageId = activeResponseMessageId;
    let messageTimestamp = activeResponseTimestamp ?? timestamp;

    if (!hadResponseBlock && responseContent.length > 0) {
      this.startBlock("response", timestamp);
      this.state.activeResponseContent = responseContent;
      this.state.currentResponseLogContent = responseContent;
      messageId = this.state.currentResponseMessageId;
      messageTimestamp = this.state.currentResponseTimestamp ?? timestamp;
      flushedBlocks.push(...this.flushActiveBlock(timestamp));
    }

    const completedMessage: AgentEventTranscriptCompletedMessage = {
      message: {
        id: messageId ?? this.state.currentMessageId ?? this.idFactories.createResponseMessageId(this.state),
        role: "assistant",
        content: responseContent,
        timestamp: messageTimestamp,
      },
      responseLength: responseContent.length,
      hadResponseBlock,
    };

    this.resetActiveBlock();
    return {
      ...this.createResult(event, timestamp, true),
      flushedBlocks,
      completedMessage,
    };
  }

  private handleToolStart(
    event: Extract<AgentEvent, { type: "tool.start" }>,
    timestamp: string,
  ): AgentEventTranscriptResult {
    const flushedBlocks = this.flushActiveBlock(timestamp);
    const toolId = event.toolCallId
      ?? this.idFactories.createToolCallId(event, this.state);
    const tool: PersistedToolCall = {
      id: toolId,
      name: event.toolName,
      input: event.input,
      status: "running",
      timestamp,
    };
    const existing = this.state.toolCalls.get(toolId);
    const persistedTool = existing ? mergeToolCallRecord(existing, tool) : tool;
    this.state.toolCalls.set(toolId, persistedTool);
    this.addRunningTool(persistedTool);
    this.state.toolCallCount += 1;

    return {
      ...this.createResult(event, timestamp, true),
      flushedBlocks,
      tool: {
        phase: "start",
        tool: persistedTool,
      },
    };
  }

  private handleToolComplete(
    event: Extract<AgentEvent, { type: "tool.complete" }>,
    timestamp: string,
  ): AgentEventTranscriptResult {
    const flushedBlocks = this.flushActiveBlock(timestamp);
    const existing = event.toolCallId
      ? this.state.toolCalls.get(event.toolCallId)
      : this.getLatestRunningTool(event.toolName);
    const toolId = event.toolCallId
      ?? existing?.id
      ?? this.idFactories.createToolCallId(event, this.state);
    const completedTool: PersistedToolCall = {
      id: toolId,
      name: event.toolName,
      input: event.input ?? existing?.input,
      output: event.output,
      status: "completed",
      timestamp,
    };
    const persistedTool = existing
      ? mergeToolCallRecord(existing, completedTool)
      : completedTool;
    this.state.toolCalls.set(toolId, persistedTool);
    this.removeRunningTool(existing);

    return {
      ...this.createResult(event, timestamp, true),
      flushedBlocks,
      tool: {
        phase: "complete",
        tool: persistedTool,
      },
    };
  }

  private handleTerminalEvent(
    event: Extract<AgentEvent, { type: "error" }>,
    timestamp: string,
  ): AgentEventTranscriptResult {
    return {
      ...this.createResult(event, timestamp, true),
      flushedBlocks: this.flushActiveBlock(timestamp),
    };
  }

  private startBlock(
    kind: AgentTranscriptBlockKind,
    timestamp: string,
  ): AgentEventTranscriptBlock[] {
    if (this.state.activeBlockKind === kind) {
      return [];
    }

    const flushedBlocks = this.flushActiveBlock(timestamp);
    this.state.activeBlockKind = kind;
    if (kind === "response") {
      this.state.responseSegmentCount += 1;
      this.state.currentResponseMessageId =
        this.idFactories.createResponseMessageId(this.state);
      this.state.currentResponseTimestamp = timestamp;
      this.state.currentResponseLogId =
        this.idFactories.createResponseLogId(kind, this.state);
      this.state.currentResponseLogContent = "";
      this.state.activeResponseContent = "";
    } else {
      this.state.currentReasoningLogId =
        this.idFactories.createResponseLogId(kind, this.state);
      this.state.currentReasoningLogContent = "";
      this.state.activeReasoningContent = "";
    }
    return flushedBlocks;
  }

  private flushActiveBlock(timestamp: string): AgentEventTranscriptBlock[] {
    if (this.state.activeBlockKind === "response") {
      const content = this.state.activeResponseContent;
      const logContent = this.state.currentResponseLogContent;
      const block = {
        kind: "response" as const,
        content,
        timestamp: this.state.currentResponseTimestamp ?? timestamp,
        messageId: this.state.currentResponseMessageId ?? undefined,
        logId: this.state.currentResponseLogId!,
        logContent,
      };
      this.resetActiveBlock();
      return content.length > 0 || logContent.length > 0 ? [block] : [];
    }

    if (this.state.activeBlockKind === "reasoning") {
      const content = this.state.activeReasoningContent;
      const logContent = this.state.currentReasoningLogContent;
      const block = {
        kind: "reasoning" as const,
        content,
        timestamp,
        logId: this.state.currentReasoningLogId!,
        logContent,
      };
      this.resetActiveBlock();
      return content.length > 0 || logContent.length > 0 ? [block] : [];
    }

    return [];
  }

  private createResult(
    event: AgentEvent,
    timestamp: string,
    checkpointRequested: boolean,
  ): AgentEventTranscriptResult {
    return {
      event,
      timestamp,
      flushedBlocks: [],
      checkpointRequested,
    };
  }

  private resetActiveTurn(): void {
    this.state.responseContent = "";
    this.state.reasoningContent = "";
    this.state.responseSegmentCount = 0;
    this.state.totalResponseLength = 0;
    this.resetActiveBlock();
  }

  private resetActiveBlock(): void {
    this.state.activeBlockKind = null;
    this.state.activeResponseContent = "";
    this.state.activeReasoningContent = "";
    this.state.currentResponseMessageId = null;
    this.state.currentResponseTimestamp = null;
    this.state.currentResponseLogId = null;
    this.state.currentResponseLogContent = "";
    this.state.currentReasoningLogId = null;
    this.state.currentReasoningLogContent = "";
  }

  private addRunningTool(tool: PersistedToolCall): void {
    if (tool.status !== "running") {
      return;
    }
    const runningToolIds = this.state.runningToolIdsByName.get(tool.name) ?? [];
    if (!runningToolIds.includes(tool.id)) {
      runningToolIds.push(tool.id);
    }
    this.state.runningToolIdsByName.set(tool.name, runningToolIds);
  }

  private removeRunningTool(tool: PersistedToolCall | undefined): void {
    if (!tool || tool.status !== "running") {
      return;
    }
    const runningToolIds = this.state.runningToolIdsByName.get(tool.name);
    if (!runningToolIds) {
      return;
    }
    const index = runningToolIds.lastIndexOf(tool.id);
    if (index >= 0) {
      runningToolIds.splice(index, 1);
    }
    if (runningToolIds.length === 0) {
      this.state.runningToolIdsByName.delete(tool.name);
    }
  }

  private getLatestRunningTool(name: string): PersistedToolCall | undefined {
    const runningToolIds = this.state.runningToolIdsByName.get(name);
    if (!runningToolIds) {
      return undefined;
    }
    while (runningToolIds.length > 0) {
      const toolId = runningToolIds[runningToolIds.length - 1]!;
      const tool = this.state.toolCalls.get(toolId);
      if (tool?.status === "running") {
        return tool;
      }
      runningToolIds.pop();
    }
    if (runningToolIds.length === 0) {
      this.state.runningToolIdsByName.delete(name);
    }
    return undefined;
  }
}
