/**
 * Loop item routes.
 *
 * - GET /api/loops/:id - Get a specific loop
 * - PATCH /api/loops/:id - Update any loop's configuration
 * - PUT /api/loops/:id - Update a draft loop's configuration
 * - DELETE /api/loops/:id - Delete a loop
 */

import { loopManager } from "../../core/loop-manager";
import { createLogger } from "../../core/logger";
import { parseAndValidate } from "../validation";
import { errorResponse, successResponse } from "../helpers";
import type { LoopConfig, Loop } from "../../types/loop";
import type { z } from "zod";
import { UpdateLoopRequestSchema } from "../../types/schemas";

const log = createLogger("api:loops");

/**
 * Transform a validated update request body into LoopConfig updates and apply them.
 * Shared by PATCH and PUT handlers to eliminate duplication.
 *
 * @returns Response with the updated loop or an error response
 */
async function applyLoopUpdates(
  loopId: string,
  body: z.infer<typeof UpdateLoopRequestSchema>,
  currentLoop: Loop,
): Promise<Response> {
  try {
    const updates: Partial<Omit<LoopConfig, "id" | "createdAt">> = {};

    if (body.name !== undefined) {
      const trimmedName = body.name.trim();
      if (trimmedName === "") {
        return errorResponse("validation_error", "Name cannot be empty");
      }
      updates.name = trimmedName;
    }
    if (body.directory !== undefined) updates.directory = body.directory;
    if (body.prompt !== undefined) updates.prompt = body.prompt;
    if (body.maxIterations !== undefined) updates.maxIterations = body.maxIterations;
    if (body.maxConsecutiveErrors !== undefined) updates.maxConsecutiveErrors = body.maxConsecutiveErrors;
    if (body.activityTimeoutSeconds !== undefined) updates.activityTimeoutSeconds = body.activityTimeoutSeconds;
    if (body.stopPattern !== undefined) updates.stopPattern = body.stopPattern;
    if (body.baseBranch !== undefined) updates.baseBranch = body.baseBranch;
    if (body.useWorktree !== undefined) updates.useWorktree = body.useWorktree;
    if (body.clearPlanningFolder !== undefined) updates.clearPlanningFolder = body.clearPlanningFolder;
    if (body.planMode !== undefined) updates.planMode = body.planMode;
    if (body.autoAcceptPlan !== undefined) updates.autoAcceptPlan = body.autoAcceptPlan;

    if (body.model !== undefined) {
      updates.model = {
        providerID: body.model.providerID,
        modelID: body.model.modelID,
        variant: body.model.variant,
      };
    }

    if (body.git !== undefined) {
      updates.git = {
        branchPrefix: body.git.branchPrefix ?? currentLoop.config.git.branchPrefix,
        commitScope: body.git.commitScope ?? currentLoop.config.git.commitScope,
      };
    }

    const updatedLoop = await loopManager.updateLoop(loopId, updates);
    return Response.json(updatedLoop);
  } catch (error) {
    const errorMessage = String(error);
    if (error instanceof Error) {
      const code = (error as Error & { code?: string }).code;
      const status = (error as Error & { status?: number }).status;
      if (code === "BASE_BRANCH_IMMUTABLE") {
        return errorResponse("base_branch_immutable", errorMessage, status ?? 409);
      }
      if (code === "USE_WORKTREE_IMMUTABLE") {
        return errorResponse("use_worktree_immutable", errorMessage, status ?? 409);
      }
    }
    log.error("Failed to update loop", { loopId, error: errorMessage });
    return errorResponse("update_failed", errorMessage, 500);
  }
}

export const loopsItemRoutes = {
  "/api/loops/:id": {
    /**
     * GET /api/loops/:id - Get a specific loop by ID.
     *
     * Returns the full loop object including configuration and current state.
     *
     * @returns Loop object or 404 if not found
     */
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      log.debug("GET /api/loops/:id", { loopId: req.params.id });
      const loop = await loopManager.getLoop(req.params.id);
      if (!loop) {
        log.debug("GET /api/loops/:id - Loop not found", { loopId: req.params.id });
        return errorResponse("not_found", "Loop not found", 404);
      }
      return Response.json(loop);
    },

    /**
     * PATCH /api/loops/:id - Update a loop's configuration.
     *
     * Updates the specified fields of a loop's configuration. Cannot be used
     * on running or starting loops — stop the loop first. Partial updates are supported.
     *
     * Updatable fields: name, directory, prompt, model, maxIterations,
     * maxConsecutiveErrors, activityTimeoutSeconds, stopPattern, baseBranch,
     * clearPlanningFolder, planMode, git
     *
     * @returns Updated Loop object or 404 if not found
     */
    async PATCH(req: Request & { params: { id: string } }): Promise<Response> {
      log.debug("PATCH /api/loops/:id", { loopId: req.params.id });
      const loop = await loopManager.getLoop(req.params.id);
      if (!loop) {
        log.debug("PATCH /api/loops/:id - Loop not found", { loopId: req.params.id });
        return errorResponse("not_found", "Loop not found", 404);
      }

      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(UpdateLoopRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      return applyLoopUpdates(req.params.id, validation.data, loop);
    },

    /**
     * PUT /api/loops/:id - Update a draft loop's configuration.
     *
     * Updates the specified fields of a draft loop's configuration.
     * Only works for loops in `draft` status. Use PATCH for other statuses.
     * Partial updates are supported.
     *
     * @returns Updated Loop object, 404 if not found, or 400 if not a draft
     */
    async PUT(req: Request & { params: { id: string } }): Promise<Response> {
      const loop = await loopManager.getLoop(req.params.id);
      if (!loop) {
        return errorResponse("not_found", "Loop not found", 404);
      }

      // Only allow PUT for draft loops
      if (loop.state.status !== "draft") {
        return errorResponse("not_draft", "Only draft loops can be updated via PUT", 400);
      }

      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(UpdateLoopRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      log.debug("PUT /api/loops/:id - Request body", {
        loopId: req.params.id,
        hasPrompt: validation.data.prompt !== undefined,
        promptLength: typeof validation.data.prompt === "string" ? validation.data.prompt.length : 0,
        promptPreview: typeof validation.data.prompt === "string" ? validation.data.prompt.slice(0, 50) : null,
      });

      return applyLoopUpdates(req.params.id, validation.data, loop);
    },

    /**
     * DELETE /api/loops/:id - Delete a loop.
     *
     * Deletes a loop and its associated resources. For loops with git branches,
     * use discard or purge endpoints instead for proper cleanup.
     *
     * @returns Success response or 404 if not found
     */
    async DELETE(req: Request & { params: { id: string } }): Promise<Response> {
      log.debug("DELETE /api/loops/:id", { loopId: req.params.id });
      const loop = await loopManager.getLoop(req.params.id);
      if (!loop) {
        log.debug("DELETE /api/loops/:id - Loop not found", { loopId: req.params.id });
        return errorResponse("not_found", "Loop not found", 404);
      }

      try {
        await loopManager.deleteLoop(req.params.id);
        log.info("DELETE /api/loops/:id - Loop deleted", { loopId: req.params.id });
        return successResponse();
      } catch (error) {
        log.error("DELETE /api/loops/:id - Delete failed", { loopId: req.params.id, error: String(error) });
        return errorResponse("delete_failed", String(error), 500);
      }
    },
  },
};
