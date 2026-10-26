/**
 * One API surface for local and granted controller resources, with no replica.
 */
import {
  compileRouteOperations, matchRouteOperations,
  type HttpMethod, type RouteDelegationMetadata,
} from "@pablozaiden/webapp/routing";
import {
  decodeCollaborationResourceReference,
  encodeCollaborationResourceReference,
} from "@/shared/collaboration-reference";
import { MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES } from "@/shared/message-attachments";
import { ChatTrashPageSchema, ChatTrashQuerySchema, type ChatTrashPage } from "@/contracts/schemas/chat-trash";
import type { CollaborationRouteOperation } from "@/shared/collaboration-operation";
import type { WorkspaceConnectionStatus } from "@/shared/collaboration";
import { sha256Text } from "@/shared/hash";
import { mergeChatTrashPages, trashCursorForSource } from "./trash-pagination";
import { DomainError, isDomainError } from "../../domain/domain-error";
import { qualifyWorkspaceResponse } from "./response";
import { compactResource, isReadRecord, readBytes } from "./resource-read";
import { readWorkspaceRequestBytes } from "./bodies";
import { workspaceJsonResponseStream } from "./json-stream";
import type { CollaborationClientRuntime } from "./engine";
import type { CollaborationClientLogger } from "./types";
import { withResourceRepresentation } from "./representations";
import {
  createWorkspaceUrlQualifier, resolveWorkspaceSource, workspaceOperationPath,
  type WorkspaceSourceRequest,
} from "./routing";

const VIEW_OPTIONS = ["view", "cursor", "limit", "maxBytes", "section", "item"];
const MAX_COLLECTION_BYTES = 16 * 1_024 * 1_024;

export interface CollaborationForwardContext {
  connectionId: string;
  source: WorkspaceSourceRequest;
  request: Request;
  path: string;
  method: HttpMethod;
}

export interface CollaborationFederationOptions {
  operations: readonly CollaborationRouteOperation[];
  connections: {
    require(connectionId: string): CollaborationClientRuntime;
    list(): WorkspaceConnectionStatus[] | Promise<WorkspaceConnectionStatus[]>;
    reportOperation(connectionId: string, operation: string, code: string | null): void;
  };
  logger?: CollaborationClientLogger;
  representationScope?: string;
  beforeForward?(input: CollaborationForwardContext): Promise<Response | undefined>;
}

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

