import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * CRUD route handlers for workspace entities.
 * Covers list, create, get, update, and delete operations.
 */

import { createLogger } from "../../core/logger";
import { isDomainError } from "../../core/domain-error";
import { workspaceManager } from "../../core/workspace-manager";
import { parseAndValidate } from "../validation";
import {
  requireWorkspace,
  domainErrorResponse,
  errorResponse,
  internalErrorResponse,
} from "../helpers";
import { sanitizeWorkspace, shouldIncludeSensitiveData } from "../../lib/sensitive-data";
import { CreateWorkspaceRequestSchema, DeleteWorkspaceRequestSchema, UpdateWorkspaceRequestSchema } from "@/contracts/schemas";
import { SensitiveQuerySchema } from "../route-schemas";

const log = createLogger("api:workspaces");

function mapDeleteWorkspaceError(error: unknown): Response {
  return domainErrorResponse(error, {
    mappings: {
      invalid_credential_token: {
        status: 400,
      },
      workspace_delete_metadata_invalid: {
        status: 400,
      },
      workspace_delete_remote_failed: {
        status: 500,
        message: "Failed to delete the auto-provisioned workspace directory",
      },
    },
    fallback: {
      error: "delete_failed",
      message: "Failed to delete workspace",
      status: 500,
    },
  });
}

export const crudRoutes = defineRoutes({
  /**
   * GET /api/workspaces - List all workspaces
   * POST /api/workspaces - Create a new workspace
   */
  "/api/workspaces": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List workspaces or create a workspace.",
    requestSchema: CreateWorkspaceRequestSchema,
    querySchema: SensitiveQuerySchema,
    async GET(req: Request, _ctx) {
      log.debug("GET /api/workspaces - Listing all workspaces");
      try {
        const includeSensitive = shouldIncludeSensitiveData(req);
        const workspaces = await workspaceManager.listWorkspaces();
        log.debug("GET /api/workspaces - Retrieved workspaces", { count: workspaces.length });
        return Response.json(includeSensitive ? workspaces : workspaces.map(sanitizeWorkspace));
      } catch (error) {
        log.error("Failed to list workspaces:", String(error));
        return internalErrorResponse(error, {
          error: "list_failed",
          message: "Failed to list workspaces",
          status: 500,
        });
      }
    },

    async POST(req: Request, _ctx) {
      log.debug("POST /api/workspaces - Creating new workspace");
      const result = await parseAndValidate(CreateWorkspaceRequestSchema, req);

      if (!result.success) {
        log.debug("POST /api/workspaces - Validation failed");
        return result.response;
      }

      const body = result.data;

      try {
        const workspace = await workspaceManager.createWorkspace(body);
        log.info(`Created workspace: ${workspace.name} (${workspace.directory})`);
        return Response.json(workspace, { status: 201 });
      } catch (error) {
        if (isDomainError(error)) {
          return domainErrorResponse(error, {
            mappings: {
              validation_failed: {
                status: 400,
                message: "Failed to validate the workspace directory",
              },
              directory_not_found: {
                status: 400,
                message: "Directory does not exist on the remote server",
              },
              not_git_repo: {
                status: 400,
                message: "Directory must be a git repository",
              },
            },
            fallback: {
              error: "create_failed",
              message: "Failed to create workspace",
              status: 500,
            },
          });
        }
        log.error("Failed to create workspace:", String(error));
        return internalErrorResponse(error, {
          error: "create_failed",
          message: "Failed to create workspace",
          status: 500,
        });
      }
    },
  },

  /**
   * GET /PUT /DELETE /api/workspaces/:id - Single workspace operations
   */
  "/api/workspaces/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read, update, or delete a workspace.",
    requestSchema: UpdateWorkspaceRequestSchema,
    querySchema: SensitiveQuerySchema,
    async GET(req: Request, ctx) {
      const id = ctx.params["id"]!;
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
        return internalErrorResponse(error, {
          error: "get_failed",
          message: "Failed to get workspace",
          status: 500,
        });
      }
    },

    async PUT(req: Request, ctx) {
      const id = ctx.params["id"]!;
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

        const workspace = await workspaceManager.updateWorkspace(id, body);
        if (!workspace) {
          log.debug("PUT /api/workspaces/:id - Workspace not found", { workspaceId: id });
          return errorResponse("workspace_not_found", "Workspace not found", 404);
        }

        if (workspace.updatedAt === currentWorkspace.updatedAt) {
          log.info(`Workspace unchanged: ${currentWorkspace.name}`);
        } else {
          log.info(`Updated workspace: ${workspace.name}`);
        }
        return Response.json(includeSensitive ? workspace : sanitizeWorkspace(workspace));
      } catch (error) {
        log.error("Failed to update workspace:", String(error));
        return internalErrorResponse(error, {
          error: "update_failed",
          message: "Failed to update workspace",
          status: 500,
        });
      }
    },

    async DELETE(req: Request, ctx) {
      const id = ctx.params["id"]!;
      log.debug("DELETE /api/workspaces/:id", { workspaceId: id });
      const validation = await parseAndValidate(DeleteWorkspaceRequestSchema, req, {
        allowEmptyBody: true,
        emptyBodyValue: {},
      });

      if (!validation.success) {
        return validation.response;
      }

      try {
        const result = await workspaceManager.deleteWorkspace(id, validation.data);
        if (!result.success) {
          log.warn("DELETE /api/workspaces/:id - Failed", {
            workspaceId: id,
            errorCode: result.error.code,
          });
          return domainErrorResponse(result.error, {
            mappings: {
              workspace_not_found: {
                status: 404,
              },
              workspace_has_tasks: {
                status: 400,
              },
              workspace_deletion_in_progress: {
                status: 409,
              },
              workspace_not_auto_provisioned: {
                status: 400,
              },
            },
            fallback: {
              error: "delete_failed",
              message: "Failed to delete workspace",
              status: 500,
            },
          });
        }
        log.info(`Deleted workspace: ${id}`);
        return Response.json({ success: true });
      } catch (error) {
        log.error("Failed to delete workspace:", String(error));
        return mapDeleteWorkspaceError(error);
      }
    },
  },
});
