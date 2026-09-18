import { defineRoutes, type RouteContext } from "@pablozaiden/webapp/server";
/**
 * Workspace and direct execution-host live preview API routes.
 */

import { previewSessionManager } from "../core/preview-session-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { executionHostRefFromParts } from "@/shared";
import { domainErrorResponse, errorResponse, successResponse } from "./helpers";

const log = createLogger("api:previews");

function mapPreviewError(error: unknown): Response {
  return domainErrorResponse(error, {
    mappings: {
      workspace_not_found: {
        error: "not_found",
        message: "Workspace not found",
        status: 404,
      },
      workspace_name_ambiguous: {
        status: 409,
      },
      workspace_reference_required: {
        status: 400,
      },
      execution_host_kind_invalid: {
        status: 400,
      },
      execution_host_reference_required: {
        status: 400,
      },
      execution_host_name_ambiguous: {
        status: 409,
      },
      execution_host_not_found: {
        status: 404,
      },
      execution_host_unavailable: {
        status: 404,
      },
      execution_host_private: {
        status: 409,
      },
      execution_host_capability_unavailable: {
        status: 409,
        message: "This execution host does not support direct previews.",
      },
      preview_server_unsupported: {
        status: 409,
      },
    },
    fallback: {
      error: "preview_error",
      message: "Preview operation failed",
      status: 500,
    },
  });
}

export const previewRoutes = defineRoutes({
  "/api/workspaces/:workspaceId/previews": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List previews for a workspace.",
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const previews = await previewSessionManager.listWorkspacePreviews(ctx.params["workspaceId"]!);
        return Response.json(previews);
      } catch (error) {
        log.error("GET /api/workspaces/:workspaceId/previews - Failed", {
          workspaceId: ctx.params["workspaceId"]!,
          error: String(error),
        });
        return mapPreviewError(error);
      }
    },
  },

  "/api/execution-hosts/:kind/:id/previews": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List direct previews for a local or Mesh execution host.",
    async GET(_req: Request, ctx): Promise<Response> {
      const ref = executionHostRefFromParts(
        ctx.params["kind"]!,
        ctx.params["id"]!,
      );
      if (!ref) {
        return errorResponse(
          "execution_host_kind_invalid",
          "Execution host kind must be local, mesh, or ssh.",
          400,
        );
      }
      try {
        const previews = await previewSessionManager.listServerPreviews(ref);
        return Response.json(previews);
      } catch (error) {
        log.error("GET /api/execution-hosts/:kind/:id/previews - Failed", {
          kind: ref.kind,
          error: String(error),
        });
        return mapPreviewError(error);
      }
    },
  },

  "/api/previews": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List all active previews for the current user.",
    async GET(_req: Request, _ctx: RouteContext): Promise<Response> {
      try {
        const previews = await previewSessionManager.listActivePreviews();
        return Response.json(previews);
      } catch (error) {
        log.error("GET /api/previews - Failed", { error: String(error) });
        return mapPreviewError(error);
      }
    },
  },

  "/api/previews/:previewId": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Close an active preview.",
    async DELETE(_req: Request, ctx): Promise<Response> {
      try {
        const closed = await previewSessionManager.closePreview(ctx.params["previewId"]!, "Closed from web UI");
        if (!closed) {
          return errorResponse("not_found", "Preview not found", 404);
        }
        return successResponse();
      } catch (error) {
        log.error("DELETE /api/previews/:previewId - Failed", {
          previewId: ctx.params["previewId"]!,
          error: String(error),
        });
        return mapPreviewError(error);
      }
    },
  },
});
