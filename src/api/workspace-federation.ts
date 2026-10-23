/**
 * One API surface for local and granted controller resources, with no replica.
 */
import {
  createLogger, resolveRouteOperationMetadata,
  type RouteDefinition, type RouteTable, type RouteDelegationMetadata,
} from "@pablozaiden/webapp/server";
import {
  decodeCollaborationResourceReference,
  encodeCollaborationResourceReference,
} from "@/shared/collaboration-reference";
import { MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES } from "@/shared/message-attachments";
import { CreateChatRequestSchema } from "@/contracts/schemas";
import { ChatTrashPageSchema, ChatTrashQuerySchema, type ChatTrashPage } from "@/contracts/schemas/chat-trash";
import { mergeChatTrashPages, trashCursorForSource } from "../core/chat-trash-pagination";
import { preferencesManager } from "../core/preferences-manager";
import { DomainError, isDomainError } from "../domain/domain-error";
import { workspaceConnections } from "../core/workspace-connections";
import { qualifyWorkspaceResponse } from "../core/workspace-source-response";
import { compactResource, isReadRecord, readBytes } from "../core/resource-read-service";
import { readWorkspaceRequestBytes } from "./workspace-client-request";
import { workspaceClientErrorResponse } from "./workspace-client-errors";
import { workspaceJsonResponseStream } from "./workspace-source-stream";
import {
  createWorkspaceUrlQualifier, resolveWorkspaceSource, workspaceOperationPath,
  type WorkspaceSourceRequest,
} from "./workspace-source-routing";

const log = createLogger("api:workspace-federation");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const VIEW_OPTIONS = ["view", "cursor", "limit", "maxBytes", "section", "item"];
const MAX_COLLECTION_BYTES = 16 * 1_024 * 1_024;

async function jsonResponse(response: Response, maxBytes = MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES): Promise<unknown> {
  const bytes = await readWorkspaceRequestBytes(response, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new DomainError("collaboration_response_invalid", "The controller response is invalid.", { cause: error });
  }
}

async function requestBody(request: Request): Promise<unknown> {
  if (!request.body || !request.headers.get("content-type")?.startsWith("application/json")) return undefined;
  const bytes = await readWorkspaceRequestBytes(request.clone(), MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new DomainError("collaboration_request_invalid", "A valid JSON operation body is required.", { cause: error });
  }
}

function stripReadView(url: URL): URL {
  const result = new URL(url);
  if (result.searchParams.get("view") === "conversation") return result;
  for (const key of VIEW_OPTIONS) result.searchParams.delete(key);
  return result;
}

async function forwardWorkspaceOperation(input: {
  connectionId: string;
  source: WorkspaceSourceRequest;
  request: Request;
  path: string;
  method: typeof METHODS[number];
  delegation: RouteDelegationMetadata;
  signal?: AbortSignal;
  qualifyUrl(connectionId: string, path: string): string;
}): Promise<Response> {
  const { connectionId, source, request, delegation } = input;
  const runtime = workspaceConnections.require(connectionId);
  if (input.path === "/api/chats" && input.method === "POST"
    && isReadRecord(source.body) && source.body["quick"] === true) {
    const parsed = CreateChatRequestSchema.safeParse(source.body);
    if (!parsed.success) throw new DomainError("collaboration_request_invalid", "The quick-chat request is invalid.");
    try {
      await preferencesManager.validateQuickChatModel({
        workspaceId: encodeCollaborationResourceReference({
          connectionId, resourceKind: "workspace", resourceId: parsed.data.workspaceId,
        }),
        model: parsed.data.model,
      });
    } catch (error) {
      return workspaceClientErrorResponse(error, "chats");
    }
  }
  const innerUrl = delegation.action === "trash-list" ? new URL(source.url) : stripReadView(source.url);
  const cursor = innerUrl.searchParams.get("cursor");
  if (delegation.action === "trash-list" && cursor) {
    innerUrl.searchParams.set("cursor", trashCursorForSource(cursor, connectionId));
  }
  const body = source.body === undefined ? request.body : JSON.stringify(source.body);
  const deadline = new AbortController();
  const timeout = request.method === "GET" || request.method === "HEAD"
    ? setTimeout(() => deadline.abort(), 20_000) : undefined;
  try {
    const response = await runtime.client.request({
      kind: "operation",
      method: request.method === "HEAD" ? "HEAD" : input.method,
      path: workspaceOperationPath(input.path, source.params, innerUrl),
      headers: request.headers, body,
      ...(typeof body === "string" || body === null && request.headers.get("content-type")?.startsWith("application/json") ? {
        bodySha256: new Bun.CryptoHasher("sha256").update(body ?? "").digest("hex"),
      } : {}),
      signal: AbortSignal.any([request.signal, deadline.signal, ...(input.signal ? [input.signal] : [])]),
    });
    const headers = new Headers(response.headers);
    headers.delete("set-cookie");
    headers.set("cache-control", "private, no-store");
    const generationChat = headers.get("X-Clanky-Generation-Chat-Id");
    if (generationChat) {
      headers.set("X-Clanky-Generation-Chat-Id", encodeCollaborationResourceReference({
        connectionId, resourceKind: "chat", resourceId: generationChat,
      }));
    }
    if (!response.ok || response.status === 204 || request.method === "HEAD"
      || !headers.get("content-type")?.includes("application/json")) {
      return new Response(response.body, { status: response.status, headers });
    }
    const qualify = (value: unknown) => qualifyWorkspaceResponse(value, {
      resource: delegation.resource,
      controllerName: runtime.connection.name ?? "Shared controller",
      qualify: (resourceKind, resourceId) => encodeCollaborationResourceReference({
        connectionId, resourceKind, resourceId,
      }),
      qualifyUrl: (value) => input.qualifyUrl(connectionId, value),
    });
    for (const name of ["content-length", "content-encoding", "etag", "X-Clanky-Read-View"]) headers.delete(name);
    if (headers.get("X-Accel-Buffering") === "no" && response.body) {
      return new Response(response.body.pipeThrough(workspaceJsonResponseStream({
        maxBytes: MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES, qualify,
        failed: () => log.error("The shared JSON response stream failed", { connectionId }),
      })), { status: response.status, headers });
    }
    return Response.json(qualify(await jsonResponse(response,
      delegation.collection ? Math.min(MAX_COLLECTION_BYTES, MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES) : MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES)),
    { status: response.status, headers });
  } finally {
    // Only opening/JSON recovery is bounded here; file bodies retain their stream lifetime.
    if (timeout) clearTimeout(timeout);
  }
}

