/**
 * Shared HTTP routes for executor-backed file explorers.
 *
 * Workspace and standalone SSH-server modules provide only target resolution;
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
import { isDomainError } from "../core/domain-error";
import {
  fileExplorerService,
  type FileExplorerTarget,
} from "../core/file-explorer-service";
import { isFileExplorerConflictError } from "../core/file-explorer-errors";
import { createLogger } from "@pablozaiden/webapp/server";
import { errorResponse } from "./helpers";
import { createFileDownloadResponse, createInlineImageResponse } from "./file-download-response";
import { parseAndValidate, validateRequest, type ValidationResult } from "./validation";

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
  internalError: "workspace_file_error" | "ssh_server_file_error";
  resolveTarget: (
    req: Request,
    resourceId: string,
    startDirectory?: string,
    options?: { allowCredentialTokenQuery?: boolean },
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
    return Response.json({
      error: "file_conflict",
      message: error.message,
      currentFile: error.currentFile,
    }, { status: 409 });
  }

  if (isDomainError(error)) {
    switch (error.code) {
      case "start_directory_not_found":
        return errorResponse("start_directory_not_found", error.message, 404);
      case "invalid_start_directory_type":
        return errorResponse("invalid_start_directory_type", error.message, 400);
      case "file_not_found":
        return errorResponse("file_not_found", error.message, 404);
      case "invalid_path_type":
        return errorResponse("invalid_path_type", error.message, 400);
      case "root_not_mutable":
      case "path_outside_root":
        return errorResponse(config.invalidPathError, error.message, 400);
      case "invalid_file_name":
        return errorResponse("invalid_file_name", error.message, 400);
      case "upload_session_not_found":
        return errorResponse("upload_session_not_found", error.message, 404);
      case "upload_session_target_mismatch":
      case "invalid_upload_state":
        return errorResponse("invalid_upload_state", error.message, 400);
      case "invalid_preview_type":
        return errorResponse("invalid_preview_type", error.message, 400);
      case "invalid_credential_token":
        return errorResponse("invalid_credential_token", error.message, 400);
      case "ssh_server_not_found":
        return errorResponse("not_found", error.message, 404);
      case "operation_failed":
      default:
        return errorResponse(config.internalError, "File explorer operation failed", 500);
    }
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
      description: `List ${resourceDescription} files in the active explorer root.`,
      querySchema: ListFileExplorerRequestSchema,
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
      description: `Read a ${resourceDescription} file.`,
      querySchema: GetFileExplorerFileRequestSchema,
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
      description: `Preview a browser-renderable ${resourceDescription} image file.`,
      querySchema: GetFileExplorerFileRequestSchema,
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

    [`${basePath}/download`]: {
      auth: "user",
      sameOrigin: "mutations",
      description: `Download a ${resourceDescription} file from the active explorer root.`,
      querySchema: GetFileExplorerFileRequestSchema,
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
            { allowCredentialTokenQuery: true },
          );
          const response = await fileExplorerService.readDownloadFile(target, validation.data.path, {
            signal: req.signal,
          });
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
      description: `Load the full ${resourceDescription} file tree.`,
      querySchema: GetFileExplorerTreeRequestSchema,
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
          const response = await fileExplorerService.loadTree(target);
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
      description: `Read ${resourceDescription} file metadata.`,
      querySchema: GetFileExplorerFileRequestSchema,
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
      description: `Write a ${resourceDescription} file with optional conflict checks.`,
      requestSchema: WriteFileExplorerRequestSchema,
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
      description: `Rename a ${resourceDescription} file or directory in the active explorer root.`,
      requestSchema: RenameFileExplorerRequestSchema,
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
      description: `Delete a ${resourceDescription} file or directory in the active explorer root.`,
      requestSchema: DeleteFileExplorerRequestSchema,
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
      description: `Create a ${resourceDescription} file upload session.`,
      requestSchema: CreateFileExplorerUploadRequestSchema,
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
      description: `Upload a raw chunk for a ${resourceDescription} file upload session.`,
      querySchema: UploadFileExplorerChunkRequestSchema,
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
      description: `Complete a ${resourceDescription} file upload session.`,
      requestSchema: CompleteFileExplorerUploadRequestSchema,
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
      description: `Cancel a ${resourceDescription} file upload session.`,
      requestSchema: CancelFileExplorerUploadRequestSchema,
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
