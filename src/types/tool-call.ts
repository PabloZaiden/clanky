import type { MessageImageAttachment } from "./message-attachments";

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
  input: unknown;
  output?: unknown;
  status: "pending" | "running" | "completed" | "failed";
  timestamp: string;
  extras?: ToolCallExtra[];
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
  return [...toolCalls].sort((left, right) => {
    const byTimestamp = left.timestamp.localeCompare(right.timestamp);
    return byTimestamp !== 0 ? byTimestamp : left.id.localeCompare(right.id);
  });
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
