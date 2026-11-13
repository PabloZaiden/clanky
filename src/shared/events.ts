import type { Automation, AutomationRun, AutomationRunStatus } from "./automation";
import type { ChatMetadata, ChatConfig, ChatStatus } from "./chat";
import type { ConversationLogEntry, PersistedMessage } from "./conversation";
import type { ToolCallRecord } from "./tool-call";
import type { StreamDeltaPosition } from "./stream-position";

/**
 * Message data from the AI agent.
 * 
 * Represents a single message in the conversation between the user prompt
 * and the AI assistant. Messages are streamed during iteration execution.
 * 
 * @example
 * ```typescript
 * const message: MessageData = {
 *   id: "msg_123",
 *   role: "assistant",
 *   content: "I'll start by reading the package.json file...",
 *   timestamp: "2025-01-27T10:30:00.000Z"
 * };
 * ```
 */
export interface MessageData extends PersistedMessage {}

export interface MessageDeltaData {
  messageId: string;
  role: MessageData["role"];
  delta: string;
  baseLength: number;
  contentLength: number;
  messageTimestamp: string;
  timestamp: string;
}

/**
 * Tool call data from the AI agent.
 * 
 * Represents a tool invocation by the AI during iteration execution.
 * Tool calls go through states: pending -> running -> completed/failed.
 * The same tool call ID is emitted multiple times as its status changes.
 * Persisted backend `name` values may be coarse categories, so UI rendering
 * should prefer inferring the concrete tool kind from the raw `input` shape.
 * 
 * @example
 * ```typescript
 * const toolCall: ToolCallData = {
 *   id: "tool_456",
 *   name: "Write",
 *   input: { filePath: "/src/index.ts", content: "..." },
 *   status: "completed",
 *   output: { success: true },
 *   timestamp: "2025-01-27T10:30:05.000Z"
 * };
 * ```
 */
export interface ToolCallData extends ToolCallRecord {}

/**
 * Union type of all chat-scoped events streamed to clients.
 */
export type ChatEvent = (
  | ChatCreatedEvent
  | ChatUpdatedEvent
  | ChatStatusEvent
  | ChatMessageEvent
  | ChatMessageDeltaEvent
  | ChatToolCallEvent
  | ChatLogEvent
  | ChatLogDeltaEvent
  | ChatInterruptedEvent
  | ChatErrorEvent
  | ChatDeletedEvent
  | { type: "chat.trash.changed"; chatId: string; workspaceId?: string; timestamp: string }
) & { streamPosition?: StreamDeltaPosition };

/**
 * Union type of all automation-scoped events streamed to clients.
 */
export type AutomationEvent = (
  | AutomationCreatedEvent
  | AutomationUpdatedEvent
  | AutomationDeletedEvent
  | AutomationRunScheduledEvent
  | AutomationRunStartedEvent
  | AutomationRunStatusEvent
  | AutomationRunMessageEvent
  | AutomationRunMessageDeltaEvent
  | AutomationRunToolCallEvent
  | AutomationRunLogEvent
  | AutomationRunLogDeltaEvent
  | AutomationRunSkippedEvent
  | AutomationRunCompletedEvent
  | AutomationRunFailedEvent
  | AutomationRunInterruptedEvent
  | AutomationRunDeletedEvent
  | AutomationRunsPurgedEvent
) & { streamPosition?: StreamDeltaPosition };

export interface ChatCreatedEvent {
  type: "chat.created";
  chatId: string;
  config: ChatConfig;
  timestamp: string;
}

export interface ChatUpdatedEvent {
  type: "chat.updated";
  chatId: string;
  chat: ChatMetadata;
  timestamp: string;
}

export interface ChatStatusEvent {
  type: "chat.status";
  chatId: string;
  scope: ChatConfig["scope"];
  status: ChatStatus;
  revision: number;
  timestamp: string;
}

export interface ChatMessageEvent {
  type: "chat.message";
  chatId: string;
  scope: ChatConfig["scope"];
  message: MessageData;
  timestamp: string;
}

export interface ChatMessageDeltaEvent extends MessageDeltaData {
  type: "chat.message.delta";
  chatId: string;
  scope: ChatConfig["scope"];
}

