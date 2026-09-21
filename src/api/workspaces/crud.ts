import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * CRUD route handlers for workspace entities.
 * Covers list, create, get, update, and delete operations.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import { isDomainError } from "../../domain/domain-error";
import { workspaceManager } from "../../core/workspace-manager";
import { parseAndValidate } from "../validation";
import {
  domainErrorResponse,
  errorResponse,
  internalErrorResponse,
  requireWorkspace,
} from "../helpers";
import { sanitizeWorkspace, shouldIncludeSensitiveData } from "../../lib/sensitive-data";
import { CreateWorkspaceRequestSchema, DeleteWorkspaceRequestSchema, UpdateWorkspaceRequestSchema } from "@/contracts/schemas";
import { SensitiveQuerySchema } from "../route-schemas";

const log = createLogger("api:workspaces");

function mapDeleteWorkspaceError(error: unknown): Response {
  return domainErrorResponse(error, {
    policy: "workspaces",
    fallback: {
      error: "delete_failed",
      message: "Failed to delete workspace",
      status: 500,
    },
  });
}

function logWorkspaceMutationFailure(
  operation: "create" | "update",
  workspaceId: string | undefined,
  error: unknown,
  response: Response,
): void {
  const context = {
    ...(workspaceId ? { workspaceId } : {}),
    status: response.status,
    ...(isDomainError(error) ? { errorCode: error.code } : { error: String(error) }),
  };
  if (response.status >= 500) {
    log.error(`Failed to ${operation} workspace`, context);
  } else {
    log.warn(`Rejected workspace ${operation}`, context);
  }
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
        const response = domainErrorResponse(error, {
          policy: "workspaces",
          fallback: {
            error: "create_failed",
            message: "Failed to create workspace",
            status: 500,
          },
        });
        logWorkspaceMutationFailure("create", undefined, error, response);
        return response;
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
        const response = domainErrorResponse(error, {
          policy: "workspaces",
          fallback: {
            error: "update_failed",
            message: "Failed to update workspace",
            status: 500,
          },
        });
        logWorkspaceMutationFailure("update", id, error, response);
        return response;
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
            policy: "workspaces",
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
