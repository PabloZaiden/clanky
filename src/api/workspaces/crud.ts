/**
 * CRUD route handlers for workspace entities.
 * Covers list, create, get, update, and delete operations.
 */

import {
  createWorkspace,
  listWorkspaces,
  updateWorkspace,
  deleteWorkspace,
} from "../../persistence/workspaces";
import { backendManager } from "../../core/backend-manager";
import { createLogger } from "../../core/logger";
import { areServerSettingsEqual, getDefaultServerSettings } from "../../types/settings";
import type { Workspace } from "../../types/workspace";
import { parseAndValidate } from "../validation";
import {
  requireWorkspace,
  errorResponse,
} from "../helpers";
import { sanitizeWorkspace, shouldIncludeSensitiveData } from "../../lib/sensitive-data";
import {
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
} from "../../types/schemas";

const log = createLogger("api:workspaces");

export const crudRoutes = {
  /**
   * GET /api/workspaces - List all workspaces
   * POST /api/workspaces - Create a new workspace
   */
  "/api/workspaces": {
    async GET(req: Request) {
      log.debug("GET /api/workspaces - Listing all workspaces");
      try {
        const includeSensitive = shouldIncludeSensitiveData(req);
        const workspaces = await listWorkspaces();
        log.debug("GET /api/workspaces - Retrieved workspaces", { count: workspaces.length });
        return Response.json(includeSensitive ? workspaces : workspaces.map(sanitizeWorkspace));
      } catch (error) {
        log.error("Failed to list workspaces:", String(error));
        return errorResponse("list_failed", `Failed to list workspaces: ${String(error)}`, 500);
      }
    },

    async POST(req: Request) {
      log.debug("POST /api/workspaces - Creating new workspace");
      const result = await parseAndValidate(CreateWorkspaceRequestSchema, req);

      if (!result.success) {
        log.debug("POST /api/workspaces - Validation failed");
        return result.response;
      }

      const body = result.data;

      // Validate serverSettings - use default if not provided
      const serverSettings = body.serverSettings ?? getDefaultServerSettings();

      // Trim name and directory to prevent whitespace issues
      const trimmedName = body.name.trim();
      const trimmedDirectory = body.directory.trim();

      try {
        // Validate directory is a git repository on the remote server
        log.debug("Validating workspace directory on remote server", {
          directory: trimmedDirectory,
          name: trimmedName,
          agentProvider: serverSettings.agent.provider,
          agentTransport: serverSettings.agent.transport,
        });

        const validation = await backendManager.validateRemoteDirectory(serverSettings, trimmedDirectory);

        if (!validation.success) {
          log.warn("Failed to validate remote directory", {
            directory: trimmedDirectory,
            error: validation.error,
          });
          return errorResponse("validation_failed", `Failed to validate directory: ${validation.error}`);
        }

        // Check if directory exists first to provide a clearer error message
        if (validation.directoryExists === false) {
          log.warn("Directory does not exist on remote server", { directory: trimmedDirectory });
          return errorResponse("directory_not_found", "Directory does not exist on the remote server");
        }

        if (!validation.isGitRepo) {
          log.warn("Directory is not a git repository", { directory: trimmedDirectory });
          return errorResponse("not_git_repo", "Directory must be a git repository");
        }

        const now = new Date().toISOString();
        const workspace: Workspace = {
          id: crypto.randomUUID(),
          name: trimmedName,
          directory: trimmedDirectory,
          serverSettings,
          createdAt: now,
          updatedAt: now,
        };

        await createWorkspace(workspace);
        log.info(`Created workspace: ${workspace.name} (${workspace.directory})`);

        return Response.json(workspace, { status: 201 });
      } catch (error) {
        log.error("Failed to create workspace:", String(error));
        return errorResponse("create_failed", `Failed to create workspace: ${String(error)}`, 500);
      }
    },
  },

  /**
   * GET /PUT /DELETE /api/workspaces/:id - Single workspace operations
   */
  "/api/workspaces/:id": {
    async GET(req: Request & { params: { id: string } }) {
      const { id } = req.params;
      log.debug("GET /api/workspaces/:id", { workspaceId: id });
      try {
        const result = await requireWorkspace(id);
        if (result instanceof Response) {
          log.debug("GET /api/workspaces/:id - Workspace not found", { workspaceId: id });
          return result;
        }
        return Response.json(shouldIncludeSensitiveData(req) ? result : sanitizeWorkspace(result));
      } catch (error) {
        log.error("Failed to get workspace:", String(error));
        return errorResponse("get_failed", `Failed to get workspace: ${String(error)}`, 500);
      }
    },

    async PUT(req: Request & { params: { id: string } }) {
      const { id } = req.params;
      log.debug("PUT /api/workspaces/:id", { workspaceId: id });
      const includeSensitive = shouldIncludeSensitiveData(req);
      const result = await parseAndValidate(UpdateWorkspaceRequestSchema, req);

      if (!result.success) {
        log.debug("PUT /api/workspaces/:id - Validation failed", { workspaceId: id });
        return result.response;
      }

      const body = result.data;

      try {
        const currentWorkspace = await requireWorkspace(id);
        if (currentWorkspace instanceof Response) {
          return currentWorkspace;
        }

        const nameChanged = body.name !== undefined && body.name !== currentWorkspace.name;
        const serverSettingsChanged = body.serverSettings !== undefined
          && !areServerSettingsEqual(currentWorkspace.serverSettings, body.serverSettings);

        if (!nameChanged && !serverSettingsChanged) {
          log.info(`Workspace unchanged: ${currentWorkspace.name}`);
          return Response.json(includeSensitive ? currentWorkspace : sanitizeWorkspace(currentWorkspace));
        }

        const workspaceUpdates: Partial<Pick<Workspace, "name" | "serverSettings">> = {};
        if (nameChanged) {
          workspaceUpdates.name = body.name;
        }
        if (serverSettingsChanged && body.serverSettings) {
          workspaceUpdates.serverSettings = body.serverSettings;
        }

        const workspace = await updateWorkspace(id, workspaceUpdates);
        if (!workspace) {
          log.debug("PUT /api/workspaces/:id - Workspace not found", { workspaceId: id });
          return errorResponse("workspace_not_found", "Workspace not found", 404);
        }

        // Reset connection if server settings were updated so new config takes effect
        if (serverSettingsChanged) {
          await backendManager.resetWorkspaceConnection(id);
        }

        log.info(`Updated workspace: ${workspace.name}`);
        return Response.json(includeSensitive ? workspace : sanitizeWorkspace(workspace));
      } catch (error) {
        log.error("Failed to update workspace:", String(error));
        return errorResponse("update_failed", `Failed to update workspace: ${String(error)}`, 500);
      }
    },

    async DELETE(req: Request & { params: { id: string } }) {
      const { id } = req.params;
      log.debug("DELETE /api/workspaces/:id", { workspaceId: id });
      try {
        const result = await deleteWorkspace(id);
        if (!result.success) {
          log.warn("DELETE /api/workspaces/:id - Failed", { workspaceId: id, reason: result.reason });
          const reason = result.reason ?? "Delete failed";
          const errorCode = reason === "Workspace not found" ? "workspace_not_found" : "delete_failed";
          const status = reason === "Workspace not found" ? 404 : 400;
          return errorResponse(errorCode, reason, status);
        }
        await backendManager.resetWorkspaceConnection(id);
        log.info(`Deleted workspace: ${id}`);
        return Response.json({ success: true });
      } catch (error) {
        log.error("Failed to delete workspace:", String(error));
        return errorResponse("delete_failed", `Failed to delete workspace: ${String(error)}`, 500);
      }
    },
  },
};
