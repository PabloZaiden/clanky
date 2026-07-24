import { createHash } from "node:crypto";
import { createToolCallSummary } from "@/shared";
import type {
  ChatTranscriptCursor,
  ChatTranscriptPage,
  ChatTranscriptStorageEntry,
  PersistedMessage,
  TaskLogEntry,
  ToolCallRecord,
} from "@/shared";

const DEFAULT_TRANSCRIPT_PAGE_SIZE = 100;
const MAX_TRANSCRIPT_PAGE_SIZE = 200;
const CURSOR_VERSION = 2;

type TranscriptEntry =
  | {
      kind: "message";
      id: string;
      timestamp: string;
      sequence: number;
      message: PersistedMessage;
    }
  | {
      kind: "tool";
      id: string;
      timestamp: string;
      sequence: number;
      tool: ToolCallRecord;
      hasOutput?: boolean;
    }
  | {
      kind: "log";
      id: string;
      timestamp: string;
      sequence: number;
      log: TaskLogEntry;
    };

export class InvalidTranscriptCursorError extends Error {
  readonly code = "invalid_transcript_cursor";
  readonly status = 400;

  constructor() {
    super("The transcript cursor is invalid or expired");
    this.name = "InvalidTranscriptCursorError";
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

export function getTranscriptPageEtag(
  revision: string,
  before: string | undefined,
  limit: number,
): string {
  return `${revision}:${before ?? "latest"}:${limit}`;
}

export function getTranscriptSnapshotEtag(
  transcriptRevision: string,
  snapshotState: unknown,
  limit: number,
): string {
  const stateRevision = createHash("sha256")
    .update(JSON.stringify(snapshotState) ?? "undefined")
    .digest("hex")
    .slice(0, 16);
  return getTranscriptPageEtag(`${transcriptRevision}:state-${stateRevision}`, undefined, limit);
}

function compareTranscriptEntries(left: TranscriptEntry, right: TranscriptEntry): number {
  const byTimestamp = left.timestamp.localeCompare(right.timestamp);
  if (byTimestamp !== 0) {
    return byTimestamp;
  }
  const bySequence = left.sequence - right.sequence;
  if (bySequence !== 0) {
    return bySequence;
  }
  const byKind = left.kind.localeCompare(right.kind);
  return byKind !== 0 ? byKind : left.id.localeCompare(right.id);
}

function encodeCursor(entry: Pick<TranscriptEntry, "kind" | "id" | "timestamp" | "sequence">): string {
  const cursor: ChatTranscriptCursor & { version: number } = {
    version: CURSOR_VERSION,
    kind: entry.kind,
    id: entry.id,
    timestamp: entry.timestamp,
    sequence: entry.sequence,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function parseTranscriptCursor(value: string): ChatTranscriptCursor {
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
      || typeof parsed.sequence !== "number"
      || !Number.isInteger(parsed.sequence)
      || parsed.sequence < 0
    ) {
      throw new Error("Invalid cursor shape");
    }
    return {
      kind: parsed.kind,
      id: parsed.id,
      timestamp: parsed.timestamp,
      sequence: parsed.sequence,
    };
  } catch {
    throw new InvalidTranscriptCursorError();
  }
}

function compareEntryToCursor(entry: TranscriptEntry, cursor: ChatTranscriptCursor): number {
  const byTimestamp = entry.timestamp.localeCompare(cursor.timestamp);
  if (byTimestamp !== 0) {
    return byTimestamp;
  }
  const bySequence = entry.sequence - cursor.sequence;
  if (bySequence !== 0) {
    return bySequence;
  }
  const byKind = entry.kind.localeCompare(cursor.kind);
  return byKind !== 0 ? byKind : entry.id.localeCompare(cursor.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createTranscriptEntryFromStorage(
  entry: ChatTranscriptStorageEntry,
  shouldIncludeLog: (entry: TaskLogEntry) => boolean,
): TranscriptEntry | null {
  if (entry.kind === "message" && isRecord(entry.payload)) {
    return {
      kind: "message",
      id: entry.id,
      timestamp: entry.timestamp,
      sequence: entry.sequence,
      message: entry.payload as unknown as PersistedMessage,
    };
  }
  if (entry.kind === "tool" && (entry.tool || isRecord(entry.payload))) {
    return {
      kind: "tool",
      id: entry.id,
      timestamp: entry.timestamp,
      sequence: entry.sequence,
      tool: (entry.tool ?? entry.payload) as ToolCallRecord,
      ...(entry.toolHasOutput !== undefined ? { hasOutput: entry.toolHasOutput } : {}),
    };
  }
  if (entry.kind === "log" && isRecord(entry.payload)) {
    const logEntry = entry.payload as unknown as TaskLogEntry;
    return shouldIncludeLog(logEntry)
      ? {
          kind: "log",
          id: entry.id,
          timestamp: entry.timestamp,
          sequence: entry.sequence,
          log: logEntry,
        }
      : null;
  }
  return null;
}

export function isTranscriptStorageEntryVisible(
  entry: ChatTranscriptStorageEntry,
  shouldIncludeLog: (entry: TaskLogEntry) => boolean = () => true,
): boolean {
  return createTranscriptEntryFromStorage(entry, shouldIncludeLog) !== null;
}

export function createTranscriptPageFromStorageEntries(
  entries: ChatTranscriptStorageEntry[],
  limit: number,
  before: string | undefined,
  options: { revision: string; totalEntries: number; hasOlder?: boolean },
  shouldIncludeLog: (entry: TaskLogEntry) => boolean = () => true,
): ChatTranscriptPage {
  const cursor = before ? parseTranscriptCursor(before) : undefined;
  const hasMoreEntries = options.hasOlder ?? entries.length > limit;
  const transcriptEntries = entries
    .map((entry) => createTranscriptEntryFromStorage(entry, shouldIncludeLog))
    .filter((entry): entry is TranscriptEntry => entry !== null)
    .filter((entry) => !cursor || compareEntryToCursor(entry, cursor) < 0)
    .sort(compareTranscriptEntries);
  const selected = transcriptEntries.length > limit
    ? transcriptEntries.slice(-limit)
    : transcriptEntries;

  return {
    messages: selected
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "message" }> => entry.kind === "message")
      .map((entry) => entry.message),
    logs: selected
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "log" }> => entry.kind === "log")
      .map((entry) => entry.log),
    toolCalls: selected
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "tool" }> => entry.kind === "tool")
      .map((entry) => createToolCallSummary(entry.tool, { hasOutput: entry.hasOutput })),
    hasOlder: hasMoreEntries,
    ...(hasMoreEntries
      ? { nextCursor: encodeCursor(selected[0] ?? entries.at(-1)!) }
      : {}),
    revision: options.revision,
    totalEntries: options.totalEntries,
  };
}
