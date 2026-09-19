/**
 * Encode and decode persisted transcript rows at the SQL boundary.
 *
 * Parsed JSON is validated before it becomes a transcript domain value.
 * Malformed message, log, and legacy tool payloads are omitted; malformed
 * optional normalized tool fields are treated as absent while valid summary
 * columns remain usable.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import type {
  ChatTranscriptStorageEntry,
  MessageAttachment,
  PersistedMessage,
  TaskLogEntry,
  ToolCallExtra,
  ToolCallRecord,
} from "@/shared";
import type {
  TranscriptResource,
  TranscriptRow,
  TranscriptStateEntry,
} from "./types";

const log = createLogger("persistence:transcripts:codec");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isMessageAttachment(value: unknown): value is MessageAttachment {
  return (
    isRecord(value)
    && isString(value["id"])
    && isString(value["filename"])
    && isString(value["mimeType"])
    && isString(value["data"])
    && typeof value["size"] === "number"
    && Number.isFinite(value["size"])
    && value["size"] >= 0
  );
}

export function isPersistedMessage(value: unknown): value is PersistedMessage {
  return (
    isRecord(value)
    && isString(value["id"])
    && (value["role"] === "user" || value["role"] === "assistant")
    && isString(value["content"])
    && isString(value["timestamp"])
    && (
      value["attachments"] === undefined
      || (
        Array.isArray(value["attachments"])
        && value["attachments"].every(isMessageAttachment)
      )
    )
  );
}

const TASK_LOG_LEVELS = new Set([
  "agent",
  "user",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
]);

export function isTaskLogEntry(value: unknown): value is TaskLogEntry {
  return (
    isRecord(value)
    && isString(value["id"])
    && typeof value["level"] === "string"
    && TASK_LOG_LEVELS.has(value["level"])
    && isString(value["message"])
    && isString(value["timestamp"])
    && (
      value["details"] === undefined
      || isRecord(value["details"])
    )
  );
}

const TOOL_STATUSES = new Set(["pending", "running", "completed", "failed"]);

function isToolCallExtra(value: unknown): value is ToolCallExtra {
  if (!isRecord(value) || !isString(value["id"]) || value["type"] !== "image_preview") {
    return false;
  }
  const image = value["image"];
  return (
    isMessageAttachment(image)
    && (
      value["sourcePath"] === undefined
      || isString(value["sourcePath"])
    )
  );
}

export function isToolCallRecord(value: unknown): value is ToolCallRecord {
  return (
    isRecord(value)
    && isString(value["id"])
    && isString(value["name"])
    && isString(value["timestamp"])
    && typeof value["status"] === "string"
    && TOOL_STATUSES.has(value["status"])
    && (
      value["extras"] === undefined
      || (
        Array.isArray(value["extras"])
        && value["extras"].every(isToolCallExtra)
      )
    )
    && (
      value["detailRevision"] === undefined
      || isString(value["detailRevision"])
    )
  );
}

function decodeJson<T>(
  value: string | null,
  fallback: T,
  fieldName: string,
  rowId: string,
  validate: (parsed: unknown) => parsed is T,
): T {
  if (value === null) {
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (validate(parsed)) {
      return parsed;
    }
  } catch (error) {
    log.warn("Failed to parse transcript JSON", {
      fieldName,
      rowId,
      error: String(error),
    });
    return fallback;
  }
  log.warn("Transcript JSON failed validation", { fieldName, rowId });
  return fallback;
}

const acceptsAny = (_value: unknown): _value is unknown => true;

export function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized ?? "null";
}

export function getToolPayload(
  entry: Pick<TranscriptStateEntry, "kind" | "payload">,
): ToolCallRecord | null {
  if (entry.kind !== "tool" || !isToolCallRecord(entry.payload)) {
    return null;
  }
  return entry.payload;
}

function decodePayload(
  row: TranscriptRow,
  resource: TranscriptResource,
): PersistedMessage | TaskLogEntry | ToolCallRecord | null {
  if (row.kind === "message") {
    return decodeJson(
      row.payload,
      null,
      `${resource}_transcript_message`,
      row.entry_id,
      isPersistedMessage,
    );
  }
  if (row.kind === "log") {
    return decodeJson(
      row.payload,
      null,
      `${resource}_transcript_log`,
      row.entry_id,
      isTaskLogEntry,
    );
  }
  return decodeJson(
    row.payload,
    null,
    `${resource}_transcript_tool_call`,
    row.entry_id,
    isToolCallRecord,
  );
}

function decodeToolValue(
  value: string | null,
  fieldName: string,
  rowId: string,
): unknown {
  return decodeJson(value, undefined, fieldName, rowId, acceptsAny);
}

function decodeToolExtras(
  value: string | null,
  fieldName: string,
  rowId: string,
): ToolCallExtra[] | undefined {
  return decodeJson(
    value,
    undefined,
    fieldName,
    rowId,
    (parsed: unknown): parsed is ToolCallExtra[] =>
      Array.isArray(parsed) && parsed.every(isToolCallExtra),
  );
}

function getEntryId(row: TranscriptRow): string {
  const idPrefix = `${row.kind}:`;
  return row.entry_id.startsWith(idPrefix)
    ? row.entry_id.slice(idPrefix.length)
    : row.entry_id;
}

function createNormalizedTool(
  row: TranscriptRow,
  resource: TranscriptResource,
  includeToolPayload: boolean,
): ToolCallRecord | null {
  if (row.tool_name === null || row.tool_status === null) {
    return null;
  }
  const toolId = getEntryId(row);
  const input = row.tool_input === null
    ? undefined
    : decodeToolValue(
        row.tool_input,
        `${resource}_transcript_tool_input`,
        row.entry_id,
      );
  const output = includeToolPayload && row.tool_output !== null
    ? decodeToolValue(
        row.tool_output,
        `${resource}_transcript_tool_output`,
        row.entry_id,
      )
    : undefined;
  const extras = includeToolPayload && row.tool_extras !== null
    ? decodeToolExtras(
        row.tool_extras,
        `${resource}_transcript_tool_extras`,
        row.entry_id,
      )
    : undefined;
  const tool: ToolCallRecord = {
    id: toolId,
    name: row.tool_name,
    status: row.tool_status,
    timestamp: row.timestamp,
    detailRevision: row.updated_at,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(extras !== undefined ? { extras } : {}),
  };
  return tool;
}

export function rowToStorageEntry(
  row: TranscriptRow,
  includeToolPayload: boolean,
  resource: TranscriptResource,
): ChatTranscriptStorageEntry {
  const id = getEntryId(row);
  if (row.kind !== "tool") {
    return {
      id,
      kind: row.kind,
      timestamp: row.timestamp,
      sequence: row.sequence,
      payload: decodePayload(row, resource),
    };
  }

  const normalizedTool = createNormalizedTool(row, resource, includeToolPayload);
  if (normalizedTool) {
    return {
      id,
      kind: row.kind,
      timestamp: row.timestamp,
      sequence: row.sequence,
      payload: includeToolPayload ? normalizedTool : {},
      tool: normalizedTool,
      ...(row.tool_has_output !== undefined && row.tool_has_output !== null
        ? { toolHasOutput: row.tool_has_output === 1 }
        : {}),
    };
  }

  const legacyTool = decodePayload(row, resource);
  if (legacyTool && !includeToolPayload && isToolCallRecord(legacyTool)) {
    const { output: _output, extras: _extras, ...summary } = legacyTool;
    return {
      id,
      kind: row.kind,
      timestamp: row.timestamp,
      sequence: row.sequence,
      payload: summary,
      tool: summary,
      ...(legacyTool.output !== undefined ? { toolHasOutput: true } : {}),
    };
  }
  return {
    id,
    kind: row.kind,
    timestamp: row.timestamp,
    sequence: row.sequence,
    payload: legacyTool,
    ...(legacyTool && isToolCallRecord(legacyTool) ? { tool: legacyTool } : {}),
  };
}
