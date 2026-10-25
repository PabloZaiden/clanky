/**
 * Opt-in read and operation representations, applied after source composition.
 */

import {
  CollectionReadOptionsSchema, ConversationReadOptionsSchema, OperationResponseOptionsSchema,
} from "@/contracts/schemas/resource-read";
import type { CollaborationReadMetadata } from "@/shared/collaboration-operation";
import { MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES } from "@/shared/message-attachments";
import { DomainError } from "../../domain/domain-error";
import { readWorkspaceRequestBytes } from "./bodies";
import {
  isReadRecord, readBytes, readOperationReceipt, readResourceRepresentation, readScope,
} from "./resource-read";

export async function withResourceRepresentation(input: {
  request: Request;
  metadata?: CollaborationReadMetadata;
  scope: string;
  invoke(request: Request): Promise<Response | undefined>;
}): Promise<Response | undefined> {
  const { request, metadata } = input;
  const url = new URL(request.url);
  if (!metadata || !url.searchParams.has("view")) return await input.invoke(request);
  const schema = !metadata.readOnly ? OperationResponseOptionsSchema
    : metadata.conversation ? ConversationReadOptionsSchema : CollectionReadOptionsSchema;
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
  const unsupported = !metadata.readOnly && ["cursor", "section", "item", "limit"].some((key) => url.searchParams.has(key));
  const incompatible = url.searchParams.get("view") === "conversation"
    && (!metadata.conversation || ["section", "item", "before", "full"].some((key) => url.searchParams.has(key)));
  const duplicate = Array.from(url.searchParams.keys()).some((key) => url.searchParams.getAll(key).length > 1);
  if (!parsed.success || unsupported || incompatible || duplicate) {
    throw new DomainError("read_options_invalid", "Use the documented read options. Mutations cannot be paged or replayed.");
  }
  const inputIdentity = await readInputIdentity(request, metadata);
  const headers = new Headers(request.headers);
  headers.delete("if-none-match");
  const handlerUrl = new URL(url);
  if (!metadata.nativeRead) {
    for (const key of Object.keys(schema.shape)) {
      if (!metadata.nativeQueryFields.includes(key)) handlerUrl.searchParams.delete(key);
    }
  }
  const response = await input.invoke(new Request(handlerUrl, new Request(request, { headers })));
  if (!response || !response.ok || response.status === 204) return response;
  if (request.method === "HEAD") {
    await response.body?.cancel();
    const headHeaders = new Headers(response.headers);
    for (const name of ["content-length", "etag", "content-encoding"]) headHeaders.delete(name);
    return new Response(null, { status: response.status, headers: headHeaders });
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    throw new DomainError("read_view_unavailable", "This operation has no JSON representation.");
  }
  const source: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    await readWorkspaceRequestBytes(response, MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES),
  ));
  const data = parsed.data.view === "conversation" || response.headers.get("X-Clanky-Read-View") === "compact" ? source
    : !metadata.readOnly ? readOperationReceipt(source, parsed.data.maxBytes ?? 4096) : readResourceRepresentation({
      source, options: parsed.data, scope: readScope(input.scope, url, inputIdentity),
    });
  if (readBytes(data) > (parsed.data.maxBytes ?? 4096)) {
    throw new Error("The bounded representation exceeded its advertised budget.");
  }
  const resultHeaders = new Headers(response.headers);
  for (const name of ["content-length", "etag", "content-encoding"]) resultHeaders.delete(name);
  resultHeaders.set("Cache-Control", "private, no-store");
  return Response.json(data, { status: response.status, headers: resultHeaders });
}

async function readInputIdentity(request: Request, metadata: CollaborationReadMetadata): Promise<unknown> {
  if (!metadata.readOnly || request.method === "GET" || !request.body) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      await readWorkspaceRequestBytes(request.clone(), MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES),
    ));
  } catch (cause) {
    throw new DomainError("read_body_invalid", "Use a valid JSON read body.", { cause });
  }
  return { method: request.method, body: isReadRecord(body)
    ? Object.fromEntries(Object.entries(body).filter(([key]) => !metadata.hiddenInputs.includes(key))
      .sort(([left], [right]) => left.localeCompare(right)))
    : body };
}
