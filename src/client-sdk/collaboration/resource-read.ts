/**
 * Shared collection, section and lossless content representations.
 *
 * Authorization and host selection precede this service. Cursors identify a
 * user, filtered source and revision; they never grant access to that source.
 */
import { z } from "zod";
import type { ContentPart, Page, ResourceReadOptions } from "@/contracts/schemas/resource-read";
import { DomainError } from "../../domain/domain-error";
import { decodeUtf8Base64Url, encodeJsonBase64Url, utf8ByteLength } from "@/shared/encoding";
import { sha256Text } from "@/shared/hash";
import { isReadRecord } from "@/shared/record";

export { isReadRecord } from "@/shared/record";

export const DEFAULT_READ_BYTES = 4096;
const DEFAULT_READ_LIMIT = 20;
const CursorSchema = z.object({
  v: z.literal(1),
  scope: z.string(),
  revision: z.string(),
  position: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
}).strict();
export type ReadCursor = z.infer<typeof CursorSchema>;

export function readBytes(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value) ?? "null");
}

export function readRevision(value: unknown): string {
  return sha256Text(JSON.stringify(value) ?? "null");
}

export function readScope(ownerId: string, url: URL, inputIdentity?: unknown): string {
  const scope = new URL(url);
  for (const key of ["cursor", "maxBytes", "limit"]) scope.searchParams.delete(key);
  scope.searchParams.sort();
  return readRevision([ownerId, scope.pathname, scope.search, inputIdentity ?? null]);
}

export function encodeReadCursor(cursor: ReadCursor): string {
  return encodeJsonBase64Url(cursor);
}

export function decodeReadCursor(input: {
  cursor?: string; scope: string; revision: string | ((cursor: ReadCursor) => string);
}): ReadCursor {
  const revision = (cursor: ReadCursor): string => typeof input.revision === "string" ? input.revision : input.revision(cursor);
  if (!input.cursor) {
    const initial: ReadCursor = { v: 1, scope: input.scope, revision: "", position: 0, offset: 0 };
    return { ...initial, revision: revision(initial) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8Base64Url(input.cursor));
  } catch (cause) {
    throw new DomainError("read_cursor_invalid", "Invalid read cursor.", { cause });
  }
  const result = CursorSchema.safeParse(parsed);
  if (!result.success || result.data.scope !== input.scope) {
    throw new DomainError("read_cursor_invalid", "The cursor does not identify this user's filtered read.");
  }
  if (result.data.revision !== revision(result.data)) {
    throw new DomainError("read_cursor_stale", "The source changed. Restart this read without a cursor.");
  }
  return result.data;
}

export function fitReadText(text: string, fits: (part: string) => boolean): string {
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, middle))) low = middle;
    else high = middle - 1;
  }
  if (low && low < text.length && /[\uD800-\uDBFF]/u.test(text[low - 1]!)) low--;
  return text.slice(0, low);
}

const SUMMARY_FIELDS = [
  "id", "name", "title", "description", "creator", "workspaceId", "taskId", "chatId",
  "agentId", "runId", "providerId", "modelId", "displayName", "kind", "type",
  "status", "createdAt", "updatedAt", "lastActivityAt", "startedAt", "completedAt",
  "directory", "resolvedDirectory", "targetDirectory", "workspaceAction",
  "currentStep", "currentIteration", "branch", "path", "size", "isDirectory",
  "connected", "enabled", "available", "ready", "paused", "blocking", "requestId",
  "permissionId", "responseMode", "backend", "ref", "executionHost", "transport",
  "model", "error", "success", "url", "port", "hostname", "username",
  "contextWindow", "supportsVision", "supportsTools", "reasoning", "stage",
  "providerID", "modelID", "providerName", "modelName", "variant", "variants",
  "lastRunAt", "nextRunAt", "activeRunId", "lastError", "source", "scope",
  "connectionStatus", "startupStage", "hasMessages", "hasTranscript",
  "repositoriesBasePath", "address", "endpoint", "platform", "capabilities",
  "preferredModel", "accessRequirement", "revision", "configurationRevision",
  "current", "remote", "file", "changeType", "additions", "deletions", "number",
  "provider", "installed", "supported", "valid", "usable", "executionHostId",
  "canStop", "parentId", "principalProcessing", "mode", "loadOnExpand",
  "timestamp", "text", "step", "commentText", "reviewCycle", "addressedAt",
  "ownership", "workspaceWrites", "requestedModel", "effectiveModel", "lastActivity",
] as const;