function filterCollection(source: unknown[], url: URL): unknown[] {
  const name = url.searchParams.get("name")?.toLocaleLowerCase();
  const status = url.searchParams.get("status");
  const needsInput = url.searchParams.get("needsInput");
  const result = source.filter((value) => {
    const metadata = compactResource(value);
    if (!isReadRecord(metadata)) return true;
    return (!name || String(metadata["name"]).toLocaleLowerCase() === name)
      && (!status || metadata["status"] === status)
      && (!needsInput || Boolean(metadata["needsInput"]) === (needsInput === "true"));
  });
  if (url.searchParams.get("view") === "compact") {
    const order = url.searchParams.get("order") === "activity" ? "lastActivityAt" : "createdAt";
    result.sort((left, right) => {
      const a = compactResource(left), b = compactResource(right);
      if (!isReadRecord(a) || !isReadRecord(b)) return 0;
      return String(b[order] ?? "").localeCompare(String(a[order] ?? ""))
        || String(b["id"] ?? "").localeCompare(String(a["id"] ?? ""));
    });
  }
  return result;
}

export function withUnifiedWorkspaceResources(routes: RouteTable): RouteTable {
  const qualifyUrl = createWorkspaceUrlQualifier(routes);
  return Object.fromEntries(Object.entries(routes).map(([path, route]) => {
    const next: RouteDefinition = { ...route };
    for (const method of METHODS) {
      const handler = route[method];
      if (!handler) continue;
      const delegation = resolveRouteOperationMetadata(route, method).delegation;
      next[method] = async (request, ctx) => {
        if (ctx.delegation) return await handler(request, ctx);
        try {
          const url = new URL(request.url);
          if (!delegation) {
            if (Object.values(ctx.params).some((value) => decodeCollaborationResourceReference(value))
              || ["workspaceId", "taskId", "chatId", "agentId"].some((field) => {
                const value = url.searchParams.get(field);
                return value ? decodeCollaborationResourceReference(value) : false;
              })) {
              throw new DomainError("collaboration_operation_forbidden", "This operation cannot target a shared workspace.");
            }
            return await handler(request, ctx);
          }
          const resolved = resolveWorkspaceSource({
            params: ctx.params, url, body: await requestBody(request), delegation,
          });
          const remote = async (connectionId: string, source: WorkspaceSourceRequest, signal?: AbortSignal): Promise<Response> => {
            return await forwardWorkspaceOperation({ connectionId, source, request, path, method, delegation, qualifyUrl, signal });
          };
          if (resolved.connectionId) return await remote(resolved.connectionId, resolved);
          const active = workspaceConnections.list().filter((item) => item.connection.status === "active");
          if (method !== "GET" || !delegation.collection || resolved.hasLocalReference || !active.length) {
            return await handler(request, ctx);
          }
          const localUrl = delegation.action === "trash-list" ? new URL(url) : stripReadView(url);
          const cursor = localUrl.searchParams.get("cursor");
          if (delegation.action === "trash-list" && cursor) {
            localUrl.searchParams.set("cursor", trashCursorForSource(cursor));
          }
          const localRequest = new Request(localUrl, request);
          const localResponse = await handler(localRequest, ctx);
          if (!localResponse?.ok) return localResponse;
          const local = await jsonResponse(localResponse);
          if (delegation.action === "trash-list") {
            const page = ChatTrashPageSchema.safeParse(local);
            if (!page.success) throw new DomainError("collaboration_response_invalid", "The local Trash page is invalid.");
            return await mergeCollections({
              source: page.data.items, trash: page.data, active, url, remote,
              resolved, headers: localResponse.headers, signal: request.signal, operation: path,
            });
          }
          if (!Array.isArray(local)) throw new DomainError("collaboration_response_invalid", "The local collection is invalid.");
          return await mergeCollections({
            source: local, active, url, remote,
            resolved, headers: localResponse.headers, signal: request.signal, operation: path,
          });
        } catch (error) {
          if (request.signal.aborted) {
            return workspaceClientErrorResponse(new DomainError("collaboration_request_aborted",
              "The workspace request was cancelled.", { cause: error }));
          }
          return workspaceClientErrorResponse(error);
        }
      };
    }
    return [path, next];
  }));
}

