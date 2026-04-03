/**
 * Workspace file explorer API routes.
 */

import { createLogger } from "../../core/logger";
import { workspaceFileService } from "../../core/workspace-file-service";
import { type WorkspaceFileEntry } from "../../types";
import {
  GetWorkspaceFileRequestSchema,
  GetWorkspaceFileTreeRequestSchema,
  ListWorkspaceFilesRequestSchema,
  WriteWorkspaceFileRequestSchema,
} from "../../types/schemas";
import { errorResponse, requireWorkspace } from "../helpers";
import { parseAndValidate, validateRequest } from "../validation";

const log = createLogger("api:workspace-files");

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

export const workspaceFilesRoutes = {
  "/api/workspaces/:id/files": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const workspaceResult = await requireWorkspace(req.params.id);
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
          workspaceId: req.params.id,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/content": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const workspaceResult = await requireWorkspace(req.params.id);
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
          workspaceId: req.params.id,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/tree": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const workspaceResult = await requireWorkspace(req.params.id);
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
          workspaceId: req.params.id,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/metadata": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const workspaceResult = await requireWorkspace(req.params.id);
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
          workspaceId: req.params.id,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },

  "/api/workspaces/:id/files/write": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const workspaceResult = await requireWorkspace(req.params.id);
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
            startDirectory: validation.data.startDirectory,
          },
        ));
      } catch (error) {
        log.error("Failed to write workspace file", {
          workspaceId: req.params.id,
          path: validation.data.path,
          error: String(error),
        });
        return mapFileError(error);
      }
    },
  },
};