function pendingCount(value: unknown): number {
  return Array.isArray(value) ? value.filter((item: unknown) => !isReadRecord(item)
    || !["answered", "approved", "denied", "cancelled", "expired", "completed", "delivered", "rejected"].includes(String(item["status"]))).length : 0;
}

export function compactResource(value: unknown): unknown {
  if (!isReadRecord(value)) return value;
  const config = isReadRecord(value["config"]) ? value["config"]
    : isReadRecord(value["configSnapshot"]) ? value["configSnapshot"] : value;
  const state = isReadRecord(value["state"]) ? value["state"] : value;
  const summary: Record<string, unknown> = {};
  for (const field of SUMMARY_FIELDS) {
    const entry = state[field] ?? config[field];
    if (entry !== undefined && readBytes(entry) <= 512) summary[field] = entry;
  }
  const harness = isReadRecord(state["harness"]) ? state["harness"] : undefined;
  if (harness?.["integrity"] === "invalid") {
    summary["stateUnavailable"] = true;
  } else if (harness || state["pendingPermissionRequests"] || state["planMode"]) {
    const plan = isReadRecord(state["planMode"]) ? state["planMode"] : undefined;
    const planApproval = state["status"] === "planning" && plan?.["isPlanReady"] === true && config["autoAcceptPlan"] === false;
    summary["needsInput"] = pendingCount(harness?.["questions"]) > 0 || pendingCount(state["pendingPermissionRequests"]) > 0 || planApproval;
    summary["interventionReasons"] = [
      ...(pendingCount(harness?.["questions"]) ? ["question"] : []),
      ...(pendingCount(state["pendingPermissionRequests"]) ? ["permission"] : []),
      ...(planApproval ? ["plan_approval"] : []),
    ];
    summary["pendingQuestions"] = pendingCount(harness?.["questions"]);
    summary["pendingPermissions"] = pendingCount(state["pendingPermissionRequests"]);
    summary["pendingInputs"] = Array.isArray(harness?.["inputs"])
      ? harness["inputs"].filter((item: unknown) => isReadRecord(item)
        && isReadRecord(item["admission"]) && !["delivered", "rejected"].includes(String(item["admission"]["status"]))).length : 0;
  }
  const source = isReadRecord(config["source"]) ? config["source"] : undefined;
  const binding = isReadRecord(source?.["executionHost"]) ? source["executionHost"] : undefined;
  if (source?.["kind"] === "execution_host" && binding) {
    summary["source"] = { kind: "execution_host", host: binding["host"], directory: source["directory"] };
  }
  // Every projected row has an explicit route back to its original details.
  summary["details"] = { section: "details", item: resourceKey(value) };
  return summary;
}

export function resourceKey(value: unknown): string {
  const record = isReadRecord(value) ? value : undefined;
  const config = isReadRecord(record?.["config"]) ? record["config"] : record;
  const identity = config?.["id"] ?? config?.["requestId"] ?? config?.["permissionId"]
    ?? (config?.["modelID"] ? [config["providerID"], config["modelID"]] : undefined)
    ?? config?.["path"] ?? config?.["name"] ?? config?.["ref"] ?? value;
  return readRevision(identity);
}

export function fitCompactMetadata(value: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  if (readBytes(value) <= maxBytes) return value;
  const result: Record<string, unknown> = { details: value["details"], code: "read_item_requires_details" };
  const priority = ["id", "status", "needsInput", "interventionReasons", "stateUnavailable", "pendingQuestions", "pendingPermissions", "pendingInputs", "name", "workspaceId"];
  for (const key of [...priority, ...Object.keys(value).filter((key) => !priority.includes(key) && key !== "details")]) {
    if (value[key] !== undefined && readBytes({ ...result, [key]: value[key] }) <= maxBytes) result[key] = value[key];
  }
  return result;
}

