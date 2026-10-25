/**
 * Direct bounded work overviews and literal latest conversation reads.
 */
import { DomainError } from "../domain/domain-error";
import { directItems, directRecord, LiveVoiceDirectContext } from "./live-voice-direct-context";
import type { DirectToolInput } from "./live-voice-direct-contracts";
import { isReadRecord, readBytes } from "../client-sdk/collaboration/resource-read";
import type { ChatStatus } from "@/shared/chat";
import type { TaskStatus } from "@/shared/task";

type VoiceStatusCategory = "active" | "idle" | "done" | "error";
type WorkKind = "chat" | "task";
const MIN_COLLECTION_PAGE_BYTES = 1024;
const VOICE_STATUS_PROPERTY_BYTES = readBytes({ voiceStatus: "active" }) + 1;

const CHAT_VOICE_STATUS: Record<ChatStatus, VoiceStatusCategory> = {
  idle: "idle",
  starting: "error",
  streaming: "active",
  waiting: "active",
  interrupting: "error",
  reconnecting: "error",
  stopped: "error",
  failed: "error",
  done: "done",
};

const TASK_VOICE_STATUS: Record<TaskStatus, VoiceStatusCategory> = {
  idle: "idle",
  draft: "idle",
  planning: "active",
  starting: "active",
  running: "active",
  waiting: "active",
  completed: "done",
  stopped: "error",
  failed: "error",
  max_iterations: "error",
  resolving_conflicts: "active",
  accepted_local: "done",
  merged: "done",
  pushed: "done",
  deleted: "done",
};

function voiceStatusCategory(
  kind: WorkKind,
  status: unknown,
): VoiceStatusCategory {
  if (typeof status !== "string") {
    throw new DomainError("voice_operation_response", "The work item has no valid status.");
  }
  if (kind === "chat") {
    if (!Object.hasOwn(CHAT_VOICE_STATUS, status)) {
      throw new DomainError("voice_operation_response", "The chat has an unknown status.");
    }
    return CHAT_VOICE_STATUS[status as ChatStatus];
  }
  if (!Object.hasOwn(TASK_VOICE_STATUS, status)) {
    throw new DomainError("voice_operation_response", "The task has an unknown status.");
  }
  return TASK_VOICE_STATUS[status as TaskStatus];
}

function isDetailsOnly(item: Record<string, unknown>): boolean {
  return item["code"] === "read_item_requires_details" && isReadRecord(item["details"]);
}

function detailsOnly(item: Record<string, unknown>): Record<string, unknown> | null {
  if (isDetailsOnly(item)) return item;
  return isReadRecord(item["details"])
    ? { details: item["details"], code: "read_item_requires_details" }
    : null;
}

function withVoiceStatus(
  kind: WorkKind,
  item: Record<string, unknown>,
): Record<string, unknown> {
  if (isDetailsOnly(item)) return item;
  return { ...item, voiceStatus: voiceStatusCategory(kind, item["status"]) };
}

function statusAwarePageOptions(
  maxBytes: number,
  requestedLimit: number,
): { limit: number; maxBytes: number } {
  const statusCapacity = Math.max(
    1,
    Math.floor(Math.max(0, maxBytes - MIN_COLLECTION_PAGE_BYTES) / VOICE_STATUS_PROPERTY_BYTES),
  );
  const limit = Math.min(requestedLimit, statusCapacity);
  return {
    limit,
    maxBytes: Math.max(MIN_COLLECTION_PAGE_BYTES, maxBytes - limit * VOICE_STATUS_PROPERTY_BYTES),
  };
}

function fitVoiceStatusPage(
  page: Record<string, unknown>,
  kind: WorkKind,
  maxBytes: number,
): Record<string, unknown> {
  const items = directItems(page).map((item) => withVoiceStatus(kind, item));
  const result = () => ({ ...page, items });
  if (readBytes(result()) <= maxBytes) return result();
  for (let index = 0; index < items.length; index++) {
    const fallback = detailsOnly(items[index]!);
    if (fallback) items[index] = fallback;
    if (readBytes(result()) <= maxBytes) return result();
  }
  throw new DomainError(
    "voice_direct_result_too_large",
    "The work page exceeds the Voice response budget; request a smaller page or read a targeted item.",
  );
}

export function pendingInteractions(value: unknown): Record<string, unknown>[] {
  const entity = directRecord(value);
  const state = directRecord(entity["state"]);
  const harness = state["harness"];
  const questions = harness && typeof harness === "object" && !Array.isArray(harness)
    ? directRecord(harness)["questions"] : undefined;
  const permissions = state["pendingPermissionRequests"];
  return [
    ...(Array.isArray(questions) ? questions.filter((question: unknown) => {
      const row = directRecord(question);
      return ["pending", "queued", "submitting", "unconfirmed"].includes(String(row["status"]));
    }).map((question: unknown) => ({ ...directRecord(question), kind: "question" })) : []),
    ...(Array.isArray(permissions) ? permissions.filter((permission: unknown) => directRecord(permission)["status"] === "pending")
      .map((permission: unknown) => ({ ...directRecord(permission), kind: "permission" })) : []),
  ];
}

