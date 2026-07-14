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
  errorResponse,
} from "../helpers";
import { sanitizeWorkspace, shouldIncludeSensitiveData } from "../../lib/sensitive-data";
import {
  CreateWorkspaceRequestSchema,
  DeleteWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
} from "../../types/schemas";
import { SensitiveQuerySchema } from "../route-schemas";

const log = createLogger("api:workspaces");

function mapDeleteWorkspaceError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("credential token")) {
    return errorResponse("invalid_credential_token", message, 400);
  }
  return errorResponse("delete_failed", `Failed to delete workspace: ${message}`, 500);
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
        return errorResponse("list_failed", `Failed to list workspaces: ${String(error)}`, 500);
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
          return errorResponse(error.code, error.message);
        }
        log.error("Failed to create workspace:", String(error));
        return errorResponse("create_failed", `Failed to create workspace: ${String(error)}`, 500);
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
        return errorResponse("get_failed", `Failed to get workspace: ${String(error)}`, 500);
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
        return errorResponse("update_failed", `Failed to update workspace: ${String(error)}`, 500);
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
          log.warn("DELETE /api/workspaces/:id - Failed", { workspaceId: id, reason: result.reason });
          const reason = result.reason ?? "Delete failed";
          const errorCode = reason === "Workspace not found" ? "workspace_not_found" : "delete_failed";
          const status = reason === "Workspace not found" ? 404 : 400;
          return errorResponse(errorCode, reason, status);
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