const COLLECTION_SECTIONS = [
  "items", "jobs", "runs", "agents", "models", "providers", "files", "directories",
  "entries", "branches", "templates", "addresses", "sessions", "servers",
  "workspaces", "chats", "tasks", "workers", "enrollments", "questions", "permissions",
  "inputs", "activity", "activities", "variants", "previews", "nodes", "grants", "candidates", "issues",
  "comments", "logs",
] as const;

function sectionValue(value: unknown, options: ResourceReadOptions): unknown {
  if (!options.section || options.section === "details") return value;
  if (!isReadRecord(value)) throw new DomainError("read_section_unavailable", "This read has no requested section.");
  const state = isReadRecord(value["state"]) ? value["state"] : value;
  const config = isReadRecord(value["config"]) ? value["config"] : value;
  const runConfig = isReadRecord(value["configSnapshot"]) ? value["configSnapshot"] : config;
  if (options.section === "entries" && isReadRecord(value["entriesByDirectory"])) {
    return treeEntries(value["entriesByDirectory"]);
  }
  const harness = isReadRecord(state["harness"]) ? state["harness"] : undefined;
  const activity = isReadRecord(value["activity"]) ? value["activity"]
    : isReadRecord(harness?.["activity"]) ? harness["activity"] : undefined;
  const selected = options.section === "permissions" ? state["pendingPermissionRequests"] ?? value["permissions"]
    : options.section === "prompt" ? runConfig["prompt"]
      : value[options.section] ?? state[options.section] ?? harness?.[options.section] ?? activity?.[options.section];
  if (selected === undefined) throw new DomainError("read_section_unavailable", "This read has no requested section.");
  return selected;
}

function treeEntries(value: Record<string, unknown>): unknown[] {
  return Object.values(value).flatMap((entries: unknown) => {
    if (!Array.isArray(entries)) throw new DomainError("read_source_invalid", "The file tree has an unreadable directory.");
    return entries;
  });
}

export function collectionReadPage(input: {
  source: readonly unknown[]; options: ResourceReadOptions; scope: string; project?: (value: unknown) => unknown;
  startPosition?: number; totalCount?: number; revision?: string; context?: Record<string, unknown>;
  keys?: readonly string[];
}): Page<unknown> {
  const keys = input.keys ?? input.source.map(resourceKey);
  const revision = input.revision ?? readRevision(keys);
  const cursor = decodeReadCursor({ ...input.options, scope: input.scope, revision });
  const items: unknown[] = [];
  const limit = input.options.limit ?? DEFAULT_READ_LIMIT;
  const maxBytes = input.options.maxBytes ?? DEFAULT_READ_BYTES;
  let position = cursor.position;
  const start = input.startPosition ?? 0;
  const total = input.totalCount ?? input.source.length;
  if (position < start || position > total || cursor.offset) throw new DomainError("read_cursor_invalid", "Invalid collection position.");
  const page = (next: number): Page<unknown> => ({
    items,
    nextCursor: next < total
      ? encodeReadCursor({ ...cursor, position: next, offset: 0 }) : null,
    ...(input.context ? { context: input.context } : {}),
  });
  while (position < start + input.source.length && items.length < limit) {
    const value = input.source[position - start];
    let projected = input.project ? input.project(value) : value;
    if (isReadRecord(projected) && isReadRecord(projected["details"]) && input.options.section) {
      projected = { ...projected, details: { ...projected["details"], section: input.options.section } };
    }
    items.push(projected);
    if (readBytes(page(position + 1)) > maxBytes) {
      items.pop();
      if (items.length) break;
      const details = isReadRecord(projected) && isReadRecord(projected["details"]) ? projected["details"]
        : { section: input.options.section ?? "details", item: keys[position - start] };
      projected = { details, code: "read_item_requires_details" };
      items.push(projected);
      if (readBytes(page(position + 1)) > maxBytes) throw new DomainError("read_budget_too_small", "Increase maxBytes for this page.");
    }
    position++;
  }
  return page(position);
}

