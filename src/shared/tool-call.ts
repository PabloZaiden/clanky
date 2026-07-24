import type { MessageImageAttachment } from "./message-attachments";
import {
  getToolCallOutputLabel,
  getToolCallSummary,
  inferToolCallKind,
  type ToolCallKind,
} from "./tool-call-presentation";

export interface ToolCallImagePreviewExtra {
  id: string;
  type: "image_preview";
  image: MessageImageAttachment;
  sourcePath?: string;
}

export type ToolCallExtra = ToolCallImagePreviewExtra;

export interface ToolCallRecord {
  id: string;
  name: string;
  input?: unknown;
  output?: unknown;
  status: "pending" | "running" | "completed" | "failed";
  timestamp: string;
  extras?: ToolCallExtra[];
  /** Server-side revision used to invalidate cached lazy details. */
  detailRevision?: string;
}

/**
 * Lightweight browser representation used by paginated chat transcripts.
 * Tool inputs are included so collapsed rows can be described accurately;
 * outputs and image bytes stay on the server until the row is expanded.
 */
export interface ToolCallSummary {
  id: string;
  name: string;
  input?: unknown;
  status: ToolCallRecord["status"];
  timestamp: string;
  summary: string;
  kind: ToolCallKind;
  outputLabel: string;
  outputType: "text" | "json";
  hasInput: boolean;
  hasOutput: boolean;
  detailRevision?: string;
  detailAvailable: true;
}

export type ToolCallDisplayData = ToolCallRecord | ToolCallSummary;

/** Keep normal tool inputs complete without allowing pathological payloads into snapshots. */
export function isToolCallSummary(value: ToolCallDisplayData): value is ToolCallSummary {
  return "detailAvailable" in value && value.detailAvailable === true;
}

export function isToolCallDetailsStale(
  summary: ToolCallSummary,
  details: ToolCallRecord,
): boolean {
  return (
    details.status !== summary.status
    || (summary.hasInput && details.input === undefined)
    || (summary.hasOutput && details.output === undefined)
    || (
      summary.detailRevision !== undefined
      && details.detailRevision !== summary.detailRevision
    )
  );
}

export function createToolCallSummary(
  tool: ToolCallRecord,
  metadata: { hasOutput?: boolean; detailRevision?: string } = {},
): ToolCallSummary {
  const kind = inferToolCallKind(tool);
  const detailRevision = metadata.detailRevision ?? tool.detailRevision;
  return {
    id: tool.id,
    name: tool.name,
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    status: tool.status,
    timestamp: tool.timestamp,
    summary: getToolCallSummary(tool, kind),
    kind,
    outputLabel: getToolCallOutputLabel(kind, tool.status),
    outputType: typeof tool.output === "string" ? "text" : "json",
    hasInput: tool.input !== undefined,
    hasOutput: metadata.hasOutput ?? tool.output !== undefined,
    ...(detailRevision !== undefined ? { detailRevision } : {}),
    detailAvailable: true,
  };
}

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return isNonNullObject(value) && Object.keys(value).length === 0;
}

function mergeToolValue<T>(existing: T | undefined, incoming: T | undefined): T | undefined {
  if (incoming === undefined) {
    return existing;
  }
  if (isEmptyObject(incoming) && existing !== undefined && !isEmptyObject(existing)) {
    return existing;
  }
  return incoming;
}

function mergeToolCallExtras(
  existing: ToolCallExtra[] | undefined,
  incoming: ToolCallExtra[] | undefined,
): ToolCallExtra[] | undefined {
  if (incoming === undefined) {
    return existing;
  }
  if (existing === undefined || existing.length === 0) {
    return incoming;
  }

  let merged = [...existing];
  for (const extra of incoming) {
    merged = upsertToolCallExtra(merged, extra);
  }
  return merged;
}

function mergeToolStatus(
  existing: ToolCallRecord["status"],
  incoming: ToolCallRecord["status"],
): ToolCallRecord["status"] {
  const existingIsTerminal = existing === "completed" || existing === "failed";
  const incomingIsTerminal = incoming === "completed" || incoming === "failed";
  if (existingIsTerminal && !incomingIsTerminal) {
    return existing;
  }
  return incoming;
}

