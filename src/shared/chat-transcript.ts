import type { ChatConfig, ChatState } from "./chat";
import type { PersistedMessage, TaskLogEntry } from "./task";
import type { ToolCallSummary } from "./tool-call";

export type ChatTranscriptEntryKind = "message" | "tool" | "log";

export interface ChatTranscriptCursor {
  kind: ChatTranscriptEntryKind;
  id: string;
  timestamp: string;
}

export interface ChatTranscriptStorageEntry extends ChatTranscriptCursor {
  sequence: number;
  payload: unknown;
}

export interface ChatTranscriptPage {
  messages: PersistedMessage[];
  logs: TaskLogEntry[];
  toolCalls: ToolCallSummary[];
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
