import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Models listing API route.
 *
 * - GET /api/models - Get available AI models for a workspace
 *
 * @module api/models/models-routes
 */

import { createLogger } from "../../core/logger";
import { errorResponse, requireWorkspace } from "../helpers";
import { getModelVariantsForWorkspace, getModelsForWorkspace } from "./model-discovery";

const log = createLogger("api:models");

/**
 * Models API routes.
 */
export const modelsRoutes = defineRoutes({
  "/api/models/variants": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List available model variants for a workspace.",
    /**
     * GET /api/models/variants - Get lazily discovered variants for one model.
     *
     * Query Parameters:
     * - workspaceId (required): Workspace containing the model
     * - modelID (required): Model ID selected by the client
     * - providerID (optional, ignored): Provider comes from workspace settings
     *
     * @returns Object with variants array
     */
    async GET(req: Request, _ctx): Promise<Response> {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get("workspaceId");
      const modelID = url.searchParams.get("modelID");

      if (!workspaceId) {
        return errorResponse("missing_workspace_id", "workspaceId query parameter is required");
      }

      if (!modelID) {
        return errorResponse("missing_model_id", "modelID query parameter is required");
      }

      const workspace = await requireWorkspace(workspaceId);
      if (workspace instanceof Response) {
        return workspace;
      }

      try {
        const variants = await getModelVariantsForWorkspace(
          workspaceId,
          modelID,
          workspace,
        );
        return Response.json({ variants });
      } catch (error) {
        log.error("Failed to discover model variants", {
          workspaceId,
          modelID,
          error: String(error),
        });
        return errorResponse("model_variants_failed", String(error), 500);
      }
    },
  },

  "/api/models": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List available AI models for a workspace.",
    /**
     * GET /api/models - Get available AI models.
     *
     * Fetches the list of available AI models using provider-aware discovery.
     *
     * Query Parameters:
     * - workspaceId (required): Workspace to query
     *
     * @returns Array of ModelInfo objects with provider and model details
     */
    async GET(req: Request, _ctx): Promise<Response> {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get("workspaceId");

      if (!workspaceId) {
        return errorResponse("missing_workspace_id", "workspaceId query parameter is required");
      }

      // Get workspace-specific server settings
      const workspace = await requireWorkspace(workspaceId);
      if (workspace instanceof Response) {
        return workspace;
      }

      try {
        const models = await getModelsForWorkspace(workspaceId, workspace);
        return Response.json(models);
      } catch (error) {
        log.error("Failed to discover models", {
          workspaceId,
          error: String(error),
        });
        return errorResponse("models_failed", String(error), 500);
      }
    },
  },
});
