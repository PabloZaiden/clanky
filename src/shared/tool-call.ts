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
  input?: unknown;
  output?: unknown;
  status: "pending" | "running" | "completed" | "failed";
  timestamp: string;
  extras?: ToolCallExtra[];
}

/**
 * Lightweight browser representation used by paginated chat transcripts.
 * Tool inputs, outputs, and image bytes stay on the server until the row is
 * expanded.
 */
export interface ToolCallSummary {
  id: string;
  name: string;
  status: ToolCallRecord["status"];
  timestamp: string;
  summary: string;
  kind: string;
  outputLabel: string;
  outputType: "text" | "json";
  hasInput: boolean;
  hasOutput: boolean;
  inputSize?: number;
  outputSize?: number;
  detailAvailable: true;
}

export type ToolCallDisplayData = ToolCallRecord | ToolCallSummary;

export interface ToolCallSummaryOptions {
  includeSizes?: boolean;
}

export function isToolCallSummary(value: ToolCallDisplayData): value is ToolCallSummary {
  return "detailAvailable" in value && value.detailAvailable === true;
}

function truncateSummary(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

function getRecordString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getToolInputSummary(tool: ToolCallRecord): string {
  if (typeof tool.input === "string") {
    return truncateSummary(tool.input.split(/\r?\n/, 1)[0] ?? tool.input);
  }

  if (tool.input && typeof tool.input === "object" && !Array.isArray(tool.input)) {
    const input = tool.input as Record<string, unknown>;
    const value =
      getRecordString(input, "path")
      ?? getRecordString(input, "filePath")
      ?? getRecordString(input, "command")
      ?? getRecordString(input, "cmd")
      ?? getRecordString(input, "query")
      ?? getRecordString(input, "name");
    if (value) {
      return truncateSummary(value);
    }

    const paths = input["paths"];
    if (Array.isArray(paths) && paths.every((path) => typeof path === "string")) {
      return truncateSummary(paths.join(", "));
    }
  }

  return tool.name.trim() || "Tool activity";
}

function inferToolKind(tool: ToolCallRecord): string {
  const name = tool.name.trim().toLowerCase().replace(/^general tool:\s*/i, "");
  if (name === "read" || name === "view") return "view";
  if (name === "edit" || name === "write" || name === "multiedit") return "edit";
  if (name === "execute" || name === "bash" || name === "shell") return "bash";
  if (name === "grep" || name === "rg" || name === "search") return "rg";
  if (name === "glob" || name === "ls") return "glob";
  if (name === "fetch" || name === "webfetch") return "web_fetch";
  if (name === "todowrite") return "todo";
  return "unknown";
}

function getJsonSize(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized === undefined
    ? undefined
    : new TextEncoder().encode(serialized).byteLength;
}

export function createToolCallSummary(
  tool: ToolCallRecord,
  options: ToolCallSummaryOptions = {},
): ToolCallSummary {
  const includeSizes = options.includeSizes ?? true;
  return {
    id: tool.id,
    name: tool.name,
    status: tool.status,
    timestamp: tool.timestamp,
    summary: getToolInputSummary(tool),
    kind: inferToolKind(tool),
    outputLabel: tool.status === "failed" ? "Error" : "Output",
    outputType: typeof tool.output === "string" ? "text" : "json",
    hasInput: tool.input !== undefined,
    hasOutput: tool.output !== undefined,
    ...(includeSizes
      ? {
          inputSize: getJsonSize(tool.input),
          outputSize: getJsonSize(tool.output),
        }
      : {}),
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
