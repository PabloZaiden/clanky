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
  GetWorkspaceFileRequestSchema,
  ListWorkspaceFilesRequestSchema,
  WriteWorkspaceFileRequestSchema,
} from "../types/schemas";
import { errorResponse } from "./helpers";
import { parseAndValidate, validateRequest } from "./validation";

const log = createLogger("api:ssh-server-files");
const SSH_CREDENTIAL_TOKEN_HEADER = "x-ralpher-ssh-credential-token";

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
): Promise<FileExplorerTarget> {
  const credentialToken = req.headers.get(SSH_CREDENTIAL_TOKEN_HEADER)?.trim();
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
        const target = await getServerFileTarget(req, validation.data.startDirectory);
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
        const target = await getServerFileTarget(req, validation.data.startDirectory);
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

  "/api/ssh-servers/:id/files/metadata": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = parseSearchParams(GetWorkspaceFileRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const target = await getServerFileTarget(req, validation.data.startDirectory);
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
        const target = await getServerFileTarget(req, validation.data.startDirectory);
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
};
