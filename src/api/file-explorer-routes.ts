import { workspaceOperation } from "./workspace-delegation";
/**
 * Shared HTTP routes for executor-backed file explorers.
 *
 * Workspace and execution-host modules provide only target resolution;
 * this module owns the common request parsing, operation dispatch, response
 * envelopes, streaming responses, and file-domain error mapping.
 */

import { defineRoutes, type RouteContext, type RouteTable } from "@pablozaiden/webapp/server";
import {
  CancelFileExplorerUploadRequestSchema,
  CompleteFileExplorerUploadRequestSchema,
  CreateFileExplorerUploadRequestSchema,
  DeleteFileExplorerRequestSchema,
  GetFileExplorerFileRequestSchema,
  GetFileExplorerTreeRequestSchema,
  ListFileExplorerRequestSchema,
  RenameFileExplorerRequestSchema,
  UploadFileExplorerChunkRequestSchema,
  WriteFileExplorerRequestSchema,
} from "@/contracts/schemas";
import { isDomainError } from "../domain/domain-error";
import {
  fileExplorerService,
  type FileExplorerTarget,
} from "../core/file-explorer-service";
import { isFileExplorerConflictError } from "../core/file-explorer-errors";
import { createLogger } from "@pablozaiden/webapp/server";
import { domainErrorResponse, errorResponse } from "./helpers";
import {
  createFileDownloadHeadResponse,
  createFileDownloadResponse,
  createInlineImageResponse,
  createInlineVideoResponse,
} from "./file-download-response";
import { parseAndValidate, validateRequest, type ValidationResult } from "./validation";
import { parseByteRange } from "../shared/byte-range";

interface SearchSchema<T> {
  safeParse: (value: unknown) =>
    | { success: true; data: T }
    | { success: false; error: unknown };
}

export interface FileExplorerRouteConfig {
  basePath: string;
  logName: string;
  resourceLabel: string;
  responseIdField: "workspaceId" | "serverId";
  invalidPathError: "invalid_workspace_path" | "invalid_server_path";
  internalError: "workspace_file_error" | "execution_host_file_error";
  downloadDescription?: string;
  workspaceCollaboration?: boolean;
  resolveTarget: (
    req: Request,
    resourceId: string,
    startDirectory?: string,
  ) => Promise<FileExplorerTarget>;
}

function parseSearchParams<T>(
  schema: SearchSchema<T>,
  req: Request,
): ValidationResult<T> {
  const url = new URL(req.url);
  return validateRequest(
    schema as never,
    Object.fromEntries(url.searchParams.entries()),
  );
}

function getResourceId(ctx: RouteContext): string {
  return ctx.params["id"]!;
}

function withResourceId(
  config: FileExplorerRouteConfig,
  resourceId: string,
  data: object,
): object {
  return {
    [config.responseIdField]: resourceId,
    ...data,
  };
}

