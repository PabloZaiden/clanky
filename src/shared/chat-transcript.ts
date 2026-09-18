import type { ChatConfig, ChatState } from "./chat";
import type { PersistedMessage, TaskLogEntry } from "./task";
import {
  mergeToolCallDisplayData,
  type ToolCallDisplayData,
  type ToolCallRecord,
} from "./tool-call";

export type ChatTranscriptEntryKind = "message" | "tool" | "log";

export type TranscriptEntryKind = ChatTranscriptEntryKind;

export type TranscriptEntryPayload = PersistedMessage | TaskLogEntry | ToolCallRecord;

export const TRANSCRIPT_PAGE_SIZE = 100;

export interface TranscriptSnapshotOptions {
  full?: boolean;
  before?: string;
}

export interface TranscriptEntryUpsert {
  id: string;
  kind: TranscriptEntryKind;
  timestamp: string;
  payload: TranscriptEntryPayload;
  /**
   * Existing entries keep their database sequence. New live entries may
   * provide one so the persistence layer does not need to scan the resource.
   */
  sequence?: number;
}

export interface TranscriptEntryDelete {
  id: string;
  kind: TranscriptEntryKind;
}

export interface TranscriptChangeSet {
  upserts: TranscriptEntryUpsert[];
  deletes: TranscriptEntryDelete[];
  entryCount: number;
  revision?: string;
}

export function createTranscriptChangeSet(
  state: {
    messages: PersistedMessage[];
    logs: TaskLogEntry[];
    toolCalls: ToolCallRecord[];
  },
  upserts: TranscriptEntryUpsert[] = [],
  deletes: TranscriptEntryDelete[] = [],
): TranscriptChangeSet {
  return {
    upserts,
    deletes,
    entryCount: state.messages.length + state.logs.length + state.toolCalls.length,
  };
}

export interface ChatTranscriptStorageEntry {
  id: string;
  kind: ChatTranscriptEntryKind;
  timestamp: string;
  sequence: number;
  payload: unknown;
  /** Normalized tool metadata/input; output and extras are omitted from snapshots. */
  tool?: ToolCallRecord;
  toolHasOutput?: boolean;
}

export interface ChatTranscript {
  messages: PersistedMessage[];
  logs: TaskLogEntry[];
  toolCalls: ToolCallDisplayData[];
  revision: string;
  totalEntries: number;
  isPartial: boolean;
  loadedResponses: number;
  totalResponses: number;
  hasOlder: boolean;
  nextCursor?: string;
}

export type ChatSnapshotState = Omit<ChatState, "messages" | "logs" | "toolCalls">;

export interface ChatSnapshot {
  config: ChatConfig;
  state: ChatSnapshotState;
  transcript: ChatTranscript;
}

export type TranscriptSnapshotMergeDirection = "refresh" | "older" | "full";

export interface TranscriptSnapshotMergeOptions {
  direction?: TranscriptSnapshotMergeDirection;
}

function compareTranscriptRecords(
  left: { id: string; timestamp: string },
  right: { id: string; timestamp: string },
): number {
  const byTimestamp = left.timestamp.localeCompare(right.timestamp);
  return byTimestamp !== 0 ? byTimestamp : left.id.localeCompare(right.id);
}

export function mergeTranscriptSnapshot(
  current: ChatTranscript | null | undefined,
  incoming: ChatTranscript,
  options: TranscriptSnapshotMergeOptions = {},
): ChatTranscript {
  if (
    !current
    || (
      current.revision.length === 0
      && current.totalEntries === 0
      && current.messages.length === 0
      && current.logs.length === 0
      && current.toolCalls.length === 0
    )
  ) {
    return incoming;
  }

  const incomingIsFull = !incoming.isPartial;
  const currentIsFull = !current.isPartial;
  const direction = options.direction ?? "refresh";
  const mergeRecords = incomingIsFull
    ? mergeTranscriptSnapshotRecords
    : mergeTranscriptRecords;
  const messages = mergeRecords(current.messages, incoming.messages);
  const logs = mergeRecords(current.logs, incoming.logs);
  const toolCalls = incomingIsFull
    ? mergeTranscriptSnapshotToolCalls(current.toolCalls, incoming.toolCalls)
    : mergeTranscriptToolCalls(current.toolCalls, incoming.toolCalls);
  const loadedResponses = countAssistantResponses(messages);
  const totalResponses = Math.max(current.totalResponses, incoming.totalResponses);
  const isPartial = !incomingIsFull && !currentIsFull && loadedResponses < totalResponses;
  const nextCursor = !isPartial
    ? undefined
    : direction === "older"
      ? incoming.nextCursor
      : current.loadedResponses > incoming.loadedResponses
      ? current.nextCursor ?? incoming.nextCursor
      : incoming.nextCursor ?? current.nextCursor;

  return {
    messages,
    logs,
    toolCalls,
    revision: incoming.revision,
    totalEntries: Math.max(current.totalEntries, incoming.totalEntries),
    isPartial,
    loadedResponses,
    totalResponses,
    hasOlder: isPartial && Boolean(nextCursor),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function countAssistantResponses(messages: PersistedMessage[]): number {
  return messages.reduce(
    (count, message) => count + (message.role === "assistant" ? 1 : 0),
    0,
  );
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
  return Array.from(merged.values()).sort(compareTranscriptRecords);
}

export function mergeTranscriptSnapshotRecords<T extends { id: string; timestamp: string }>(
  current: T[],
  incoming: T[],
): T[] {
  const incomingIds = new Set(incoming.map((item) => item.id));
  const latestIncomingTimestamp = incoming.reduce(
    (latest, item) => item.timestamp.localeCompare(latest) > 0 ? item.timestamp : latest,
    "",
  );
  const liveOnly = latestIncomingTimestamp.length > 0
    ? current.filter((item) => (
      !incomingIds.has(item.id)
      && item.timestamp.localeCompare(latestIncomingTimestamp) >= 0
    ))
    : [];
  return [...incoming, ...liveOnly]
    .sort(compareTranscriptRecords);
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
  return Array.from(merged.values()).sort(compareTranscriptRecords);
}

export function mergeTranscriptSnapshotToolCalls(
  current: ToolCallDisplayData[],
  incoming: ToolCallDisplayData[],
): ToolCallDisplayData[] {
  const incomingIds = new Set(incoming.map((toolCall) => toolCall.id));
  const latestIncomingTimestamp = incoming.reduce(
    (latest, toolCall) => toolCall.timestamp.localeCompare(latest) > 0 ? toolCall.timestamp : latest,
    "",
  );
  const currentToMerge = latestIncomingTimestamp.length > 0
    ? current.filter((toolCall) => (
      incomingIds.has(toolCall.id)
      || toolCall.timestamp.localeCompare(latestIncomingTimestamp) >= 0
    ))
    : [];
  return mergeTranscriptToolCalls(currentToMerge, incoming);
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
