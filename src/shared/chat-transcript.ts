import type { ChatConfig, ChatState } from "./chat";
import type { PersistedMessage, TaskLogEntry } from "./task";
import {
  mergeToolCallDisplayData,
  type ToolCallDisplayData,
  type ToolCallRecord,
} from "./tool-call";

export type ChatTranscriptEntryKind = "message" | "tool" | "log";

export interface ChatTranscriptCursor {
  kind: ChatTranscriptEntryKind;
  id: string;
  timestamp: string;
  sequence: number;
}

export interface ChatTranscriptStorageEntry extends ChatTranscriptCursor {
  payload: unknown;
  /** Normalized tool metadata/input; output and extras are omitted from pages. */
  tool?: ToolCallRecord;
  toolHasOutput?: boolean;
}

export interface ChatTranscriptPage {
  messages: PersistedMessage[];
  logs: TaskLogEntry[];
  toolCalls: ToolCallDisplayData[];
  hasOlder: boolean;
  nextCursor?: string;
  revision: string;
  totalEntries: number;
}

export type ChatSnapshotState = Omit<ChatState, "messages" | "logs" | "toolCalls">;

export interface ChatSnapshot {
  config: ChatConfig;
  state: ChatSnapshotState;
  transcript: ChatTranscriptPage;
}

export function mergeTranscriptPages(
  current: ChatTranscriptPage | null | undefined,
  incoming: ChatTranscriptPage,
): ChatTranscriptPage {
  if (!current) {
    return incoming;
  }

  const nextCursor = current.nextCursor ?? incoming.nextCursor;
  return {
    messages: mergeTranscriptRecords(current.messages, incoming.messages),
    logs: mergeTranscriptRecords(current.logs, incoming.logs),
    toolCalls: mergeTranscriptToolCalls(current.toolCalls, incoming.toolCalls),
    hasOlder: current.hasOlder || incoming.hasOlder,
    ...(nextCursor ? { nextCursor } : {}),
    revision: incoming.revision,
    totalEntries: incoming.totalEntries,
  };
}

export function mergeTranscriptRecords<T extends { id: string; timestamp: string }>(
  current: T[],
  incoming: T[],
): T[] {
  const merged = new Map<string, T>();
  for (const item of incoming) {
    merged.set(item.id, item);
  }
  for (const item of current) {
    merged.set(item.id, item);
  }
  return Array.from(merged.values()).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export function mergeTranscriptToolCalls(
  current: ToolCallDisplayData[],
  incoming: ToolCallDisplayData[],
): ToolCallDisplayData[] {
  const merged = new Map<string, ToolCallDisplayData>();
  for (const toolCall of incoming) {
    merged.set(toolCall.id, toolCall);
  }
  for (const toolCall of current) {
    const existing = merged.get(toolCall.id);
    if (!existing) {
      merged.set(toolCall.id, toolCall);
      continue;
    }
    merged.set(toolCall.id, mergeToolCallDisplayData(toolCall, existing));
  }
  return Array.from(merged.values()).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export function shouldIncludeChatTranscriptLog(log: TaskLogEntry): boolean {
  const logKind = log.details?.["logKind"];
  if (
    logKind === "tool"
    || logKind === "response"
    || logKind === "system"
    || (!logKind && log.message.startsWith("AI calling tool:"))
    || (!logKind && (log.message === "AI generating response..." || log.message === "AI finished response"))
  ) {
    return false;
  }

  if (log.level !== "agent" && log.level !== "user") {
    return false;
  }

  return !(
    log.level === "agent"
    && !logKind
    && (log.message.startsWith("AI started") || log.message.startsWith("AI finished"))
  );
}
