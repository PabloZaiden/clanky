/**
 * Authenticated exact-path file operations, shared by workspace and host routes.
 */

import { createLogger, defineRoutes, type RouteTable } from "@pablozaiden/webapp/server";
import {
  FileSystemCommandSchema, FileSystemConditionsSchema, FileSystemReadQuerySchema,
  FileSystemInfoSchema, FileSystemResultSchema,
} from "../contracts/schemas/file-system";
import { fileSystemService } from "../core/file-system-service";
import { DomainError } from "../domain/domain-error";
import type { FileExplorerRouteConfig } from "./file-explorer-routes";
import { domainErrorResponse, errorResponse } from "./helpers";
import { parseAndValidate, validateRequest } from "./validation";
import { parseByteRange } from "../shared/byte-range";

function readConditions(req: Request, etag: string): number | null {
  const matches = (value: string, weak: boolean) => value.trim() === "*"
    || value.split(",").some((tag) => (
      weak ? tag.trim().replace(/^W\//, "") === etag.replace(/^W\//, "") : tag.trim() === etag && !etag.startsWith("W/")
    ));
  const match = req.headers.get("if-match");
  if (match !== null && !matches(match, false)) return 412;
  const none = req.headers.get("if-none-match");
  return none !== null && matches(none, true) ? 304 : null;
}

export function createFileSystemRoutes(config: FileExplorerRouteConfig): RouteTable {
  const log = createLogger(`api:${config.logName}:filesystem`);
  const path = `${config.basePath}/filesystem`;
  const failure = (error: unknown): Response => {
    const response = error instanceof Response ? error : domainErrorResponse(error, {
      policy: "file-explorer",
      mappings: {
        file_system_invalid_path: { status: 400 },
        file_system_not_found: { status: 404 },
        file_system_invalid_type: { status: 409 },
        file_system_exists: { status: 405 },
        file_system_conflict: { status: 409 },
        file_system_precondition_failed: { status: 412 },
        file_system_locked: { status: 423 },
        file_system_forbidden: { status: 403 },
        file_system_limit: { status: 507 },
        file_system_busy: { status: 503 },
        file_system_aborted: { status: 499 },
        file_system_target_changed: { status: 409 },
        mesh_execution_unreachable: { status: 503, message: "The execution host is unavailable." },
        mesh_execution_endpoint_unavailable: { status: 503, message: "The execution host is unavailable." },
        file_system_operation_failed: { status: 500, message: "Filesystem operation failed." },
        file_system_cleanup_failed: { status: 500, message: "Temporary transfer cleanup failed." },
      },
      fallback: { error: "file_system_failed", message: "Filesystem operation failed.", status: 500 },
    });
    if (response.status >= 500) log.error("Filesystem request failed", { error: String(error), status: response.status });
    else log.warn("Filesystem request rejected", { status: response.status });
    return response;
  };
  const targetFor = async (req: Request, id: string) => {
    const target = await config.resolveTarget(req, id);
    const expected = req.headers.get("x-clanky-file-target");
    if (expected !== null && expected !== fileSystemService.info(target).target) {
      throw new DomainError("file_system_target_changed", "The execution target changed.");
    }
    return target;
  };

  return defineRoutes({
    [path]: {
      auth: "user",
      sameOrigin: "mutations",
      scopes: ["clanky:files"],
      description: `Exact-path operations on the ${config.resourceLabel} execution host; the initial directory is not a sandbox.`,
      tags: ["files"],
      requestSchema: FileSystemCommandSchema,
      responseSchema: FileSystemInfoSchema.or(FileSystemResultSchema),
      async POST(req, ctx): Promise<Response> {
        const parsed = await parseAndValidate(FileSystemCommandSchema, req);
        if (!parsed.success) return parsed.response;
        try {
          return Response.json(await fileSystemService.execute(
            await targetFor(req, ctx.params["id"]!), parsed.data, req.signal,
          ));
        } catch (error) {
          return failure(error);
        }
      },
    },
    [`${path}/content`]: {
      auth: "user",
      sameOrigin: "mutations",
      scopes: ["clanky:files"],
      description: `GET/HEAD stream an exact-path file; PUT stages and replaces its binary content on the ${config.resourceLabel} host.`,
      tags: ["files"],
      querySchema: FileSystemReadQuerySchema,
      async GET(req, ctx): Promise<Response> {
        const parsed = validateRequest(FileSystemReadQuerySchema, Object.fromEntries(new URL(req.url).searchParams));
        if (!parsed.success) return parsed.response;
        try {
          const target = await targetFor(req, ctx.params["id"]!);
          const range = req.method === "HEAD" ? null : req.headers.get("range");
          const ifRange = req.headers.get("if-range");
          const strong = range === null || ifRange?.startsWith('"') === true
            || ["if-match", "if-none-match"].some((name) => {
              const value = req.headers.get(name);
              return value !== null && value.trim() !== "*";
            });
          let entry = await fileSystemService.stat(target, parsed.data.path, strong);
          if (!entry) throw new DomainError("file_system_not_found", "The file does not exist.");
          if (entry.kind !== "file") throw new DomainError("file_system_invalid_type", "A file is required.");
          const headers = new Headers({
            "content-type": "application/octet-stream", "cache-control": "no-store",
            "x-content-type-options": "nosniff", "accept-ranges": "bytes",
            "x-clanky-download-size": String(entry.size), etag: entry.etag,
            "last-modified": new Date(entry.modifiedAtMs).toUTCString(),
          });
          const conditional = readConditions(req, entry.etag);
          if (conditional === 412) throw new DomainError("file_system_precondition_failed", "The resource changed.");
          if (conditional === 304) return new Response(null, { status: 304, headers });
          const matchesRange = ifRange === null
            || (!ifRange.startsWith("W/") && !entry.etag.startsWith("W/") && ifRange === entry.etag)
            || (!ifRange.startsWith('"') && !ifRange.startsWith("W/")
              && Date.parse(ifRange) === Date.parse(headers.get("last-modified")!));
          const selected = range !== null && matchesRange ? parseByteRange(range, entry.size) : undefined;
          if (selected === null) {
            log.warn("Unsatisfiable file range.");
            const response = errorResponse("file_system_range_unsatisfiable", "A satisfiable single byte range is required.", 416);
            response.headers.set("content-range", `bytes */${String(entry.size)}`);
            return response;
          }
          if (!selected && !strong) {
            entry = await fileSystemService.stat(target, parsed.data.path, true);
            if (!entry) throw new DomainError("file_system_not_found", "The file does not exist.");
            headers.set("etag", entry.etag);
            headers.set("last-modified", new Date(entry.modifiedAtMs).toUTCString());
            headers.set("x-clanky-download-size", String(entry.size));
          }
          if (req.method === "HEAD") {
            headers.set("content-length", String(entry.size));
            return new Response(null, { headers });
          }
          if (selected) {
            headers.set("content-range", `bytes ${String(selected.start)}-${String(selected.end)}/${String(entry.size)}`);
            headers.set("content-length", String(selected.end - selected.start + 1));
            // RFC 9110 forbids weak validators on 206; metadata-only ranges omit ETag.
            if (entry.etag.startsWith("W/")) headers.delete("etag");
          }
          const { stream } = await fileSystemService.read(target, entry, { signal: req.signal, range: selected });
          // Bun auto-ranges native file streams even when If-Range failed.
          const body = range !== null && !selected
            ? stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>())
            : stream;
          return new Response(body, { status: selected ? 206 : 200, headers });
        } catch (error) {
          return failure(error);
        }
      },
      async PUT(req, ctx): Promise<Response> {
        let conditions;
        try {
          conditions = FileSystemConditionsSchema.safeParse(JSON.parse(req.headers.get("x-clanky-file-conditions") ?? "{}"));
        } catch {
          log.warn("Invalid file conditions.");
          return errorResponse("validation_error", "Invalid file conditions.", 400);
        }
        if (!conditions.success) {
          log.warn("Invalid file conditions.");
          return errorResponse("validation_error", "Invalid file conditions.", 400);
        }
        const parsed = validateRequest(FileSystemReadQuerySchema, Object.fromEntries(new URL(req.url).searchParams));
        if (!parsed.success) return parsed.response;
        try {
          const result = await fileSystemService.write({
            target: await targetFor(req, ctx.params["id"]!), path: parsed.data.path,
            stream: req.body ?? new Blob([]).stream(), conditions: conditions.data, signal: req.signal,
          });
          return Response.json(result, { status: result.created ? 201 : 200 });
        } catch (error) {
          return failure(error);
        }
      },
    },
  });
}
