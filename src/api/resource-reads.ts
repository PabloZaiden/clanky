/**
 * One opt-in representation contract on the real authorized route table.
 * Default responses, authorization and execution remain owned by each route.
 */
import { z } from "zod";
import { createLogger, type RouteDefinition, type RouteTable } from "@pablozaiden/webapp/server";
import { CollectionReadOptionsSchema, ConversationReadOptionsSchema, OperationResponseOptionsSchema, ResourcePageSchema } from "@/contracts/schemas/resource-read";
import { withResourceRepresentation } from "../client-sdk/collaboration/representations";
import { isDomainError } from "../domain/domain-error";
import { errorResponse } from "./helpers";
import { readWorkMetadata, type WorkReadResource } from "../core/work-read-service";
import { collaborationOperationMetadata } from "./collaboration-operation-metadata";

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
      if (!handler || !operation) continue;
      const read = collaborationOperationMetadata(path, method, route).read;
      if (!read) continue;
      const base = Object.hasOwn(operation, "querySchema") ? operation.querySchema : route.querySchema;
      const responseSchema = Object.hasOwn(operation, "responseSchema") ? operation.responseSchema : route.responseSchema;
      const { nativeRead, conversation, readOnly } = read;
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
        try {
          return await withResourceRepresentation({
            request: req, metadata: read, scope: ctx.requireUser().id,
            invoke: async (request: Request) => await handler(request, ctx),
          });
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