function sortToolCalls<T extends ToolCallRecord>(toolCalls: T[]): T[] {
  return [...toolCalls].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function mergeToolCallRecordMap<T extends ToolCallRecord>(toolCalls: T[]): Map<string, T> {
  const toolCallsById = new Map<string, T>();
  for (const toolCall of toolCalls) {
    toolCallsById.set(
      toolCall.id,
      mergeToolCallRecord(toolCallsById.get(toolCall.id), toolCall),
    );
  }
  return toolCallsById;
}

export function upsertToolCallExtra(
  extras: ToolCallExtra[] | undefined,
  extra: ToolCallExtra,
): ToolCallExtra[] {
  const existing = extras ?? [];
  const index = existing.findIndex((entry) => entry.id === extra.id);
  if (index >= 0) {
    return existing.map((entry, entryIndex) => entryIndex === index ? extra : entry);
  }
  return [...existing, extra];
}

export function mergeToolCallRecord<T extends ToolCallRecord>(
  existing: T | undefined,
  incoming: T,
): T {
  if (!existing) {
    return incoming;
  }

  const mergedInput = mergeToolValue(existing.input, incoming.input) ?? incoming.input;
  const mergedOutput = mergeToolValue(existing.output, incoming.output);
  const mergedExtras = mergeToolCallExtras(existing.extras, incoming.extras);

  return {
    ...existing,
    ...incoming,
    input: mergedInput,
    status: mergeToolStatus(existing.status, incoming.status),
    ...(mergedOutput !== undefined ? { output: mergedOutput } : {}),
    ...(mergedExtras !== undefined ? { extras: mergedExtras } : {}),
  };
}

function isTerminalToolStatus(status: ToolCallRecord["status"]): boolean {
  return status === "completed" || status === "failed";
}

function mergeToolCallSummaries(
  existing: ToolCallSummary,
  incoming: ToolCallSummary,
): ToolCallSummary {
  const latest = incoming.timestamp.localeCompare(existing.timestamp) >= 0 ? incoming : existing;
  const status = isTerminalToolStatus(existing.status) && !isTerminalToolStatus(incoming.status)
    ? existing.status
    : isTerminalToolStatus(incoming.status) && !isTerminalToolStatus(existing.status)
      ? incoming.status
      : latest.status;
  const selected = status === latest.status
    ? latest
    : status === existing.status
      ? existing
      : incoming;
  const input = latest.input ?? existing.input ?? incoming.input;
  const displayTool: ToolCallRecord = {
    id: selected.id,
    name: selected.name,
    status,
    timestamp: selected.timestamp,
    ...(input !== undefined ? { input } : {}),
  };
  const kind = inferToolCallKind(displayTool);

  return {
    ...selected,
    ...(input !== undefined ? { input } : {}),
    status,
    summary: getToolCallSummary(displayTool, kind),
    kind,
    outputLabel: getToolCallOutputLabel(kind, status),
    hasInput: existing.hasInput || incoming.hasInput || input !== undefined,
    hasOutput: existing.hasOutput || incoming.hasOutput,
    ...(selected.detailRevision === undefined
      ? (existing.detailRevision !== undefined
        ? { detailRevision: existing.detailRevision }
        : incoming.detailRevision !== undefined
          ? { detailRevision: incoming.detailRevision }
          : {})
      : {}),
    detailAvailable: true,
  };
}

function toToolCallRecord(value: ToolCallRecord): ToolCallRecord {
  const displayValue = value as ToolCallRecord & Partial<ToolCallSummary>;
  const {
    summary: _summary,
    kind: _kind,
    outputLabel: _outputLabel,
    outputType: _outputType,
    hasInput: _hasInput,
    hasOutput: _hasOutput,
    detailAvailable: _detailAvailable,
    ...record
  } = displayValue;
  return record;
}

export function mergeToolCallDisplayData(
  existing: ToolCallDisplayData | undefined,
  incoming: ToolCallDisplayData,
): ToolCallDisplayData {
  if (!existing) {
    return incoming;
  }
  if (isToolCallSummary(existing) && isToolCallSummary(incoming)) {
    return mergeToolCallSummaries(existing, incoming);
  }
  if (isToolCallSummary(existing)) {
    return toToolCallRecord(mergeToolCallRecord<ToolCallRecord>(
      existing as ToolCallRecord,
      incoming as ToolCallRecord,
    ));
  }
  if (isToolCallSummary(incoming)) {
    return toToolCallRecord(mergeToolCallRecord<ToolCallRecord>(
      incoming as ToolCallRecord,
      existing,
    ));
  }
  return toToolCallRecord(mergeToolCallRecord(existing, incoming));
}

export function upsertToolCallRecord<T extends ToolCallRecord>(
  toolCalls: T[],
  incoming: T,
): T[] {
  const existingIndex = toolCalls.findIndex((toolCall) => toolCall.id === incoming.id);
  if (existingIndex === -1) {
    return sortToolCalls([...toolCalls, incoming]);
  }

  const nextToolCalls = [...toolCalls];
  nextToolCalls[existingIndex] = mergeToolCallRecord(nextToolCalls[existingIndex], incoming);
  return sortToolCalls(nextToolCalls);
}

export function mergeToolCallRecords<T extends ToolCallRecord>(
  existing: T[],
  incoming: T[],
): T[] {
  const merged = mergeToolCallRecordMap(existing);
  for (const toolCall of incoming) {
    merged.set(toolCall.id, mergeToolCallRecord(merged.get(toolCall.id), toolCall));
  }
  return sortToolCalls(Array.from(merged.values()));
}

export function reconcileToolCallRecords<T extends ToolCallRecord>(
  existing: T[],
  incoming: T[],
): T[] {
  const existingById = mergeToolCallRecordMap(existing);
  const reconciled = new Map<string, T>();
  for (const toolCall of incoming) {
    const current = reconciled.get(toolCall.id) ?? existingById.get(toolCall.id);
    reconciled.set(toolCall.id, mergeToolCallRecord(current, toolCall));
  }
  return sortToolCalls(Array.from(reconciled.values()));
}
