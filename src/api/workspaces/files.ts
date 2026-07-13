import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Workspace file explorer API routes.
 */

import { createLogger } from "../../core/logger";
import { workspaceFileService } from "../../core/workspace-file-service";
import { type WorkspaceFileEntry } from "../../types";
import {
  CancelWorkspaceFileUploadRequestSchema,
  CompleteWorkspaceFileUploadRequestSchema,
  CreateWorkspaceFileUploadRequestSchema,
  DeleteWorkspaceFileRequestSchema,
  GetWorkspaceFileRequestSchema,
  GetWorkspaceFileTreeRequestSchema,
  ListWorkspaceFilesRequestSchema,
  RenameWorkspaceFileRequestSchema,
  UploadWorkspaceFileChunkRequestSchema,
  WriteWorkspaceFileRequestSchema,
} from "../../types/schemas";
import { errorResponse, requireWorkspace } from "../helpers";
import { parseAndValidate, validateRequest } from "../validation";
import { createFileDownloadResponse } from "../file-download-response";

const log = createLogger("api:workspace-files");

function createInlineImageResponse(
  data: Uint8Array,
  contentType: string,
  fileName: string,
): Response {
  const safeFileName = fileName.replace(/["\r\n]/g, "_");
  const body = new ArrayBuffer(data.byteLength);
  new Uint8Array(body).set(data);
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename="${safeFileName}"`,
      "Content-Type": contentType,
    },
  });
}

function mapFileError(error: unknown): Response {
  if (error instanceof Response) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  if ((error as { name?: string } | null)?.name === "FileExplorerConflictError") {
    const currentFile = (error as { currentFile?: WorkspaceFileEntry | null }).currentFile ?? null;
    return Response.json({
      error: "file_conflict",
      message,
      currentFile,
    }, { status: 409 });
  }
  if (message.includes("start directory does not exist")) {
    return errorResponse("start_directory_not_found", message, 404);
  }
  if (message.includes("start directory is not a directory")) {
    return errorResponse("invalid_start_directory_type", message, 400);
  }
  if (message.includes("does not exist")) {
    return errorResponse("file_not_found", message, 404);
  }
  if (message.includes("not a directory") || message.includes("not a file")) {
    return errorResponse("invalid_path_type", message, 400);
  }
  if (message.includes("Cannot modify the active explorer root")) {
    return errorResponse("invalid_workspace_path", message, 400);
  }
  if (message.includes("File name must not contain path separators") || message.includes("File name is required")) {
    return errorResponse("invalid_file_name", message, 400);
  }
  if (message.includes("Upload session does not exist")) {
    return errorResponse("upload_session_not_found", message, 404);
  }
  if (message.includes("upload offset") || message.includes("Upload is incomplete")) {
    return errorResponse("invalid_upload_state", message, 400);
  }
  if (message.includes("not a browser-renderable image")) {
    return errorResponse("invalid_preview_type", message, 400);
  }
  if (message.includes("must stay within the active workspace explorer root")) {
    return errorResponse("invalid_workspace_path", message, 400);
  }
  return errorResponse("workspace_file_error", message, 500);
}

function parseSearchParams<T extends Record<string, unknown>>(
  schema: {
    safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: unknown };
  },
  req: Request,
): { success: true; data: T } | { success: false; response: Response } {
  const url = new URL(req.url);
  return validateRequest(
    schema as never,
    Object.fromEntries(url.searchParams.entries()),
  );
}

export const workspaceFilesRoutes = defineRoutes({
  "/api/workspaces/:id/files": {
    description: "List workspace files in the active explorer root.",
    querySchema: ListWorkspaceFilesRequestSchema,
    async GET(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      const validation = parseSearchParams(ListWorkspaceFilesRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await workspaceFileService.listDirectory(
          workspaceResult,
          validation.data.path,
          {
            includeHidden: true,
            startDirectory: validation.data.startDirectory,
          },
        ));
      } catch (error) {
        log.error("Failed to list workspace files", {
          workspaceId: ctx.params["id"]!,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/content": {
    description: "Read a workspace file.",
    querySchema: GetWorkspaceFileRequestSchema,
    async GET(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      const validation = parseSearchParams(GetWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await workspaceFileService.readFile(workspaceResult, validation.data.path, {
          startDirectory: validation.data.startDirectory,
        }));
      } catch (error) {
        log.error("Failed to read workspace file", {
          workspaceId: ctx.params["id"]!,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/preview": {
    description: "Preview a browser-renderable workspace image file.",
    querySchema: GetWorkspaceFileRequestSchema,
    async GET(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      const validation = parseSearchParams(GetWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const response = await workspaceFileService.readImageFile(workspaceResult, validation.data.path, {
          startDirectory: validation.data.startDirectory,
        });
        return createInlineImageResponse(response.data, response.contentType, response.file.name);
      } catch (error) {
        log.error("Failed to preview workspace file", {
          workspaceId: ctx.params["id"]!,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/download": {
    description: "Download a workspace file from the active explorer root.",
    querySchema: GetWorkspaceFileRequestSchema,

    async GET(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      const validation = parseSearchParams(GetWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const response = await workspaceFileService.readDownloadFile(workspaceResult, validation.data.path, {
          startDirectory: validation.data.startDirectory,
          signal: req.signal,
        });
        return createFileDownloadResponse(response.stream, response.contentType, response.file, {
          contentLength: response.file.size,
        });
      } catch (error) {
        log.error("Failed to download workspace file", {
          workspaceId: ctx.params["id"]!,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/tree": {
    description: "Load the full workspace file tree.",
    querySchema: GetWorkspaceFileTreeRequestSchema,
    async GET(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      const validation = parseSearchParams(GetWorkspaceFileTreeRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await workspaceFileService.loadTree(workspaceResult, {
          startDirectory: validation.data.startDirectory,
        }));
      } catch (error) {
        log.error("Failed to load workspace file tree", {
          workspaceId: ctx.params["id"]!,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/metadata": {
    description: "Read workspace file metadata.",
    querySchema: GetWorkspaceFileRequestSchema,
    async GET(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      const validation = parseSearchParams(GetWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const file = await workspaceFileService.getMetadata(workspaceResult, validation.data.path, {
          startDirectory: validation.data.startDirectory,
        });
        if (!file) {
          return errorResponse("file_not_found", "Requested file does not exist", 404);
        }
        return Response.json({
          workspaceId: workspaceResult.id,
          file,
        });
      } catch (error) {
        log.error("Failed to fetch workspace file metadata", {
          workspaceId: ctx.params["id"]!,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/write": {
    description: "Write a workspace file with optional conflict checks.",
    requestSchema: WriteWorkspaceFileRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      const validation = await parseAndValidate(WriteWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await workspaceFileService.writeFile(
          workspaceResult,
          validation.data.path,
          validation.data.content,
          {
            expectedVersionToken: validation.data.expectedVersionToken ?? null,
            overwrite: validation.data.overwrite,
            startDirectory: validation.data.startDirectory ?? undefined,
          },
        ));
      } catch (error) {
        log.error("Failed to write workspace file", {
          workspaceId: ctx.params["id"]!,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/rename": {
    description: "Rename a workspace file or directory in the active explorer root.",
    requestSchema: RenameWorkspaceFileRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      const validation = await parseAndValidate(RenameWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await workspaceFileService.renameNode(
          workspaceResult,
          validation.data.path,
          validation.data.newName,
          {
            expectedVersionToken: validation.data.expectedVersionToken ?? undefined,
            overwrite: validation.data.overwrite,
            startDirectory: validation.data.startDirectory ?? undefined,
          },
        ));
      } catch (error) {
        log.error("Failed to rename workspace file", {
          workspaceId: ctx.params["id"]!,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/delete": {
    description: "Delete a workspace file or directory in the active explorer root.",
    requestSchema: DeleteWorkspaceFileRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      const validation = await parseAndValidate(DeleteWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await workspaceFileService.deleteNode(
          workspaceResult,
          validation.data.path,
          {
            expectedVersionToken: validation.data.expectedVersionToken ?? undefined,
            kind: validation.data.kind,
            startDirectory: validation.data.startDirectory ?? undefined,
          },
        ));
      } catch (error) {
        log.error("Failed to delete workspace file", {
          workspaceId: ctx.params["id"]!,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/upload": {
    description: "Create a workspace file upload session.",
    requestSchema: CreateWorkspaceFileUploadRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      const validation = await parseAndValidate(CreateWorkspaceFileUploadRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await workspaceFileService.createUploadSession(
          workspaceResult,
          validation.data.directory,
          validation.data.fileName,
          validation.data.size,
          {
            overwrite: validation.data.overwrite,
            startDirectory: validation.data.startDirectory ?? undefined,
          },
        ), { status: 201 });
      } catch (error) {
        log.error("Failed to create workspace file upload", {
          workspaceId: ctx.params["id"]!,
          directory: validation.data.directory,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/upload/chunk": {
    description: "Upload a raw chunk for a workspace file upload session.",
    querySchema: UploadWorkspaceFileChunkRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      const validation = parseSearchParams(UploadWorkspaceFileChunkRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      if (!req.body) {
        return errorResponse("invalid_upload_chunk", "Upload chunk body is required", 400);
      }

      try {
        return Response.json(await workspaceFileService.writeUploadChunk(
          workspaceResult,
          validation.data.uploadId,
          validation.data.offset,
          req.body,
          {
            startDirectory: validation.data.startDirectory,
            signal: req.signal,
          },
        ));
      } catch (error) {
        log.error("Failed to write workspace file upload chunk", {
          workspaceId: ctx.params["id"]!,
          uploadId: validation.data.uploadId,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/upload/complete": {
    description: "Complete a workspace file upload session.",
    requestSchema: CompleteWorkspaceFileUploadRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      const validation = await parseAndValidate(CompleteWorkspaceFileUploadRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await workspaceFileService.completeUpload(
          workspaceResult,
          validation.data.uploadId,
          {
            startDirectory: validation.data.startDirectory ?? undefined,
          },
        ));
      } catch (error) {
        log.error("Failed to complete workspace file upload", {
          workspaceId: ctx.params["id"]!,
          uploadId: validation.data.uploadId,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/upload/cancel": {
    description: "Cancel a workspace file upload session.",
    requestSchema: CancelWorkspaceFileUploadRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      const validation = await parseAndValidate(CancelWorkspaceFileUploadRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await workspaceFileService.cancelUpload(
          workspaceResult,
          validation.data.uploadId,
          {
            startDirectory: validation.data.startDirectory ?? undefined,
          },
        ));
      } catch (error) {
        log.error("Failed to cancel workspace file upload", {
          workspaceId: ctx.params["id"]!,
          uploadId: validation.data.uploadId,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },
});