function* contentLeaves(value: unknown, path: Array<string | number> = []): Generator<{ path: Array<string | number>; value: unknown }> {
  if (Array.isArray(value) && value.length) {
    for (const [index, entry] of value.entries()) yield* contentLeaves(entry, [...path, index]);
  } else if (isReadRecord(value) && Object.keys(value).length) {
    for (const [key, entry] of Object.entries(value)) yield* contentLeaves(entry, [...path, key]);
  } else {
    yield { path, value };
  }
}

export function contentReadPage(input: {
  source: unknown; options: ResourceReadOptions; scope: string; revision?: string;
}): Page<ContentPart> {
  const cursor = decodeReadCursor({
    ...input.options, scope: input.scope, revision: input.revision ?? readRevision(input.source),
  });
  const items: ContentPart[] = [];
  const limit = input.options.limit ?? DEFAULT_READ_LIMIT;
  const maxBytes = input.options.maxBytes ?? DEFAULT_READ_BYTES;
  let position = cursor.position, offset = cursor.offset, index = 0, hasMore = false;
  const page = (more: boolean): Page<ContentPart> => ({
    items, nextCursor: more ? encodeReadCursor({ ...cursor, position, offset }) : null,
  });
  for (const leaf of contentLeaves(input.source)) {
    if (index++ < cursor.position) continue;
    hasMore = true;
    if (items.length >= limit) break;
    if (typeof leaf.value !== "string" && offset) throw new DomainError("read_cursor_invalid", "Invalid content offset.");
    const text = typeof leaf.value === "string" ? leaf.value.slice(offset) : undefined;
    if (typeof leaf.value === "string" && (offset > leaf.value.length
      || offset && /[\uD800-\uDBFF]/u.test(leaf.value[offset - 1]!))) {
      throw new DomainError("read_cursor_invalid", "Invalid content offset.");
    }
    const part: ContentPart = { ...leaf, offset, complete: true };
    if (text !== undefined) part.value = text;
    items.push(part);
    if (readBytes({ items, nextCursor: encodeReadCursor({ ...cursor, position: position + 1, offset: 0 }) }) > maxBytes) {
      if (text === undefined) {
        items.pop();
        if (!items.length) throw new DomainError("read_budget_too_small", "Increase maxBytes for this content.");
        break;
      }
      const fitted = fitReadText(text, (chunk) => {
        part.value = chunk;
        part.complete = chunk.length === text.length;
        return readBytes({ items, nextCursor: encodeReadCursor({
          ...cursor, position: part.complete ? position + 1 : position,
          offset: part.complete ? 0 : offset + chunk.length,
        }) }) <= maxBytes;
      });
      if (!fitted.length && text.length) {
        items.pop();
        if (!items.length) throw new DomainError("read_budget_too_small", "Increase maxBytes for this content.");
        break;
      }
      part.value = fitted;
      part.complete = fitted.length === text.length;
      if (!part.complete) { offset += fitted.length; break; }
    }
    position++;
    offset = 0;
    hasMore = false;
  }
  if (position > index) throw new DomainError("read_cursor_invalid", "Invalid content position.");
  return page(hasMore);
}

