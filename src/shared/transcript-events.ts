import type { MessageData, ToolCallData } from "./events";
import type { ChatTranscript } from "./chat-transcript";
import type { TaskLogEntry } from "./task";
import {
  isToolCallSummary,
  mergeToolCallDisplayData,
  upsertToolCallExtra,
  type ToolCallDisplayData,
  type ToolCallExtra,
} from "./tool-call";

export type TranscriptStreamEvent =
  | {
      type: "transcript.message";
      message: MessageData;
    }
  | {
      type: "transcript.message.delta";
      messageId: string;
      role: MessageData["role"];
      delta: string;
      baseLength: number;
      messageTimestamp: string;
    }
  | {
      type: "transcript.tool";
      tool: ToolCallDisplayData;
    }
  | {
      type: "transcript.tool.extra";
      toolId: string;
      extra: ToolCallExtra;
    }
  | {
      type: "transcript.log";
      log: TaskLogEntry;
    }
  | {
      type: "transcript.log.delta";
      logId: string;
      level: TaskLogEntry["level"];
      message: string;
      logKind: string;
      delta: string;
      baseLength: number;
      logTimestamp: string;
    };

export interface TranscriptStreamUpdate {
  transcript: ChatTranscript;
  gapDetected: boolean;
}

function compareRecords(
  left: { id: string; timestamp: string },
  right: { id: string; timestamp: string },
): number {
  const timestampOrder = left.timestamp.localeCompare(right.timestamp);
  return timestampOrder !== 0 ? timestampOrder : left.id.localeCompare(right.id);
}

function upsertRecord<T extends { id: string; timestamp: string }>(
  records: T[],
  incoming: T,
): { records: T[]; added: boolean } {
  const existingIndex = records.findIndex((record) => record.id === incoming.id);
  const nextRecords = existingIndex < 0
    ? [...records, incoming]
    : records.map((record, index) => index === existingIndex ? incoming : record);
  return {
    records: nextRecords.sort(compareRecords),
    added: existingIndex < 0,
  };
}

function withCollections(
  current: ChatTranscript,
  collections: Partial<Pick<ChatTranscript, "messages" | "logs" | "toolCalls">>,
  addedEntries = 0,
  addedResponses = 0,
): ChatTranscript {
  const messages = collections.messages ?? current.messages;
  const loadedResponses = messages.reduce(
    (count, message) => count + (message.role === "assistant" ? 1 : 0),
    0,
  );
  return {
    ...current,
    ...collections,
    totalEntries: current.totalEntries + addedEntries,
    loadedResponses,
    totalResponses: Math.max(
      loadedResponses,
      current.totalResponses + addedResponses,
    ),
  };
}

export function applyTranscriptStreamEvent(
  current: ChatTranscript,
  event: TranscriptStreamEvent,
): TranscriptStreamUpdate {
  switch (event.type) {
    case "transcript.message": {
      const result = upsertRecord(current.messages, event.message);
      return {
        transcript: withCollections(
          current,
          { messages: result.records },
          result.added ? 1 : 0,
          result.added && event.message.role === "assistant" ? 1 : 0,
        ),
        gapDetected: false,
      };
    }
    case "transcript.message.delta": {
      const existingIndex = current.messages.findIndex(
        (message) => message.id === event.messageId,
      );
      if (existingIndex < 0 && event.baseLength !== 0) {
        return { transcript: current, gapDetected: true };
      }
      const existingContent = existingIndex < 0
        ? ""
        : current.messages[existingIndex]!.content;
      if (existingContent.length !== event.baseLength) {
        return { transcript: current, gapDetected: true };
      }
      const message: MessageData = {
        ...(existingIndex < 0 ? {} : current.messages[existingIndex]),
        id: event.messageId,
        role: event.role,
        content: `${existingContent}${event.delta}`,
        timestamp: existingIndex < 0
          ? event.messageTimestamp
          : current.messages[existingIndex]!.timestamp,
      };
      const result = upsertRecord(current.messages, message);
      return {
        transcript: withCollections(
          current,
          { messages: result.records },
          result.added ? 1 : 0,
          result.added && message.role === "assistant" ? 1 : 0,
        ),
        gapDetected: false,
      };
    }
    case "transcript.tool": {
      const existing = current.toolCalls.find((tool) => tool.id === event.tool.id);
      const tool = mergeToolCallDisplayData(existing, event.tool);
      const result = upsertRecord(current.toolCalls, tool);
      return {
        transcript: withCollections(
          current,
          { toolCalls: result.records },
          result.added ? 1 : 0,
        ),
        gapDetected: false,
      };
    }
    case "transcript.tool.extra": {
      const existingIndex = current.toolCalls.findIndex(
        (tool) => tool.id === event.toolId,
      );
      const existing = current.toolCalls[existingIndex];
      if (existingIndex < 0 || !existing || isToolCallSummary(existing)) {
        return { transcript: current, gapDetected: false };
      }
      const tool: ToolCallData = {
        ...existing,
        extras: upsertToolCallExtra(existing.extras, event.extra),
      };
      const toolCalls = current.toolCalls.map((entry, index) => (
        index === existingIndex ? tool : entry
      ));
      return {
        transcript: withCollections(current, { toolCalls }),
        gapDetected: false,
      };
    }
    case "transcript.log": {
      const result = upsertRecord(current.logs, event.log);
      return {
        transcript: withCollections(
          current,
          { logs: result.records },
          result.added ? 1 : 0,
        ),
        gapDetected: false,
      };
    }
    case "transcript.log.delta": {
      const existingIndex = current.logs.findIndex(
        (logEntry) => logEntry.id === event.logId,
      );
      if (existingIndex < 0 && event.baseLength !== 0) {
        return { transcript: current, gapDetected: true };
      }
      const existingContent = existingIndex < 0
        ? ""
        : current.logs[existingIndex]!.details?.["responseContent"];
      if (typeof existingContent !== "string" || existingContent.length !== event.baseLength) {
        return { transcript: current, gapDetected: true };
      }
      const log: TaskLogEntry = {
        ...(existingIndex < 0 ? {} : current.logs[existingIndex]),
        id: event.logId,
        level: event.level,
        message: event.message,
        details: {
          ...(existingIndex < 0 ? {} : current.logs[existingIndex]!.details),
          logKind: event.logKind,
          responseContent: `${existingContent}${event.delta}`,
        },
        timestamp: existingIndex < 0
          ? event.logTimestamp
          : current.logs[existingIndex]!.timestamp,
      };
      const result = upsertRecord(current.logs, log);
      return {
        transcript: withCollections(
          current,
          { logs: result.records },
          result.added ? 1 : 0,
        ),
        gapDetected: false,
      };
    }
  }
}