export async function directList(
  context: LiveVoiceDirectContext, kind: "chat" | "task",
  input: DirectToolInput<"clanky_list_chats">,
): Promise<unknown> {
  const workspaceId = input.workspace ? String((await context.resolve("workspace", input.workspace))["id"]) : null;
  const pageOptions = statusAwarePageOptions(context.options.maxBytes, input.limit ?? 8);
  const page = directRecord(await context.read({
    operationId: `GET /api/${kind}s`,
    query: {
      order: "activity", limit: pageOptions.limit,
      ...(workspaceId ? { workspaceId } : {}), ...(input.name ? { name: input.name } : {}),
      ...(input.status ? { status: input.status } : {}), ...(input.cursor ? { cursor: input.cursor } : {}),
    },
    maxBytes: pageOptions.maxBytes,
  }));
  return fitVoiceStatusPage(page, kind, context.options.maxBytes);
}

export async function directRead(
  context: LiveVoiceDirectContext, kind: "chat" | "task",
  input: DirectToolInput<"clanky_read_task"> | DirectToolInput<"clanky_read_chat">,
): Promise<unknown> {
  const target = withVoiceStatus(kind, await context.resolve(kind, input.target, input.workspace));
  const id = String(target["id"]);
  const section = "section" in input ? input.section : "conversation";
  const budget = Math.max(1024, context.options.maxBytes - readBytes(target) - 1200);
  const content = await context.read({
    operationId: section === "conversation" ? `GET /api/${kind}s/:id/snapshot`
      : section === "prompt" ? "GET /api/tasks/:id" : `GET /api/tasks/:id/${section}`,
    parameters: { id },
    query: {
      ...(section === "conversation" ? { view: "conversation", range: input.range, limit: input.limit ?? 6 }
        : { section: section === "prompt" ? "prompt" : "details" }),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    },
    maxBytes: budget,
  });
  const interactions = target["needsInput"] && kind === "chat"
    ? pendingInteractions(await context.readExact("GET /api/chats/:id", { id })) : [];
  return context.bounded({ target, interactions, section, content });
}

type OverviewCursor = { chat: string | null; task: string | null; scope: string; completed: string[] };

function overviewCursor(cursor: string | null, scope: string): OverviewCursor | null {
  if (!cursor) return null;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString()); }
  catch (cause) { throw new DomainError("read_cursor_invalid", "Invalid overview cursor.", { cause }); }
  const record = directRecord(value);
  if (record["scope"] !== scope || !Array.isArray(record["completed"])
    || !record["completed"].every((kind: unknown) => kind === "chat" || kind === "task")
    || !["chat", "task"].every((key) => record[key] === null || typeof record[key] === "string")) {
    throw new DomainError("read_cursor_invalid", "This cursor belongs to a different overview.");
  }
  return { scope, chat: record["chat"] as string | null, task: record["task"] as string | null, completed: record["completed"] as string[] };
}