async function mergeCollections(input: {
  source: unknown[];
  active: ReturnType<typeof workspaceConnections.list>;
  url: URL;
  resolved: WorkspaceSourceRequest;
  headers: Headers;
  signal: AbortSignal;
  operation: string;
  trash?: ChatTrashPage;
  remote(connectionId: string, source: WorkspaceSourceRequest, signal?: AbortSignal): Promise<Response>;
}): Promise<Response> {
  let partial = false;
  let bytes = readBytes(input.source);
  if (bytes > MAX_COLLECTION_BYTES) throw new DomainError("collaboration_response_too_large", "The unified collection exceeds its transfer budget.");
  const results: unknown[][] = [];
  const trashPages: ChatTrashPage[] = [];
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), 20_000);
  let next = 0;
  const collect = async (index: number): Promise<void> => {
    const { connection } = input.active[index]!;
    try {
      const response = await input.remote(connection.id, input.resolved, deadline.signal);
      if (!response.ok) {
        await response.body?.cancel();
        throw new DomainError("collaboration_disconnected", "The shared collection is unavailable.");
      }
      const raw = await jsonResponse(response, MAX_COLLECTION_BYTES);
      const page = input.trash ? ChatTrashPageSchema.safeParse(raw) : undefined;
      if (page && !page.success) throw new DomainError("collaboration_response_invalid", "The shared Trash page is invalid.");
      const value = page?.success ? page.data.items : raw;
      if (!Array.isArray(value)) throw new DomainError("collaboration_response_invalid", "The shared collection is invalid.");
      const size = readBytes(value);
      if (bytes + size > MAX_COLLECTION_BYTES) {
        throw new DomainError("collaboration_response_too_large", "The unified collection exceeds its transfer budget.");
      }
      bytes += size;
      results[index] = value;
      if (page?.success) trashPages.push(page.data);
      workspaceConnections.reportOperation(connection.id, input.operation, null);
    } catch (error) {
      if (input.signal.aborted) return;
      partial = true;
      workspaceConnections.reportOperation(connection.id, input.operation,
        isDomainError(error) ? error.code : "collaboration_remote_failed");
      log[isDomainError(error) ? "warn" : "error"]("A workspace collection is incomplete", {
        connectionId: connection.id,
        code: isDomainError(error) ? error.code : "unexpected_error",
      });
      results[index] = [];
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, input.active.length) }, async () => {
      while (next < input.active.length && !input.signal.aborted) await collect(next++);
    }));
    input.signal.throwIfAborted();
  } finally {
    clearTimeout(timeout);
  }
  const headers = new Headers(input.headers);
  for (const name of ["content-length", "etag", "content-encoding"]) headers.delete(name);
  if (partial) headers.set("X-Clanky-Partial", "true");
  headers.set("Cache-Control", "private, no-store");
  return Response.json(input.trash
    ? mergeChatTrashPages([input.trash, ...trashPages],
      ChatTrashQuerySchema.parse(Object.fromEntries(input.url.searchParams)).limit)
    : filterCollection([...input.source, ...results.flat()], input.url), { headers });
}
