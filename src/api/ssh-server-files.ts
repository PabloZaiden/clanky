/**
 * Standalone SSH server file explorer API routes.
 */

import { sshCredentialManager } from "../core/ssh-credential-manager";
import {
  fileExplorerService,
  resolveFileExplorerRootDirectory,
  type FileExplorerTarget,
} from "../core/file-explorer-service";
import { sshServerManager } from "../core/ssh-server-manager";
import { createLogger } from "../core/logger";
import { type WorkspaceFileEntry } from "../types";
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
} from "../types/schemas";
import { errorResponse } from "./helpers";
import { parseAndValidate, validateRequest } from "./validation";
import { createFileDownloadHeadResponse, createFileDownloadResponse } from "./file-download-response";

const log = createLogger("api:ssh-server-files");
const SSH_CREDENTIAL_TOKEN_HEADER = "x-clanky-ssh-credential-token";

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

  if (message.includes("SSH server not found")) {
    return errorResponse("not_found", message, 404);
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
    return errorResponse("invalid_server_path", message, 400);
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
  if (message.includes("must stay within the active server explorer root")) {
    return errorResponse("invalid_server_path", message, 400);
  }
  if (message.includes("credential token")) {
    return errorResponse("invalid_credential_token", message, 400);
  }
  return errorResponse("ssh_server_file_error", message, 500);
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

async function getServerFileTarget(
  req: Request & { params: { id: string } },
  startDirectory?: string,
  options?: { allowCredentialTokenQuery?: boolean },
): Promise<FileExplorerTarget> {
  const credentialToken = req.headers.get(SSH_CREDENTIAL_TOKEN_HEADER)?.trim()
    || (options?.allowCredentialTokenQuery
      ? new URL(req.url).searchParams.get("credentialToken")?.trim()
      : undefined);
  if (!credentialToken) {
    throw new Error("SSH credential token is required for standalone server file access");
  }

  const server = await sshServerManager.getServer(req.params.id);
  if (!server) {
    throw new Error(`SSH server not found: ${req.params.id}`);
  }

  const password = sshCredentialManager.getPasswordForToken(server.config.id, credentialToken);
  const connection = await sshServerManager.getCommandExecutor(server.config.id, password);
  const rootDirectory = await resolveFileExplorerRootDirectory(
    connection.executor,
    server.config.repositoriesBasePath?.trim() || "/",
    startDirectory,
  );

  return {
    id: server.config.id,
    rootDirectory,
    pathScopeLabel: "active server explorer root",
    executor: connection.executor,
  };
}

export const sshServerFilesRoutes = {
  "/api/ssh-servers/:id/files": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = parseSearchParams(ListWorkspaceFilesRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined);
        const response = await fileExplorerService.listDirectory(
          target,
          validation.data.path,
          { includeHidden: true },
        );
        return Response.json({
          serverId: req.params.id,
          directory: response.directory,
          entries: response.entries,
        });
      } catch (error) {
        log.error("Failed to list standalone SSH server files", {
          serverId: req.params.id,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/ssh-servers/:id/files/content": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = parseSearchParams(GetWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined);
        const response = await fileExplorerService.readFile(target, validation.data.path);
        return Response.json({
          serverId: req.params.id,
          file: response.file,
          content: response.content,
        });
      } catch (error) {
        log.error("Failed to read standalone SSH server file", {
          serverId: req.params.id,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/ssh-servers/:id/files/preview": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = parseSearchParams(GetWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined);
        const response = await fileExplorerService.readImageFile(target, validation.data.path);
        return createInlineImageResponse(response.data, response.contentType, response.file.name);
      } catch (error) {
        log.error("Failed to preview standalone SSH server file", {
          serverId: req.params.id,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/ssh-servers/:id/files/download": {
    async HEAD(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = parseSearchParams(GetWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined, {
          allowCredentialTokenQuery: true,
        });
        const response = await fileExplorerService.getDownloadMetadata(target, validation.data.path);
        return createFileDownloadHeadResponse(response.contentType, response.file, {
          contentLength: response.file.size,
        });
      } catch (error) {
        log.error("Failed to fetch standalone SSH server file download metadata", {
          serverId: req.params.id,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },

    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = parseSearchParams(GetWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined, {
          allowCredentialTokenQuery: true,
        });
        const response = await fileExplorerService.readDownloadFile(target, validation.data.path, {
          signal: req.signal,
        });
        return createFileDownloadResponse(response.stream, response.contentType, response.file, {
          contentLength: response.file.size,
        });
      } catch (error) {
        log.error("Failed to download standalone SSH server file", {
          serverId: req.params.id,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/ssh-servers/:id/files/tree": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = parseSearchParams(GetWorkspaceFileTreeRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined);
        const response = await fileExplorerService.loadTree(target);
        return Response.json({
          serverId: req.params.id,
          entriesByDirectory: response.entriesByDirectory,
        });
      } catch (error) {
        log.error("Failed to load standalone SSH server file tree", {
          serverId: req.params.id,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/ssh-servers/:id/files/metadata": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = parseSearchParams(GetWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined);
        const file = await fileExplorerService.getMetadata(target, validation.data.path);
        if (!file) {
          return errorResponse("file_not_found", "Requested file does not exist", 404);
        }
        return Response.json({
          serverId: req.params.id,
          file,
        });
      } catch (error) {
        log.error("Failed to fetch standalone SSH server file metadata", {
          serverId: req.params.id,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/ssh-servers/:id/files/write": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(WriteWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined);
        const response = await fileExplorerService.writeFile(
          target,
          validation.data.path,
          validation.data.content,
          {
            expectedVersionToken: validation.data.expectedVersionToken ?? null,
            overwrite: validation.data.overwrite,
          },
        );
        return Response.json({
          success: response.success,
          serverId: req.params.id,
          file: response.file,
          overwritten: response.overwritten,
        });
      } catch (error) {
        log.error("Failed to write standalone SSH server file", {
          serverId: req.params.id,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/ssh-servers/:id/files/rename": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(RenameWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined);
        const response = await fileExplorerService.renameNode(
          target,
          validation.data.path,
          validation.data.newName,
          {
            expectedVersionToken: validation.data.expectedVersionToken ?? undefined,
            overwrite: validation.data.overwrite,
          },
        );
        return Response.json({
          success: true,
          serverId: req.params.id,
          file: response.file,
          previousPath: response.previousPath,
          overwritten: response.overwritten,
        });
      } catch (error) {
        log.error("Failed to rename standalone SSH server file", {
          serverId: req.params.id,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/ssh-servers/:id/files/delete": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(DeleteWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined);
        const response = await fileExplorerService.deleteNode(target, validation.data.path, {
          expectedVersionToken: validation.data.expectedVersionToken ?? undefined,
          kind: validation.data.kind,
        });
        return Response.json({
          success: true,
          serverId: req.params.id,
          deletedPath: response.deletedPath,
          kind: response.kind,
        });
      } catch (error) {
        log.error("Failed to delete standalone SSH server file", {
          serverId: req.params.id,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/ssh-servers/:id/files/upload": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(CreateWorkspaceFileUploadRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined);
        const response = await fileExplorerService.createUploadSession(
          target,
          validation.data.directory,
          validation.data.fileName,
          validation.data.size,
          {
            overwrite: validation.data.overwrite,
          },
        );
        return Response.json({
          serverId: req.params.id,
          ...response,
        }, { status: 201 });
      } catch (error) {
        log.error("Failed to create standalone SSH server file upload", {
          serverId: req.params.id,
          directory: validation.data.directory,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/ssh-servers/:id/files/upload/chunk": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = parseSearchParams(UploadWorkspaceFileChunkRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      if (!req.body) {
        return errorResponse("invalid_upload_chunk", "Upload chunk body is required", 400);
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined);
        const response = await fileExplorerService.writeUploadChunk(
          target,
          validation.data.uploadId,
          validation.data.offset,
          req.body,
          {
            signal: req.signal,
          },
        );
        return Response.json({
          success: true,
          serverId: req.params.id,
          uploadId: response.uploadId,
          bytesWritten: response.bytesWritten,
          nextOffset: response.nextOffset,
        });
      } catch (error) {
        log.error("Failed to write standalone SSH server file upload chunk", {
          serverId: req.params.id,
          uploadId: validation.data.uploadId,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/ssh-servers/:id/files/upload/complete": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(CompleteWorkspaceFileUploadRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined);
        const response = await fileExplorerService.completeUpload(target, validation.data.uploadId);
        return Response.json({
          success: true,
          serverId: req.params.id,
          file: response.file,
          overwritten: response.overwritten,
        });
      } catch (error) {
        log.error("Failed to complete standalone SSH server file upload", {
          serverId: req.params.id,
          uploadId: validation.data.uploadId,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/ssh-servers/:id/files/upload/cancel": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(CancelWorkspaceFileUploadRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory ?? undefined);
        const response = await fileExplorerService.cancelUpload(target, validation.data.uploadId);
        return Response.json({
          success: true,
          serverId: req.params.id,
          uploadId: response.uploadId,
        });
      } catch (error) {
        log.error("Failed to cancel standalone SSH server file upload", {
          serverId: req.params.id,
          uploadId: validation.data.uploadId,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },
};
