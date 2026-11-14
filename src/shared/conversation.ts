import type { HarnessConversationBinding } from "./harness-control";
import type { MessageAttachment } from "./message-attachments";
import type { QuestionMessageData } from "./harness-questions";
import type { ToolCallRecord } from "./tool-call";

export interface ConversationLogEntry {
  id: string;
  level: "agent" | "user" | "info" | "warn" | "error" | "debug" | "trace";
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface PersistedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: MessageAttachment[];
  timestamp: string;
  question?: QuestionMessageData;
}

export interface PersistedToolCall extends ToolCallRecord {}

export interface SessionInfo {
  id: string;
  serverUrl?: string;
  /** Null denotes an unsupported or corrupt stored binding; it must never be resumed. */
  binding?: HarnessConversationBinding | null;
}

export const DEFAULT_ACTIVITY_TIMEOUT_SECONDS = 330;
