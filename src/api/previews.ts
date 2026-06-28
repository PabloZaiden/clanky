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
    return errorResponse("ambiguous_workspace", message, 409);
  }
  return errorResponse("preview_error", message, 500);
}

export const previewRoutes = {
  "/api/workspaces/:workspaceId/previews": {
    async GET(req: Request & { params: { workspaceId: string } }): Promise<Response> {
      try {
        const previews = await previewSessionManager.listWorkspacePreviews(req.params.workspaceId);
        return Response.json(previews);
      } catch (error) {
        log.error("GET /api/workspaces/:workspaceId/previews - Failed", {
          workspaceId: req.params.workspaceId,
          error: String(error),
        });
        return mapPreviewError(error);
      }
    },
  },

  "/api/previews": {
    async GET(): Promise<Response> {
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
    async DELETE(req: Request & { params: { previewId: string } }): Promise<Response> {
      try {
        const closed = await previewSessionManager.closePreview(req.params.previewId, "Closed from web UI");
        if (!closed) {
          return errorResponse("not_found", "Preview not found", 404);
        }
        return successResponse();
      } catch (error) {
        log.error("DELETE /api/previews/:previewId - Failed", {
          previewId: req.params.previewId,
          error: String(error),
        });
        return mapPreviewError(error);
      }
    },
  },
};
