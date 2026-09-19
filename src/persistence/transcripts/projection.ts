/**
 * Deterministic transcript projection from domain state to storage entries.
 */
import type {
  PersistedMessage,
  TaskLogEntry,
  ToolCallRecord,
} from "@/shared";
import type {
  TranscriptEntryKind,
  TranscriptStateEntry,
  TranscriptStateLike,
} from "./types";

export function getTranscriptEntryKey(
  kind: TranscriptEntryKind,
  id: string,
): string {
  return `${kind}:${id}`;
}

export function sortTranscriptStateEntries(
  entries: TranscriptStateEntry[],
): TranscriptStateEntry[] {
  return [...entries].sort((left, right) => {
    const byTimestamp = left.timestamp.localeCompare(right.timestamp);
    if (byTimestamp !== 0) {
      return byTimestamp;
    }
    const byOrder = left.order - right.order;
    if (byOrder !== 0) {
      return byOrder;
    }
    const byKind = left.kind.localeCompare(right.kind);
    return byKind !== 0 ? byKind : left.id.localeCompare(right.id);
  });
}

export function getTranscriptStateEntries(
  state: TranscriptStateLike,
  shouldIncludeLog: (entry: TaskLogEntry) => boolean = () => true,
): TranscriptStateEntry[] {
  let order = 0;
  return [
    ...state.messages.map((message: PersistedMessage) => ({
      id: message.id,
      timestamp: message.timestamp,
      kind: "message" as const,
      order: order++,
      payload: message,
    })),
    ...state.toolCalls.map((toolCall: ToolCallRecord) => ({
      id: toolCall.id,
      timestamp: toolCall.timestamp,
      kind: "tool" as const,
      order: order++,
      payload: toolCall,
    })),
    ...state.logs.filter(shouldIncludeLog).map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      kind: "log" as const,
      order: order++,
      payload: entry,
    })),
  ];
}

export function getTranscriptRevision(
  entries: TranscriptStateEntry[],
  updatedAt: string,
): string {
  const sorted = sortTranscriptStateEntries(entries);
  return `${sorted.length}:${sorted.at(-1)?.timestamp ?? ""}:${updatedAt}`;
}
