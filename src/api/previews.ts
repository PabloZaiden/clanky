import { defineRoutes, type RouteContext } from "@pablozaiden/webapp/server";
/**
 * Workspace live preview API routes.
 */

import { previewSessionManager } from "../core/preview-session-manager";
import { createLogger } from "../core/logger";
import { errorResponse, successResponse } from "./helpers";

const log = createLogger("api:previews");

function mapPreviewError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not found")) {
    return errorResponse("not_found", message, 404);
  }
  if (message.includes("ambiguous")) {
    return errorResponse("workspace_name_ambiguous", message, 409);
  }
  return errorResponse("preview_error", message, 500);
}

export const previewRoutes = defineRoutes({
  "/api/workspaces/:workspaceId/previews": {
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

  "/api/previews": {
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
