import { createHash } from "node:crypto";
import { createToolCallSummary } from "@/shared";
import type {
  ChatTranscript,
  ChatTranscriptStorageEntry,
  PersistedMessage,
  TaskLogEntry,
  ToolCallRecord,
} from "@/shared";

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

export function getTranscriptSnapshotEtag(
  transcriptRevision: string,
  snapshotState: unknown,
): string {
  const stateRevision = createHash("sha256")
    .update(JSON.stringify(snapshotState) ?? "undefined")
    .digest("hex")
    .slice(0, 16);
  return `${transcriptRevision}:state-${stateRevision}:full`;
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
  options: { revision: string; totalEntries: number },
  shouldIncludeLog: (entry: TaskLogEntry) => boolean = () => true,
): ChatTranscript {
  const transcriptEntries = entries
    .map((entry) => createTranscriptEntryFromStorage(entry, shouldIncludeLog))
    .filter((entry): entry is TranscriptEntry => entry !== null)
    .sort(compareTranscriptEntries);

  return {
    messages: transcriptEntries
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "message" }> => entry.kind === "message")
      .map((entry) => entry.message),
    logs: transcriptEntries
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "log" }> => entry.kind === "log")
      .map((entry) => entry.log),
    toolCalls: transcriptEntries
      .filter((entry): entry is Extract<TranscriptEntry, { kind: "tool" }> => entry.kind === "tool")
      .map((entry) => createToolCallSummary(entry.tool, { hasOutput: entry.hasOutput })),
    revision: options.revision,
    totalEntries: options.totalEntries,
  };
}
