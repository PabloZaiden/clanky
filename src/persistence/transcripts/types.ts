import type {
  ChatTranscriptStorageEntry,
  PersistedMessage,
  TaskLogEntry,
  ToolCallRecord,
  TranscriptEntryKind as SharedTranscriptEntryKind,
} from "@/shared";

export type TranscriptResource = "chat" | "task" | "agent_run";
export type TranscriptEntryKind = SharedTranscriptEntryKind;

export interface TranscriptEntriesPage {
  entries: ChatTranscriptStorageEntry[];
  totalResponses: number;
  loadedResponses: number;
  hasOlder: boolean;
  nextCursor?: string;
}

export interface TranscriptPageOptions {
  full?: boolean;
  before?: string;
}

export interface TranscriptStateLike {
  messages: PersistedMessage[];
  logs: TaskLogEntry[];
  toolCalls: ToolCallRecord[];
}

export interface TranscriptStateEntry {
  id: string;
  timestamp: string;
  kind: TranscriptEntryKind;
  order: number;
  payload: PersistedMessage | TaskLogEntry | ToolCallRecord;
}

export interface TranscriptMeta {
  revision: string;
  entryCount: number;
}

export interface TranscriptTableConfig {
  parentTable: "chats" | "tasks" | "agent_runs";
  entriesTable: string;
  metaTable: string;
  resourceColumn: string;
}

export interface TranscriptCursor {
  version: 1;
  resource: TranscriptResource;
  resourceId: string;
  userId: string;
  entryId: string;
  timestamp: string;
  sequence: number;
}

export interface TranscriptResponseRow {
  entry_id: string;
  timestamp: string;
  sequence: number;
}

export interface TranscriptRow {
  entry_id: string;
  kind: TranscriptEntryKind;
  timestamp: string;
  sequence: number;
  payload: string;
  updated_at: string;
  tool_name: string | null;
  tool_status: ToolCallRecord["status"] | null;
  tool_input: string | null;
  tool_output: string | null;
  tool_extras: string | null;
  tool_has_output?: number | null;
}