async function forwardWorkspaceOperation(input: CollaborationForwardContext & {
  options: CollaborationFederationOptions;
  delegation: RouteDelegationMetadata;
  signal?: AbortSignal;
  qualifyUrl(connectionId: string, path: string): string;
}): Promise<Response> {
  const { connectionId, source, request, delegation } = input;
  const runtime = input.options.connections.require(connectionId);
  const intercepted = await input.options.beforeForward?.(input);
  if (intercepted) return intercepted;
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
        bodySha256: sha256Text(body ?? ""),
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
    if (request.method === "HEAD" && headers.get("content-type")?.includes("application/json")) {
      for (const name of ["content-length", "etag", "content-encoding"]) headers.delete(name);
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
        failed: () => (input.options.logger ?? console).error("The shared JSON response stream failed", { connectionId }),
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

export class CollaborationFederationClient {
  private readonly compiled;
  private readonly qualifyUrl;

  constructor(private readonly options: CollaborationFederationOptions) {
    this.compiled = compileRouteOperations(options.operations);
    this.qualifyUrl = createWorkspaceUrlQualifier(options.operations);
  }

  async request(request: Request): Promise<Response>;
  async request(request: Request, local: (request: Request) => Promise<Response | undefined>): Promise<Response | undefined>;
  async request(
    request: Request,
    local?: (request: Request) => Promise<Response | undefined>,
  ): Promise<Response | undefined> {
    if (this.options.representationScope === undefined) return await this.requestSources(request, local);
    const match = matchRouteOperations(this.compiled, new URL(request.url).pathname, request.method);
    return await withResourceRepresentation({
      request, scope: this.options.representationScope,
      metadata: match.kind === "matched" ? match.operation.metadata.read : undefined,
      invoke: async (inner) => await this.requestSources(inner, local),
    });
  }

  private async requestSources(
    request: Request,
    local?: (request: Request) => Promise<Response | undefined>,
  ): Promise<Response | undefined> {
    const url = new URL(request.url);
    const match = matchRouteOperations(this.compiled, url.pathname, request.method);
    if (match.kind !== "matched") {
      throw new DomainError("collaboration_operation_forbidden", "This operation is not available to workspace collaborators.");
    }
    const { delegation } = match.operation.metadata;
    if (!delegation) {
      if (Object.values(match.params).some((value) => decodeCollaborationResourceReference(value))
        || ["workspaceId", "taskId", "chatId", "agentId", "controllerId"].some((field) => {
          const value = url.searchParams.get(field);
          return value ? decodeCollaborationResourceReference(value) : false;
        }) || !local) {
        throw new DomainError("collaboration_operation_forbidden", "This operation cannot target a shared workspace.");
      }
      return await local(request);
    }
    const resolved = resolveWorkspaceSource({
      params: match.params, url, body: await requestBody(request), delegation,
    });
    const remote = async (connectionId: string, source: WorkspaceSourceRequest, signal?: AbortSignal): Promise<Response> =>
      await forwardWorkspaceOperation({
        connectionId, source, request, path: match.operation.path, method: match.operation.method,
        delegation, qualifyUrl: this.qualifyUrl, signal, options: this.options,
      });
    if (resolved.connectionId) return await remote(resolved.connectionId, resolved);
    const active = (await this.options.connections.list()).filter((item) => item.connection.status === "active");
    if (match.operation.method !== "GET" || !delegation.collection || resolved.hasLocalReference || !active.length && local) {
      if (local) return await local(request);
      throw new DomainError("collaboration_authority_required", "Select a shared workspace for this operation.");
    }
    let source: unknown[] = [];
    let trash: ChatTrashPage | undefined = delegation.action === "trash-list" ? { items: [], nextCursor: null } : undefined;
    let headers = new Headers();
    if (local) {
      const localUrl = delegation.action === "trash-list" ? new URL(url) : stripReadView(url);
      const cursor = localUrl.searchParams.get("cursor");
      if (delegation.action === "trash-list" && cursor) {
        localUrl.searchParams.set("cursor", trashCursorForSource(cursor));
      }
      const localResponse = await local(new Request(localUrl, request));
      if (!localResponse?.ok) return localResponse;
      headers = localResponse.headers;
      if (request.method === "HEAD") {
        await localResponse.body?.cancel();
      } else if (trash) {
        const value = await jsonResponse(localResponse);
        const page = ChatTrashPageSchema.safeParse(value);
        if (!page.success) throw new DomainError("collaboration_response_invalid", "The local Trash page is invalid.");
        source = page.data.items;
        trash = page.data;
      } else {
        const value = await jsonResponse(localResponse);
        if (!Array.isArray(value)) throw new DomainError("collaboration_response_invalid", "The local collection is invalid.");
        source = value;
      }
    }
    return await mergeCollections({
      source, trash, active, url, remote, resolved, headers,
      signal: request.signal, operation: match.operation.path, options: this.options, head: request.method === "HEAD",
    });
  }
}

async function mergeCollections(input: {
  source: unknown[];
  active: WorkspaceConnectionStatus[];
  url: URL;
  resolved: WorkspaceSourceRequest;
  headers: Headers;
  signal: AbortSignal;
  operation: string;
  head: boolean;
  trash?: ChatTrashPage;
  options: CollaborationFederationOptions;
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
      if (input.head) {
        await response.body?.cancel();
        input.options.connections.reportOperation(connection.id, input.operation, null);
        return;
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
      input.options.connections.reportOperation(connection.id, input.operation, null);
    } catch (error) {
      if (input.signal.aborted) return;
      partial = true;
      input.options.connections.reportOperation(connection.id, input.operation,
        isDomainError(error) ? error.code : "collaboration_remote_failed");
      (input.options.logger ?? console)[isDomainError(error) ? "warn" : "error"]("A workspace collection is incomplete", {
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
  if (input.head) {
    headers.set("Content-Type", "application/json;charset=utf-8");
    return new Response(null, { headers });
  }
  return Response.json(input.trash
    ? mergeChatTrashPages([input.trash, ...trashPages],
      ChatTrashQuerySchema.parse(Object.fromEntries(input.url.searchParams)).limit)
    : filterCollection([...input.source, ...results.flat()], input.url), { headers });
}