export async function directOverview(
  context: LiveVoiceDirectContext, waiting: boolean,
  input: DirectToolInput<"clanky_recent_work"> | DirectToolInput<"clanky_waiting_work">,
): Promise<unknown> {
  const workspaceId = input.workspace ? String((await context.resolve("workspace", input.workspace))["id"]) : null;
  const status = "status" in input ? input.status : null;
  const scope = JSON.stringify({ waiting, kind: input.kind, workspaceId, status });
  const previous = overviewCursor(input.cursor, scope);
  const continuation: OverviewCursor = previous ?? { chat: null, task: null, scope, completed: [] };
  const kinds = input.kind === "all" ? ["chat", "task"] as const : [input.kind];
  const entries: Record<string, unknown>[] = [];
  const coverage: Record<string, unknown>[] = [];
  const requestedLimit = input.limit ?? 3;
  const pageBudget = Math.max(1024, Math.floor((context.options.maxBytes - 700) / (2 * kinds.length)));
  const pageOptions = statusAwarePageOptions(pageBudget, requestedLimit);
  for (const kind of kinds) {
    if (continuation.completed.includes(kind)) continue;
    const page = fitVoiceStatusPage(directRecord(await context.read({
      operationId: `GET /api/${kind}s`,
      query: {
        order: "activity", limit: pageOptions.limit,
        ...(workspaceId ? { workspaceId } : {}), ...(status ? { status } : {}),
        ...(waiting ? { needsInput: "true" } : {}),
        ...(continuation[kind] ? { cursor: continuation[kind]! } : {}),
      }, maxBytes: pageOptions.maxBytes,
    })), kind, pageBudget);
    continuation[kind] = typeof page["nextCursor"] === "string" ? page["nextCursor"] : null;
    if (!continuation[kind]) continuation.completed.push(kind);
    const items = directItems(page);
    coverage.push({ kind, selectionComplete: page["nextCursor"] === null });
    for (const target of items) entries.push({ kind, ...target });
  }

  entries.sort((a, b) => String(b["lastActivityAt"]).localeCompare(String(a["lastActivityAt"])));
  const complete = kinds.every((kind) => continuation.completed.includes(kind));
  const nextCursor = complete ? null : Buffer.from(JSON.stringify(continuation)).toString("base64url");
  const result = () => ({
    entries, coverage, complete, nextCursor,
    ordering: "activity_descending_within_each_source_page",
    limitPerKind: pageOptions.limit,
  });
  while (readBytes(result()) > context.options.maxBytes) {
    const index = entries.findIndex((entry) => !isDetailsOnly(entry) && isReadRecord(entry["details"]));
    if (index < 0) {
      throw new DomainError("voice_direct_result_too_large", "The work overview exceeds the Voice response budget.");
    }
    const entry = entries[index]!;
    entries[index] = { kind: String(entry["kind"]), ...detailsOnly(entry)! };
  }
  let remaining = context.options.maxBytes - readBytes(result()) - 700;
  for (const [index, target] of entries.entries()) {
    if (isDetailsOnly(target)) continue;
    const id = String(target["id"]), kind = String(target["kind"]);
    const budget = Math.floor(remaining / (entries.length - index));
    if (budget < 1024 || target["stateUnavailable"]) {
      target["preview"] = { available: false, reason: target["stateUnavailable"] ? "state_unavailable" : "response_budget", target: id };
      if (readBytes(result()) > context.options.maxBytes) delete target["preview"];
      continue;
    }
    const preview = waiting && kind === "chat"
      ? { interactions: pendingInteractions(await context.readExact("GET /api/chats/:id", { id })) }
      : await context.read({
        operationId: `GET /api/${kind}s/:id/snapshot`, parameters: { id },
        query: { view: "conversation", range: "latest", limit: 2 }, maxBytes: budget,
      });
    if (readBytes(preview) <= budget) {
      target["preview"] = preview;
      if (readBytes(result()) <= context.options.maxBytes) {
        remaining -= readBytes(preview);
        continue;
      }
    }
    target["preview"] = { available: false, reason: "response_budget", target: id };
    if (readBytes(result()) > context.options.maxBytes) {
      delete target["preview"];
    }
  }
  return context.bounded(result());
}

export async function directServers(context: LiveVoiceDirectContext, input: DirectToolInput<"clanky_list_servers">): Promise<unknown> {
  const operations = { servers: "GET /api/ssh-servers", hosts: "GET /api/execution-hosts" };
  if (input.kind !== "all") return await context.read({
    operationId: operations[input.kind],
    query: { limit: input.limit ?? 10, ...(input.cursor ? { cursor: input.cursor } : {}) },
  });
  let previous: Record<string, unknown> | null = null;
  if (input.cursor) {
    try { previous = directRecord(JSON.parse(Buffer.from(input.cursor, "base64url").toString())); }
    catch (cause) { throw new DomainError("read_cursor_invalid", "Invalid combined server cursor.", { cause }); }
    if (previous["kind"] !== "all" || !["servers", "hosts"].every((key) => previous![key] === null || typeof previous![key] === "string")) {
      throw new DomainError("read_cursor_invalid", "This cursor belongs to a different server selection.");
    }
  }
  const result: Record<string, unknown> = {};
  const next: Record<string, unknown> = { kind: "all" };
  for (const [kind, operationId] of Object.entries(operations)) {
    if (previous && previous[kind] === null) {
      result[kind] = { items: [], nextCursor: null };
      next[kind] = null;
      continue;
    }
    const page = directRecord(await context.read({
      operationId, query: { limit: input.limit ?? 8, ...(previous ? { cursor: String(previous[kind]) } : {}) },
      maxBytes: Math.max(1024, Math.floor((context.options.maxBytes - 700) / 2)),
    }));
    result[kind] = page;
    next[kind] = page["nextCursor"];
  }
  const complete = next["servers"] === null && next["hosts"] === null;
  return context.bounded({
    ...result, complete, nextCursor: complete ? null : Buffer.from(JSON.stringify(next)).toString("base64url"),
  });
}
