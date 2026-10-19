import { createHash } from "node:crypto";
import {
  createToolCallSummary,
  isCountedAssistantResponse,
  mergeTranscriptIncomingRecords,
} from "@/shared";
import type {
  ChatTranscript,
  ChatTranscriptStorageEntry,
  PersistedMessage,
  TaskLogEntry,
  TranscriptSnapshotOptions,
  ToolCallRecord,
} from "@/shared";
import type { TranscriptEntriesPage } from "../persistence/transcripts/types";
import type { LiveTranscriptState } from "./transcript-stream-projection";

export function includeLiveTranscript(
  persisted: ChatTranscript,
  live: LiveTranscriptState | undefined,
  options: {
    window: TranscriptSnapshotOptions;
    shouldIncludeLog?: (entry: TaskLogEntry) => boolean;
  },
): ChatTranscript {
  if (!live || options.window.before) return persisted;
  const boundary = persisted.isPartial
    ? [...persisted.messages, ...persisted.logs, ...persisted.toolCalls].reduce<string | undefined>(
      (earliest, entry) => !earliest || entry.timestamp < earliest ? entry.timestamp : earliest,
      undefined,
    )
    : undefined;
  const inWindow = (entry: { timestamp: string }) => !boundary || entry.timestamp >= boundary;
  const messages = mergeTranscriptIncomingRecords([], live.messages.filter(inWindow));
  const logs = mergeTranscriptIncomingRecords(
    [],
    live.logs.filter((entry) => inWindow(entry) && (!options.shouldIncludeLog || options.shouldIncludeLog(entry))),
  );
  const toolCalls = mergeTranscriptIncomingRecords(
    [],
    live.toolCalls.filter(inWindow).map((tool) => createToolCallSummary(tool)),
  );
  const loadedResponses = messages.filter(isCountedAssistantResponse).length;
  const totalResponses = live.messages.filter(isCountedAssistantResponse).length;
  const isPartial = loadedResponses < totalResponses;
  const { nextCursor, ...storedWindow } = persisted;
  return {
    ...storedWindow,
    messages,
    logs,
    toolCalls,
    position: live.position,
    revision: `${persisted.revision}:${live.position.epoch}:${String(live.position.revision)}`,
    loadedResponses,
    totalResponses,
    totalEntries: live.messages.length + live.logs.length + live.toolCalls.length,
    isPartial,
    hasOlder: isPartial && persisted.hasOlder,
    ...(isPartial && nextCursor ? { nextCursor } : {}),
  };
}

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
      hasImagePreview?: boolean;
    }
  | {
      kind: "log";
      id: string;
      timestamp: string;
      sequence: number;
      log: TaskLogEntry;
    };

export function getTranscriptSnapshotEtag(
  transcriptRevision: string,
  snapshotState: unknown,
  window: TranscriptSnapshotOptions = {},
): string {
  const windowKey = window.full ? "full" : window.before ? "page" : window.since ? "range" : "latest";
  const stateRevision = createHash("sha256")
    .update(JSON.stringify({ snapshotState, window }) ?? "undefined")
    .digest("hex")
    .slice(0, 16);
  return `${transcriptRevision}:state-${stateRevision}:${windowKey}`;
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
      ...(entry.toolHasImagePreview !== undefined ? { hasImagePreview: entry.toolHasImagePreview } : {}),
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

export function createTranscriptFromStorageEntries(
  entries: ChatTranscriptStorageEntry[],
  options: {
    revision: string;
    totalEntries: number;
    totalResponses?: number;
    hasOlder?: boolean;
    nextCursor?: string;
    isPartial?: boolean;
  },
  shouldIncludeLog: (entry: TaskLogEntry) => boolean = () => true,
): ChatTranscript {
  const transcriptEntries = entries
    .map((entry) => createTranscriptEntryFromStorage(entry, shouldIncludeLog))
    .filter((entry): entry is TranscriptEntry => entry !== null)
    .sort(compareTranscriptEntries);

  const messages = transcriptEntries
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "message" }> => entry.kind === "message")
      .map((entry) => entry.message);
  const logs = transcriptEntries
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "log" }> => entry.kind === "log")
      .map((entry) => entry.log);
  const toolCalls = transcriptEntries
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "tool" }> => entry.kind === "tool")
      .map((entry) => createToolCallSummary(entry.tool, {
        hasOutput: entry.hasOutput,
        hasImagePreview: entry.hasImagePreview,
      }));
  const loadedResponses = messages.filter(isCountedAssistantResponse).length;
  const totalResponses = options.totalResponses ?? loadedResponses;
  const isPartial = options.isPartial ?? totalResponses > loadedResponses;

  return {
    messages,
    logs,
    toolCalls,
    revision: options.revision,
    position: { epoch: options.revision, revision: 0 },
    totalEntries: options.totalEntries,
    isPartial,
    loadedResponses,
    totalResponses,
    hasOlder: options.hasOlder ?? false,
    ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
  };
}

export function createTranscriptFromStoragePage(
  page: TranscriptEntriesPage,
  options: { revision: string; totalEntries: number },
  shouldIncludeLog: (entry: TaskLogEntry) => boolean = () => true,
): ChatTranscript {
  return createTranscriptFromStorageEntries(
    page.entries,
    {
      ...options,
      totalResponses: page.totalResponses,
      hasOlder: page.hasOlder,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    },
    shouldIncludeLog,
  );
}
