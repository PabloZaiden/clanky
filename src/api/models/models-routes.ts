/**
 * Models listing API route.
 *
 * - GET /api/models - Get available AI models for a workspace
 *
 * @module api/models/models-routes
 */

import { getWorkspace } from "../../persistence/workspaces";
import { createLogger } from "../../core/logger";
import { errorResponse } from "../helpers";
import { getModelVariantsForWorkspace, getModelsForWorkspace } from "./model-discovery";

const log = createLogger("api:models");

/**
 * Models API routes.
 */
export const modelsRoutes = {
  "/api/models/variants": {
    /**
     * GET /api/models/variants - Get lazily discovered variants for one model.
     *
     * Query Parameters:
     * - directory (required): Working directory path for model context
     * - workspaceId (required): Workspace ID to use for server settings
     * - modelID (required): Model ID selected by the client
     * - providerID (optional, ignored): Provider comes from workspace settings
     *
     * @returns Object with variants array
     */
    async GET(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const directory = url.searchParams.get("directory");
      const workspaceId = url.searchParams.get("workspaceId");
      const modelID = url.searchParams.get("modelID");

      if (!directory) {
        return errorResponse("missing_directory", "directory query parameter is required");
      }

      if (!workspaceId) {
        return errorResponse("missing_workspace_id", "workspaceId query parameter is required");
      }

      if (!modelID) {
        return errorResponse("missing_model_id", "modelID query parameter is required");
      }

      const workspace = await getWorkspace(workspaceId);
      if (!workspace) {
        return errorResponse("workspace_not_found", `Workspace not found: ${workspaceId}`, 404);
      }

      try {
        const variants = await getModelVariantsForWorkspace(
          workspaceId,
          directory,
          modelID,
          workspace,
        );
        return Response.json({ variants });
      } catch (error) {
        log.error("Failed to discover model variants", {
          workspaceId,
          directory,
          modelID,
          error: String(error),
        });
        return errorResponse("model_variants_failed", String(error), 500);
      }
    },
  },

  "/api/models": {
    /**
     * GET /api/models - Get available AI models.
     *
     * Fetches the list of available AI models using provider-aware discovery.
     *
     * Query Parameters:
     * - directory (required): Working directory path for model context
     * - workspaceId (required): Workspace ID to use for server settings
     *
     * @returns Array of ModelInfo objects with provider and model details
     */
    async GET(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const directory = url.searchParams.get("directory");
      const workspaceId = url.searchParams.get("workspaceId");

      if (!directory) {
        return errorResponse("missing_directory", "directory query parameter is required");
      }

      if (!workspaceId) {
        return errorResponse("missing_workspace_id", "workspaceId query parameter is required");
      }

      // Get workspace-specific server settings
      const workspace = await getWorkspace(workspaceId);
      if (!workspace) {
        return errorResponse("workspace_not_found", `Workspace not found: ${workspaceId}`, 404);
      }

      try {
        const models = await getModelsForWorkspace(workspaceId, directory, workspace);
        return Response.json(models);
      } catch (error) {
        log.error("Failed to discover models", {
          workspaceId,
          directory,
          error: String(error),
        });
        return errorResponse("models_failed", String(error), 500);
      }
    },
  },
};
