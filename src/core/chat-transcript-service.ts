import { createToolCallSummary, shouldIncludeChatTranscriptLog } from "@/shared";
import type {
  Chat,
  ChatSnapshot,
  ChatTranscriptCursor,
  ChatTranscriptEntryKind,
  ChatTranscriptPage,
  ChatTranscriptStorageEntry,
  PersistedMessage,
  TaskLogEntry,
  ToolCallRecord,
} from "@/shared";

const DEFAULT_TRANSCRIPT_PAGE_SIZE = 100;
const MAX_TRANSCRIPT_PAGE_SIZE = 200;
const CURSOR_VERSION = 1;

type TranscriptEntry =
  | {
      kind: "message";
      id: string;
      timestamp: string;
      message: PersistedMessage;
    }
  | {
      kind: "tool";
      id: string;
      timestamp: string;
      tool: ToolCallRecord;
    }
  | {
      kind: "log";
      id: string;
      timestamp: string;
      log: TaskLogEntry;
    };

export class InvalidChatTranscriptCursorError extends Error {
  readonly code = "invalid_transcript_cursor";
  readonly status = 400;

  constructor() {
    super("The transcript cursor is invalid or expired");
    this.name = "InvalidChatTranscriptCursorError";
  }
}

export function normalizeTranscriptPageSize(value: string | null): number {
  if (value === null || value.trim().length === 0) {
    return DEFAULT_TRANSCRIPT_PAGE_SIZE;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TRANSCRIPT_PAGE_SIZE) {
    throw new Error(`Transcript limit must be an integer between 1 and ${MAX_TRANSCRIPT_PAGE_SIZE}`);
  }
  return parsed;
}

function compareTranscriptEntries(left: TranscriptEntry, right: TranscriptEntry): number {
  const byTimestamp = left.timestamp.localeCompare(right.timestamp);
  if (byTimestamp !== 0) {
    return byTimestamp;
  }

  const byKind = left.kind.localeCompare(right.kind);
  return byKind !== 0 ? byKind : left.id.localeCompare(right.id);
}

function getTranscriptEntryKey(entry: Pick<TranscriptEntry, "kind" | "id">): string {
  return `${entry.kind}:${entry.id}`;
}

function encodeCursor(entry: Pick<TranscriptEntry, "kind" | "id" | "timestamp">): string {
  const cursor: ChatTranscriptCursor & { version: number } = {
    version: CURSOR_VERSION,
    kind: entry.kind,
    id: entry.id,
    timestamp: entry.timestamp,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): ChatTranscriptCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ChatTranscriptCursor> & {
      version?: number;
    };
    if (
      parsed.version !== CURSOR_VERSION
      || (parsed.kind !== "message" && parsed.kind !== "tool" && parsed.kind !== "log")
      || typeof parsed.id !== "string"
      || parsed.id.length === 0
      || typeof parsed.timestamp !== "string"
      || parsed.timestamp.length === 0
    ) {
      throw new Error("Invalid cursor shape");
    }

    return {
      kind: parsed.kind,
      id: parsed.id,
      timestamp: parsed.timestamp,
    };
  } catch {
    throw new InvalidChatTranscriptCursorError();
  }
}

export function parseChatTranscriptCursor(value: string): ChatTranscriptCursor {
  return decodeCursor(value);
}

function compareEntryToCursor(entry: TranscriptEntry, cursor: ChatTranscriptCursor): number {
  const byTimestamp = entry.timestamp.localeCompare(cursor.timestamp);
  if (byTimestamp !== 0) {
    return byTimestamp;
  }

  const byKind = entry.kind.localeCompare(cursor.kind);
  return byKind !== 0 ? byKind : entry.id.localeCompare(cursor.id);
}

function getTranscriptEntries(chat: Chat): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  for (const message of chat.state.messages) {
    entries.push({
      kind: "message",
      id: message.id,
      timestamp: message.timestamp,
      message,
    });
  }

  for (const tool of chat.state.toolCalls) {
    entries.push({
      kind: "tool",
      id: tool.id,
      timestamp: tool.timestamp,
      tool,
    });
  }

  for (const log of chat.state.logs) {
    if (!shouldIncludeChatTranscriptLog(log)) {
      continue;
    }
    entries.push({
      kind: "log",
      id: log.id,
      timestamp: log.timestamp,
      log,
    });
  }

  return entries.sort(compareTranscriptEntries);
}