export interface ChatToolCallEvent {
  type: "chat.tool_call";
  chatId: string;
  scope: ChatConfig["scope"];
  tool: ToolCallData;
  timestamp: string;
}

export interface ChatLogEvent {
  type: "chat.log";
  chatId: string;
  scope: ChatConfig["scope"];
  log: ConversationLogEntry;
  timestamp: string;
}

export interface ChatLogDeltaEvent {
  type: "chat.log.delta";
  chatId: string;
  scope: ChatConfig["scope"];
  logId: string;
  level: ConversationLogEntry["level"];
  message: string;
  logKind: string;
  delta: string;
  baseLength: number;
  contentLength: number;
  logTimestamp: string;
  timestamp: string;
}

export interface ChatInterruptedEvent {
  type: "chat.interrupted";
  chatId: string;
  scope: ChatConfig["scope"];
  timestamp: string;
}

export interface ChatErrorEvent {
  type: "chat.error";
  chatId: string;
  scope: ChatConfig["scope"];
  message: string;
  code?: string;
  timestamp: string;
}

export interface ChatDeletedEvent {
  type: "chat.deleted";
  chatId: string;
  workspaceId?: string;
  scope: ChatConfig["scope"];
  timestamp: string;
}

export interface AutomationCreatedEvent {
  type: "automation.created";
  automationId: string;
  automation: Automation;
  timestamp: string;
}

export interface AutomationUpdatedEvent {
  type: "automation.updated";
  automationId: string;
  automation: Automation;
  timestamp: string;
}

export interface AutomationDeletedEvent {
  type: "automation.deleted";
  automationId: string;
  workspaceId: string;
  timestamp: string;
}

export interface AutomationRunScheduledEvent {
  type: "automation.run.scheduled";
  automationId: string;
  automationRunId: string;
  run: AutomationRun;
  timestamp: string;
}

export interface AutomationRunStartedEvent {
  type: "automation.run.started";
  automationId: string;
  automationRunId: string;
  run: AutomationRun;
  timestamp: string;
}

export interface AutomationRunStatusEvent {
  type: "automation.run.status";
  automationId: string;
  automationRunId: string;
  status: AutomationRunStatus;
  timestamp: string;
}

export interface AutomationRunMessageEvent {
  type: "automation.run.message";
  automationId: string;
  automationRunId: string;
  message: MessageData;
  timestamp: string;
}

export interface AutomationRunMessageDeltaEvent extends MessageDeltaData {
  type: "automation.run.message.delta";
  automationId: string;
  automationRunId: string;
}

export interface AutomationRunToolCallEvent {
  type: "automation.run.tool_call";
  automationId: string;
  automationRunId: string;
  tool: ToolCallData;
  timestamp: string;
}

export interface AutomationRunLogEvent {
  type: "automation.run.log";
  automationId: string;
  automationRunId: string;
  log: ConversationLogEntry;
  timestamp: string;
}

export interface AutomationRunLogDeltaEvent {
  type: "automation.run.log.delta";
  automationId: string;
  automationRunId: string;
  logId: string;
  level: ConversationLogEntry["level"];
  message: string;
  logKind: string;
  delta: string;
  baseLength: number;
  contentLength: number;
  logTimestamp: string;
  timestamp: string;
}

export interface AutomationRunSkippedEvent {
  type: "automation.run.skipped";
  automationId: string;
  automationRunId: string;
  reason: string;
  timestamp: string;
}

export interface AutomationRunCompletedEvent {
  type: "automation.run.completed";
  automationId: string;
  automationRunId: string;
  run: AutomationRun;
  timestamp: string;
}

export interface AutomationRunFailedEvent {
  type: "automation.run.failed";
  automationId: string;
  automationRunId: string;
  message: string;
  timestamp: string;
}

export interface AutomationRunInterruptedEvent {
  type: "automation.run.interrupted";
  automationId: string;
  automationRunId: string;
  timestamp: string;
}

export interface AutomationRunDeletedEvent {
  type: "automation.run.deleted";
  automationId: string;
  automationRunId: string;
  timestamp: string;
}

export interface AutomationRunsPurgedEvent {
  type: "automation.runs.purged";
  automationId: string;
  deletedRunIds: string[];
  timestamp: string;
}

export type LogLevel = ConversationLogEntry["level"];

export function createTimestamp(): string {
  return new Date().toISOString();
}