function getStartDirectory(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function mapFileExplorerError(
  error: unknown,
  config: FileExplorerRouteConfig,
): Response {
  if (error instanceof Response) {
    return error;
  }

  if (isFileExplorerConflictError(error)) {
    return domainErrorResponse(error, {
      policy: "file-explorer",
      fallback: {
        error: "file_conflict",
        message: "The file changed since it was loaded.",
        status: 409,
      },
    });
  }

  if (isDomainError(error)) {
    return domainErrorResponse(error, {
      policy: "file-explorer",
      mappings: {
        invalid_path: {
          status: 400,
          error: config.invalidPathError,
        },
        operation_failed: {
          status: 500,
          error: config.internalError,
        },
        root_not_mutable: {
          status: 400,
          error: config.invalidPathError,
        },
        upload_session_target_mismatch: {
          status: 400,
          error: "invalid_upload_state",
        },
      },
      fallback: {
        error: config.internalError,
        message: "File explorer operation failed",
        status: 500,
      },
    });
  }

  return errorResponse(config.internalError, "File explorer operation failed", 500);
}

function createRouteLogger(config: FileExplorerRouteConfig) {
  return createLogger(`api:${config.logName}`);
}

export function createFileExplorerRoutes(
  config: FileExplorerRouteConfig,
): RouteTable {
  const log = createRouteLogger(config);
  const basePath = config.basePath;
  const resourceDescription = config.resourceLabel;

  return defineRoutes({
    [basePath]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: `List ${resourceDescription} files in the active explorer root.`,
      querySchema: ListFileExplorerRequestSchema,
      operations: {
        GET: {
          requestSchema: undefined,
          querySchema: ListFileExplorerRequestSchema,
          automation: { policy: "read" },
        },
      },
      async GET(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = parseSearchParams(ListFileExplorerRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          const response = await fileExplorerService.listDirectory(
            target,
            validation.data.path,
            { includeHidden: true },
          );
          return Response.json(withResourceId(config, resourceId, response));
        } catch (error) {
          log.error(`Failed to list ${resourceDescription} files`, {
            resourceId,
            path: validation.data.path,
            error: String(error),
          });
          return mapFileExplorerError(error, config);
        }
      },
    },

    [`${basePath}/content`]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: `Read a ${resourceDescription} file.`,
      querySchema: GetFileExplorerFileRequestSchema,
      operations: {
        GET: {
          requestSchema: undefined,
          querySchema: GetFileExplorerFileRequestSchema,
          automation: { policy: "read" },
        },
      },
      async GET(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = parseSearchParams(GetFileExplorerFileRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          const response = await fileExplorerService.readFile(target, validation.data.path);
          return Response.json(withResourceId(config, resourceId, response));
        } catch (error) {
          log.error(`Failed to read ${resourceDescription} file`, {
            resourceId,
            path: validation.data.path,
            error: String(error),
          });
          return mapFileExplorerError(error, config);
        }
      },
    },

    [`${basePath}/preview`]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: `Preview a browser-renderable ${resourceDescription} image file.`,
      querySchema: GetFileExplorerFileRequestSchema,
      operations: {
        GET: {
          requestSchema: undefined,
          querySchema: GetFileExplorerFileRequestSchema,
          automation: { policy: "excluded", reason: "Raw image bytes belong to browser media rendering, not JSON automation." },
        },
      },
      async GET(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = parseSearchParams(GetFileExplorerFileRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          const response = await fileExplorerService.readImageFile(target, validation.data.path);
          return createInlineImageResponse(response.data, response.contentType, response.file.name);
        } catch (error) {
          log.error(`Failed to preview ${resourceDescription} file`, {
            resourceId,
            path: validation.data.path,
            error: String(error),
          });
          return mapFileExplorerError(error, config);
        }
      },
    },

    [`${basePath}/video-preview`]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: `Stream a browser-renderable ${resourceDescription} video file for inline playback.`,
      querySchema: GetFileExplorerFileRequestSchema,
      operations: {
        GET: {
          requestSchema: undefined,
          querySchema: GetFileExplorerFileRequestSchema,
          automation: { policy: "excluded", reason: "Raw ranged video stream; use file metadata or JSON explorer operations." },
        },
      },
      async GET(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = parseSearchParams(GetFileExplorerFileRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          const metadata = await fileExplorerService.getVideoPreviewMetadata(
            target,
            validation.data.path,
          );
          const rangeHeader = req.headers.get("range");
          const range = rangeHeader === null
            ? undefined
            : parseByteRange(rangeHeader, metadata.file.size);
          if (range === null) {
            log.warn(`Rejected unsatisfiable ${resourceDescription} video preview range`, {
              resourceId,
              path: validation.data.path,
            });
            const response = errorResponse(
              "file_range_unsatisfiable",
              "A satisfiable single byte range is required.",
              416,
            );
            response.headers.set("Content-Range", `bytes */${String(metadata.file.size)}`);
            return response;
          }

          const video = await fileExplorerService.readVideoPreviewFile(target, metadata, {
            signal: req.signal,
            range,
          });
          if (video.rangeFallback) {
            log.warn(`Serving full ${resourceDescription} video stream because ranged reads are unavailable`, {
              resourceId,
              path: validation.data.path,
            });
          }
          // A paused consumer must not expire an admitted file response.
          ctx.server?.timeout(req, 0);
          return createInlineVideoResponse(video.stream, video.contentType, video.file, {
            ...(video.range ? { range: video.range } : {}),
            ...(video.rangeFallback ? { rangeFallback: true } : {}),
          });
        } catch (error) {
          const metadata = {
            resourceId,
            path: validation.data.path,
            error: String(error),
          };
          if (
            isDomainError(error)
            && ["file_not_found", "invalid_path_type", "invalid_preview_type", "invalid_path"].includes(error.code)
          ) {
            log.warn(`Rejected ${resourceDescription} video preview request`, metadata);
          } else {
            log.error(`Failed to preview ${resourceDescription} video`, metadata);
          }
          return mapFileExplorerError(error, config);
        }
      },
    },

    [`${basePath}/download`]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: config.downloadDescription
        ?? `Download a ${resourceDescription} file from the active explorer root.`,
      querySchema: GetFileExplorerFileRequestSchema,
      operations: {
        GET: {
          requestSchema: undefined,
          querySchema: GetFileExplorerFileRequestSchema,
          automation: { policy: "excluded", reason: "Raw attachment download; use the JSON content or metadata operation." },
        },
      },
      async GET(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = parseSearchParams(GetFileExplorerFileRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          if (req.method === "HEAD") {
            const metadata = await fileExplorerService.getDownloadMetadata(target, validation.data.path);
            return createFileDownloadHeadResponse(metadata.contentType, metadata.file, {
              contentLength: metadata.file.size,
            });
          }
          const response = await fileExplorerService.readDownloadFile(target, validation.data.path, {
            signal: req.signal,
          });
          ctx.server?.timeout(req, 0);
          return createFileDownloadResponse(response.stream, response.contentType, response.file, {
            contentLength: response.file.size,
          });
        } catch (error) {
          log.error(`Failed to download ${resourceDescription} file`, {
            resourceId,
            path: validation.data.path,
            error: String(error),
          });
          return mapFileExplorerError(error, config);
        }
      },
    },

    [`${basePath}/tree`]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: `Load the full ${resourceDescription} file tree.`,
      querySchema: GetFileExplorerTreeRequestSchema,
      operations: {
        GET: {
          requestSchema: undefined,
          querySchema: GetFileExplorerTreeRequestSchema,
          automation: { policy: "read" },
        },
      },
      async GET(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = parseSearchParams(GetFileExplorerTreeRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          const response = await fileExplorerService.loadTree(target, { signal: req.signal });
          return Response.json(withResourceId(config, resourceId, response));
        } catch (error) {
          log.error(`Failed to load ${resourceDescription} file tree`, {
            resourceId,
            error: String(error),
          });
          return mapFileExplorerError(error, config);
        }
      },
    },

    [`${basePath}/metadata`]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: `Read ${resourceDescription} file metadata.`,
      querySchema: GetFileExplorerFileRequestSchema,
      operations: {
        GET: {
          requestSchema: undefined,
          querySchema: GetFileExplorerFileRequestSchema,
          automation: { policy: "read" },
        },
      },
      async GET(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = parseSearchParams(GetFileExplorerFileRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          const file = await fileExplorerService.getMetadata(target, validation.data.path);
          if (!file) {
            return errorResponse("file_not_found", "Requested file does not exist", 404);
          }
          return Response.json(withResourceId(config, resourceId, { file }));
        } catch (error) {
          log.error(`Failed to fetch ${resourceDescription} file metadata`, {
            resourceId,
            path: validation.data.path,
            error: String(error),
          });
          return mapFileExplorerError(error, config);
        }
      },
    },

    [`${basePath}/write`]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: `Write a ${resourceDescription} file with optional conflict checks.`,
      requestSchema: WriteFileExplorerRequestSchema,
      operations: {
        POST: {
          requestSchema: WriteFileExplorerRequestSchema,
          querySchema: undefined,
          automation: { policy: "confirm", reason: "Writes or overwrites a file on the selected execution host." },
        },
      },
      async POST(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = await parseAndValidate(WriteFileExplorerRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          const response = await fileExplorerService.writeFile(
            target,
            validation.data.path,
            validation.data.content,
            {
              expectedVersionToken: validation.data.expectedVersionToken ?? null,
              overwrite: validation.data.overwrite,
            },
          );
          return Response.json(withResourceId(config, resourceId, response));
        } catch (error) {
          log.error(`Failed to write ${resourceDescription} file`, {
            resourceId,
            path: validation.data.path,
            error: String(error),
          });
          return mapFileExplorerError(error, config);
        }
      },
    },

    [`${basePath}/rename`]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: `Rename a ${resourceDescription} file or directory in the active explorer root.`,
      requestSchema: RenameFileExplorerRequestSchema,
      operations: {
        POST: {
          requestSchema: RenameFileExplorerRequestSchema,
          querySchema: undefined,
          automation: { policy: "confirm", reason: "Renames a file or directory and may overwrite an existing target." },
        },
      },
      async POST(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = await parseAndValidate(RenameFileExplorerRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          const response = await fileExplorerService.renameNode(
            target,
            validation.data.path,
            validation.data.newName,
            {
              expectedVersionToken: validation.data.expectedVersionToken ?? undefined,
              overwrite: validation.data.overwrite,
            },
          );
          return Response.json(withResourceId(config, resourceId, response));
        } catch (error) {
          log.error(`Failed to rename ${resourceDescription} file`, {
            resourceId,
            path: validation.data.path,
            error: String(error),
          });
          return mapFileExplorerError(error, config);
        }
      },
    },

    [`${basePath}/delete`]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: `Delete a ${resourceDescription} file or directory in the active explorer root.`,
      requestSchema: DeleteFileExplorerRequestSchema,
      operations: {
        POST: {
          requestSchema: DeleteFileExplorerRequestSchema,
          querySchema: undefined,
          automation: { policy: "confirm", reason: "Permanently deletes a file or directory on the selected execution host." },
        },
      },
      async POST(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = await parseAndValidate(DeleteFileExplorerRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          const response = await fileExplorerService.deleteNode(
            target,
            validation.data.path,
            {
              expectedVersionToken: validation.data.expectedVersionToken ?? undefined,
              kind: validation.data.kind,
            },
          );
          return Response.json(withResourceId(config, resourceId, response));
        } catch (error) {
          log.error(`Failed to delete ${resourceDescription} file`, {
            resourceId,
            path: validation.data.path,
            error: String(error),
          });
          return mapFileExplorerError(error, config);
        }
      },
    },

    [`${basePath}/upload`]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: `Create a ${resourceDescription} file upload session.`,
      requestSchema: CreateFileExplorerUploadRequestSchema,
      operations: {
        POST: {
          requestSchema: CreateFileExplorerUploadRequestSchema,
          querySchema: undefined,
          automation: { policy: "excluded", reason: "Browser-owned binary upload protocol requires raw chunk delivery." },
        },
      },
      async POST(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = await parseAndValidate(CreateFileExplorerUploadRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          const response = await fileExplorerService.createUploadSession(
            target,
            validation.data.directory,
            validation.data.fileName,
            validation.data.size,
            {
              overwrite: validation.data.overwrite,
            },
          );
          return Response.json(withResourceId(config, resourceId, response), { status: 201 });
        } catch (error) {
          log.error(`Failed to create ${resourceDescription} file upload`, {
            resourceId,
            directory: validation.data.directory,
            error: String(error),
          });
          return mapFileExplorerError(error, config);
        }
      },
    },

    [`${basePath}/upload/chunk`]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: `Upload a raw chunk for a ${resourceDescription} file upload session.`,
      querySchema: UploadFileExplorerChunkRequestSchema,
      operations: {
        POST: {
          requestSchema: undefined,
          querySchema: UploadFileExplorerChunkRequestSchema,
          automation: { policy: "excluded", reason: "Raw binary upload chunks are not JSON automation inputs." },
        },
      },
      async POST(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = parseSearchParams(UploadFileExplorerChunkRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }
        if (!req.body) {
          return errorResponse("invalid_upload_chunk", "Upload chunk body is required", 400);
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          const response = await fileExplorerService.writeUploadChunk(
            target,
            validation.data.uploadId,
            validation.data.offset,
            req.body,
            { signal: req.signal },
          );
          return Response.json(withResourceId(config, resourceId, response));
        } catch (error) {
          log.error(`Failed to write ${resourceDescription} file upload chunk`, {
            resourceId,
            uploadId: validation.data.uploadId,
            error: String(error),
          });
          return mapFileExplorerError(error, config);
        }
      },
    },

    [`${basePath}/upload/complete`]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: `Complete a ${resourceDescription} file upload session.`,
      requestSchema: CompleteFileExplorerUploadRequestSchema,
      operations: {
        POST: {
          requestSchema: CompleteFileExplorerUploadRequestSchema,
          querySchema: undefined,
          automation: { policy: "excluded", reason: "Completion belongs to the browser-owned binary upload session." },
        },
      },
      async POST(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = await parseAndValidate(CompleteFileExplorerUploadRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          const response = await fileExplorerService.completeUpload(
            target,
            validation.data.uploadId,
          );
          return Response.json(withResourceId(config, resourceId, response));
        } catch (error) {
          log.error(`Failed to complete ${resourceDescription} file upload`, {
            resourceId,
            uploadId: validation.data.uploadId,
            error: String(error),
          });
          return mapFileExplorerError(error, config);
        }
      },
    },

    [`${basePath}/upload/cancel`]: {
      auth: "user",
      sameOrigin: "mutations",
      delegation: config.workspaceCollaboration ? workspaceOperation("workspace") : false,
      description: `Cancel a ${resourceDescription} file upload session.`,
      requestSchema: CancelFileExplorerUploadRequestSchema,
      operations: {
        POST: {
          requestSchema: CancelFileExplorerUploadRequestSchema,
          querySchema: undefined,
          automation: { policy: "excluded", reason: "Cancellation belongs to the browser-owned binary upload session." },
        },
      },
      async POST(req: Request, ctx: RouteContext): Promise<Response> {
        const validation = await parseAndValidate(CancelFileExplorerUploadRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const resourceId = getResourceId(ctx);
        try {
          const target = await config.resolveTarget(
            req,
            resourceId,
            getStartDirectory(validation.data.startDirectory),
          );
          const response = await fileExplorerService.cancelUpload(
            target,
            validation.data.uploadId,
          );
          return Response.json(withResourceId(config, resourceId, response));
        } catch (error) {
          log.error(`Failed to cancel ${resourceDescription} file upload`, {
            resourceId,
            uploadId: validation.data.uploadId,
            error: String(error),
          });
          return mapFileExplorerError(error, config);
        }
      },
    },
  });
}