function toPage(
  entries: TranscriptEntry[],
  limit: number,
  before?: string,
  options: { revision?: string; totalEntries?: number } = {},
): ChatTranscriptPage {
  const cursor = before ? decodeCursor(before) : undefined;
  const candidates = cursor
    ? entries.filter((entry) => compareEntryToCursor(entry, cursor) < 0)
    : entries;
  const start = Math.max(0, candidates.length - limit);
  const selected = candidates.slice(start);

  return {
    messages: selected
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "message" }> => entry.kind === "message")
      .map((entry) => entry.message),
    logs: selected
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "log" }> => entry.kind === "log")
      .map((entry) => entry.log),
    toolCalls: selected
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "tool" }> => entry.kind === "tool")
      .map((entry) => createToolCallSummary(entry.tool)),
    hasOlder: start > 0,
    ...(start > 0 && selected[0] ? { nextCursor: encodeCursor(selected[0]) } : {}),
    revision: options.revision ?? `${entries.length}:${entries.at(-1)?.timestamp ?? ""}`,
    totalEntries: options.totalEntries ?? entries.length,
  };
}

export function createChatTranscriptPage(
  chat: Chat,
  limit = DEFAULT_TRANSCRIPT_PAGE_SIZE,
  before?: string,
): ChatTranscriptPage {
  return toPage(getTranscriptEntries(chat), limit, before);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createTranscriptEntryFromStorage(
  entry: ChatTranscriptStorageEntry,
): TranscriptEntry | null {
  if (entry.kind === "message" && isRecord(entry.payload)) {
    return {
      kind: "message",
      id: entry.id,
      timestamp: entry.timestamp,
      message: entry.payload as unknown as PersistedMessage,
    };
  }
  if (entry.kind === "tool" && isRecord(entry.payload)) {
    return {
      kind: "tool",
      id: entry.id,
      timestamp: entry.timestamp,
      tool: entry.payload as unknown as ToolCallRecord,
    };
  }
  if (entry.kind === "log" && isRecord(entry.payload)) {
    return {
      kind: "log",
      id: entry.id,
      timestamp: entry.timestamp,
      log: entry.payload as unknown as TaskLogEntry,
    };
  }
  return null;
}

export function createChatTranscriptPageFromStorageEntries(
  entries: ChatTranscriptStorageEntry[],
  limit: number,
  before: string | undefined,
  options: { revision: string; totalEntries: number },
): ChatTranscriptPage {
  const transcriptEntries = entries
    .map(createTranscriptEntryFromStorage)
    .filter((entry): entry is TranscriptEntry => entry !== null)
    .filter((entry) => !entry.kind || entry.kind !== "log" || shouldIncludeChatTranscriptLog(entry.log))
    .sort(compareTranscriptEntries);
  return toPage(transcriptEntries, limit, before, options);
}

export function createChatSnapshot(
  chat: Chat,
  limit = DEFAULT_TRANSCRIPT_PAGE_SIZE,
): ChatSnapshot {
  const { messages: _messages, logs: _logs, toolCalls: _toolCalls, ...state } = chat.state;
  return {
    config: chat.config,
    state,
    transcript: createChatTranscriptPage(chat, limit),
  };
}

export function createChatSnapshotFromPage(
  chat: Chat,
  transcript: ChatTranscriptPage,
): ChatSnapshot {
  const { messages: _messages, logs: _logs, toolCalls: _toolCalls, ...state } = chat.state;
  return {
    config: chat.config,
    state,
    transcript,
  };
}

export function getTranscriptEntryKeyForCursor(
  cursor: string,
): string {
  const decoded = decodeCursor(cursor);
  return getTranscriptEntryKey(decoded);
}

export function getTranscriptCursor(
  kind: ChatTranscriptEntryKind,
  id: string,
  timestamp: string,
): string {
  return encodeCursor({ kind, id, timestamp });
}