export function readResourceRepresentation(input: {
  source: unknown; options: ResourceReadOptions; scope: string;
}): unknown {
  let source = input.source;
  if (input.options.section && input.options.section !== "details") source = sectionValue(source, input.options);
  if (isReadRecord(source) && isReadRecord(source["activity"])
    && Array.isArray(source["activity"]["activities"])
    && (input.options.section !== "details" || input.options.item)) {
    source = source["activity"];
  }
  if (input.options.item) {
    const record = isReadRecord(source) ? source : undefined;
    const collection = Array.isArray(source) ? source : record
      ? COLLECTION_SECTIONS.flatMap((key) => Array.isArray(record[key]) ? record[key] : []) : [];
    source = collection.find((item: unknown) => resourceKey(item) === input.options.item);
    if (source === undefined) {
      // An item response's own reference can also be used without a collection.
      if (resourceKey(input.source) !== input.options.item) throw new DomainError("read_item_unavailable", "The selected item is unavailable.");
      source = input.source;
    }
  }
  if (input.options.section && ["details", "prompt", "content", "output", "plan", "diff"].includes(input.options.section)
    || input.options.item) {
    return contentReadPage({ ...input, source });
  }
  if (Array.isArray(source)) {
    return collectionReadPage({ ...input, source, project: compactResource });
  }
  if (isReadRecord(source)) {
    const record = source;
    const collections = COLLECTION_SECTIONS.filter((key) => Array.isArray(record[key]));
    const context = Object.fromEntries([
      "workspaceId", "serverId", "directory", "rootDirectory", "available", "supported",
      "coverage", "truncated", "currentBranch", "defaultBranch", "error", "total", "totalCount",
      "hasMore", "epoch", "instanceId", "role", "observerCoverage", "principalProcessing",
      "observation", "observedAt", "reason",
    ].filter((key) => record[key] !== undefined && readBytes(record[key]) <= 512).map((key) => [key, record[key]]));
    if (isReadRecord(record["entriesByDirectory"])) {
      return collectionReadPage({
        ...input, source: treeEntries(record["entriesByDirectory"]), context,
        project: (entry) => {
          const row = compactResource(entry);
          return {
            ...(isReadRecord(row) ? row : { value: row }),
            details: { section: "entries", item: resourceKey(entry) },
          };
        },
      });
    }
    if (collections.length === 1) {
      const collection = record[collections[0]!];
      if (Array.isArray(collection)) return collectionReadPage({
        ...input, source: collection, project: compactResource,
        ...(Object.keys(context).length ? { context } : {}),
      });
    }
    if (collections.length > 1) {
      const entries = collections.flatMap((section) => {
        const value = record[section];
        return Array.isArray(value) ? value.map((item: unknown) => ({ section, item })) : [];
      });
      return collectionReadPage({
        ...input, source: entries,
        ...(Object.keys(context).length ? { context } : {}),
        keys: entries.map(({ section, item }) => readRevision([section, resourceKey(item)])),
        project: (value) => {
          if (!isReadRecord(value)) throw new Error("Invalid grouped collection entry.");
          const row = compactResource(value["item"]);
          return {
            ...(isReadRecord(row) ? row : { value: row }), collection: value["section"],
            details: { section: value["section"], item: resourceKey(value["item"]) },
          };
        },
      });
    }
    if (isReadRecord(source["config"]) && isReadRecord(source["state"])
      || typeof source["id"] === "string") {
      source = compactResource(source);
    } else if (isReadRecord(source["job"])) {
      source = compactResource(source["job"]);
    }
    if (isReadRecord(source) && isReadRecord(source["details"])) {
      if (input.options.cursor) throw new DomainError("read_cursor_invalid", "Metadata has no continuation. Read the details section.");
      return fitCompactMetadata(source, input.options.maxBytes ?? DEFAULT_READ_BYTES);
    }
  }
  if (!input.options.cursor && readBytes(source) <= (input.options.maxBytes ?? DEFAULT_READ_BYTES)) return source;
  return contentReadPage({ ...input, source });
}

export function readOperationReceipt(source: unknown, maxBytes: number): unknown {
  const projected = isReadRecord(source)
    ? typeof source["id"] === "string" || isReadRecord(source["config"]) && isReadRecord(source["state"])
      ? compactResource(source) : Object.fromEntries(Object.entries(source).map(([key, value]) => [
        key, ["job", "chat", "task", "run", "workspace", "server", "agent", "session", "preview"].includes(key)
          && isReadRecord(value) ? compactResource(value) : value,
      ])) : source;
  if (readBytes(projected) <= maxBytes) return projected;
  const summary = compactResource(source);
  const receipt = {
    ...(isReadRecord(summary) ? summary : {}),
    resultCode: "read_result_requires_targeted_read",
    dataAvailable: false,
    message: "The operation returned successfully, but its data exceeds this response budget. Inspect the target through a GET or the UI. Do not rerun the operation to retrieve its output.",
  };
  if (readBytes(receipt) <= maxBytes) return receipt;
  return {
    resultCode: "read_result_requires_targeted_read", dataAvailable: false,
    message: "The operation returned successfully. Inspect its target; do not rerun it to retrieve omitted output.",
  };
}
