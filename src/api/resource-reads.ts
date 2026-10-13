/**
 * One opt-in representation contract on the real authorized route table.
 * Default responses, authorization and execution remain owned by each route.
 */
import { z } from "zod";
import { createLogger, type RouteDefinition, type RouteTable } from "@pablozaiden/webapp/server";
import { CollectionReadOptionsSchema, ConversationReadOptionsSchema, OperationResponseOptionsSchema, ResourcePageSchema } from "@/contracts/schemas/resource-read";
import { readResourceRepresentation, readScope, readBytes, readOperationReceipt, isReadRecord } from "../core/resource-read-service";
import { DomainError, isDomainError } from "../domain/domain-error";
import { errorResponse } from "./helpers";
import { readWorkMetadata, type WorkReadResource } from "../core/work-read-service";

const log = createLogger("api:resource-reads");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export function workMetadataResponse(req: Request, input: {
  resource: WorkReadResource; id: string; notFound: { code: string; message: string };
}): Response | undefined {
  const url = new URL(req.url);
  if (url.searchParams.get("view") !== "compact" || ["section", "item", "cursor"].some((key) => url.searchParams.has(key))) return;
  const options = CollectionReadOptionsSchema.parse(Object.fromEntries(url.searchParams));
  const metadata = readWorkMetadata({ ...input, maxBytes: options.maxBytes ?? 4096 });
  if (metadata) return resourcePageResponse(metadata);
  log.warn("Compact work is unavailable", { resource: input.resource });
  return errorResponse(input.notFound.code, input.notFound.message, 404);
}

export function resourcePageResponse(data: unknown): Response {
  return Response.json(data, { headers: { "X-Clanky-Read-View": "compact", "Cache-Control": "private, no-store" } });
}

export function withResourceReads(routes: Record<string, RouteDefinition>): RouteTable {
  return Object.fromEntries(Object.entries(routes).map(([path, route]) => {
    const next: RouteDefinition = { ...route, operations: { ...route.operations } };
    for (const method of METHODS) {
      const handler = route[method];
      const operation = route.operations?.[method];
      const automation = operation?.automation;
      if (!handler || !operation || !automation || automation.policy === "excluded") continue;
      const base = Object.hasOwn(operation, "querySchema") ? operation.querySchema : route.querySchema;
      const responseSchema = Object.hasOwn(operation, "responseSchema") ? operation.responseSchema : route.responseSchema;
      if (base !== undefined && !(base instanceof z.ZodObject)) {
        throw new Error(`Resource read options require an object query contract: ${method} ${path}`);
      }
      const nativeRead = base instanceof z.ZodObject && Object.hasOwn(base.shape, "view");
      const conversation = nativeRead && base.shape["view"]?.safeParse("conversation").success === true;
      const readOnly = method === "GET" || automation.policy === "read";
      const readSchema = !readOnly ? OperationResponseOptionsSchema
        : conversation ? ConversationReadOptionsSchema : CollectionReadOptionsSchema;
      const querySchema = base instanceof z.ZodObject ? base.safeExtend({
        ...readSchema.shape,
        ...(nativeRead ? { view: base.shape["view"] } : {}),
      }) : readSchema;
      next.operations![method] = {
        ...operation, querySchema,
        ...(responseSchema instanceof z.ZodType ? {
          responseSchema: z.union([responseSchema, ResourcePageSchema, z.record(z.string(), z.unknown())]),
        } : {}),
        description: `${operation.description ?? route.description ?? method} ${readOnly
          ? "Opt in with view=compact for byte-bounded pages; section=details reads lossless content parts. Follow nextCursor until null."
          : "Opt in with view=compact for a bounded operation receipt. Mutations are not paged or replayed."}`,
      };
      next[method] = async (req, ctx) => {
        const url = new URL(req.url);
        if (!url.searchParams.has("view")) return await handler(req, ctx);
        const parsed = readSchema.safeParse(Object.fromEntries(url.searchParams));
        const unsupported = !readOnly && ["cursor", "section", "item", "limit"].some((key) => url.searchParams.has(key));
        const incompatible = url.searchParams.get("view") === "conversation"
          && (!conversation || ["section", "item", "before", "full"].some((key) => url.searchParams.has(key)));
        const duplicate = Array.from(url.searchParams.keys()).some((key) => url.searchParams.getAll(key).length > 1);
        if (!parsed.success || unsupported || incompatible || duplicate) {
          log.warn("Invalid bounded resource read", { method, path });
          return errorResponse("read_options_invalid", "Use the documented read options. Mutations cannot be paged or replayed.", 400);
        }
        try {
          let inputIdentity: unknown;
          if (readOnly && method !== "GET" && req.body) {
            let body: unknown;
            try { body = await req.clone().json(); }
            catch (cause) { throw new DomainError("read_body_invalid", "Use a valid JSON read body.", { cause }); }
            const hidden = automation.hiddenInputs ?? [];
            inputIdentity = { method, body: isReadRecord(body)
              ? Object.fromEntries(Object.entries(body).filter(([key]) => !hidden.includes(key)).sort(([left], [right]) => left.localeCompare(right)))
              : body };
          }
          // Default-view ETags must not short-circuit a different representation.
          const headers = new Headers(req.headers);
          headers.delete("if-none-match");
          const handlerUrl = new URL(url);
          if (!nativeRead) {
            for (const key of Object.keys(readSchema.shape)) {
              if (!(base instanceof z.ZodObject && Object.hasOwn(base.shape, key))) handlerUrl.searchParams.delete(key);
            }
          }
          const response = await handler(new Request(handlerUrl, new Request(req, { headers })), ctx);
          if (!response || !response.ok || response.status === 204) return response;
          if (!response.headers.get("content-type")?.includes("application/json")) {
            await response.body?.cancel();
            log.warn("Bounded representation is unavailable", { method, path });
            return errorResponse("read_view_unavailable", "This operation has no JSON representation.", 400);
          }
          const source: unknown = await response.json();
          const data = parsed.data.view === "conversation" || response.headers.get("X-Clanky-Read-View") === "compact" ? source
            : !readOnly ? readOperationReceipt(source, parsed.data.maxBytes ?? 4096) : readResourceRepresentation({
            source, options: parsed.data, scope: readScope(ctx.requireUser().id, url, inputIdentity),
          });
          if (readBytes(data) > (parsed.data.maxBytes ?? 4096)) {
            throw new Error("The bounded representation exceeded its advertised budget.");
          }
          const resultHeaders = new Headers(response.headers);
          for (const name of ["content-length", "etag", "content-encoding"]) resultHeaders.delete(name);
          resultHeaders.set("Cache-Control", "private, no-store");
          return Response.json(data, { status: response.status, headers: resultHeaders });
        } catch (error) {
          const known = isDomainError(error) && error.code.startsWith("read_");
          log[known ? "warn" : "error"]("Bounded resource read failed", { method, path, code: known ? error.code : "unexpected_error" });
          return errorResponse(known ? error.code : "read_failed",
            known ? error.message : "The resource could not be read.",
            known ? error.code === "read_cursor_stale" ? 409 : 400 : 500);
        }
      };
    }
    return [path, next];
  }));
}
