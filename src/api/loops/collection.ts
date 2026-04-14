/**
 * Loops collection routes.
 *
 * - GET /api/loops - List all loops
 * - POST /api/loops - Create a new loop (auto-starts unless draft mode)
 * - POST /api/loops/title - Generate a suggested loop title
 */

import { loopManager } from "../../core/loop-manager";
import { backendManager } from "../../core/backend-manager";
import { GitService } from "../../core/git-service";
import { getWorkspace, touchWorkspace } from "../../persistence/workspaces";
import { createLogger } from "../../core/logger";
import { isModelEnabled } from "../models";
import { parseAndValidate } from "../validation";
import { errorResponse } from "../helpers";
import { CreateLoopRequestSchema, GenerateLoopTitleRequestSchema } from "../../types/schemas";
import { startErrorResponse } from "./helpers";

const log = createLogger("api:loops");

export const loopsCollectionRoutes = {
  "/api/loops": {
    /**
     * GET /api/loops - List all loops.
     *
     * Returns all loops with their configurations and current states.
     * Loops are returned regardless of status (idle, running, completed, etc.).
     *
     * @returns Array of Loop objects with config and state
     */
    async GET(_req: Request): Promise<Response> {
      log.debug("GET /api/loops - Listing all loops");
      const loops = await loopManager.getAllLoops();
      log.debug("GET /api/loops - Retrieved loops", { count: loops.length });
      return Response.json(loops);
    },

    /**
     * POST /api/loops - Create a new loop.
     *
     * Creates a new Ralph Loop with the specified configuration. The loop is
     * automatically started unless `draft: true` is specified.
     *
     * The loop name is supplied by the client. The dashboard may generate a
     * suggested name up front, but this endpoint receives the final value.
     *
     * Request Body Fields:
     * - name (required): Human-readable loop name
     * - workspaceId (required): Workspace to create the loop in
     * - prompt (required): Task prompt/PRD
     * - model: { providerID, modelID } for AI model selection
     * - useWorktree (required): Whether to use a dedicated git worktree
     * - maxIterations: Maximum iterations (unlimited if not set)
     * - maxConsecutiveErrors: Max identical errors before failsafe (default: 10)
     * - activityTimeoutSeconds: Seconds without events before error (omit or null for unlimited, min: 60 when set)
     * - stopPattern: Regex for completion detection
     * - git: { branchPrefix, commitScope } for git integration
     * - baseBranch: Base branch to create loop from
      * - clearPlanningFolder: Clear .ralph-planning folder before starting
      * - planMode: Start in plan creation mode
       * - autoAcceptPlan: Whether a ready plan should auto-start execution
      * - draft: Save as draft without starting
     *
      * Errors:
      * - 400: Validation error or invalid JSON body
      * - 500: Loop created but failed to start
     *
     * @returns Created Loop object with 201 status
     */
    async POST(req: Request): Promise<Response> {
      log.debug("POST /api/loops - Creating new loop");

      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(CreateLoopRequestSchema, req);
      if (!validation.success) {
        log.debug("POST /api/loops - Validation failed");
        return validation.response;
      }
      const body = validation.data;

      log.debug("POST /api/loops - Request validated", {
        name: body.name,
        workspaceId: body.workspaceId,
        planMode: body.planMode,
        draft: body.draft,
        hasModel: !!body.model,
      });

      // Resolve workspaceId to directory - workspaceId is required
      const workspace = await getWorkspace(body.workspaceId);
      if (!workspace) {
        return errorResponse("workspace_not_found", `Workspace not found: ${body.workspaceId}`, 404);
      }
      const directory = workspace.directory;
      const workspaceId = body.workspaceId;

      // Touch workspace to update last used timestamp
      await touchWorkspace(workspace.id);

      // Create a single executor/GitService for the request to avoid duplicate setup
      let git: GitService | null = null;
      const getGitService = async (): Promise<GitService> => {
        if (!git) {
          const executor = await backendManager.getCommandExecutorAsync(workspaceId, directory!);
          git = GitService.withExecutor(executor);
        }
        return git;
      };

      // With worktrees, each loop operates in its own isolated directory.
      // No need to check for uncommitted changes or active loops in the main repo.

      // Validate model is enabled if provided
      // All loops (including drafts) require a connected model to ensure valid configurations
      // NOTE: This is done AFTER body validation to avoid backend connection costs
      // for requests that will be rejected anyway (invalid body, missing fields)
      if (body.model?.providerID && body.model?.modelID) {
        const modelValidation = await isModelEnabled(
          workspaceId,
          directory,
          body.model.providerID,
          body.model.modelID,
        );
        if (!modelValidation.enabled) {
          return errorResponse(
            modelValidation.errorCode ?? "model_not_enabled",
            modelValidation.error ?? "The selected model is not available",
          );
        }
      }
      if (body.cheapModel?.mode === "custom") {
        const cheapModelValidation = await isModelEnabled(
          workspaceId,
          directory,
          body.cheapModel.model.providerID,
          body.cheapModel.model.modelID,
        );
        if (!cheapModelValidation.enabled) {
          return errorResponse(
            cheapModelValidation.errorCode ?? "cheap_model_not_enabled",
            cheapModelValidation.error ?? "The selected cheap model is not available",
          );
        }
      }

      // Auto-detect default branch if baseBranch not provided
      let effectiveBaseBranch = body.baseBranch;
      if (!effectiveBaseBranch) {
        try {
          const gitService = await getGitService();
          effectiveBaseBranch = await gitService.getDefaultBranch(directory);
          log.debug(`Auto-detected default branch for loop: ${effectiveBaseBranch}`);
        } catch (error) {
          log.warn(`Failed to detect default branch, will fall back to current branch: ${String(error)}`);
          // Continue without baseBranch - loop engine will use current branch as fallback
        }
      }

      try {
        const loop = await loopManager.createLoop({
          name: body.name,
          directory,
          prompt: body.prompt,
          attachments: body.attachments,
          workspaceId,
          modelProviderID: body.model.providerID,
          modelID: body.model.modelID,
          modelVariant: body.model.variant,
          cheapModel: body.cheapModel,
          maxIterations: body.maxIterations ?? undefined,
          maxConsecutiveErrors: body.maxConsecutiveErrors,
          activityTimeoutSeconds: body.activityTimeoutSeconds,
          stopPattern: body.stopPattern,
          gitBranchPrefix: body.git.branchPrefix,
          gitCommitScope: body.git.commitScope,
          baseBranch: effectiveBaseBranch,
          useWorktree: body.useWorktree,
           clearPlanningFolder: body.clearPlanningFolder,
           planMode: body.planMode,
           autoAcceptPlan: body.autoAcceptPlan,
           fullyAutonomous: body.fullyAutonomous,
           draft: body.draft,
         });

        // Save the model as last used if provided
        await loopManager.saveLastUsedModel({
          providerID: body.model.providerID,
          modelID: body.model.modelID,
          variant: body.model.variant,
        });
        await loopManager.saveLastUsedCheapModel(body.cheapModel);

        // If draft mode is enabled, return the loop without starting
        if (body.draft) {
          return Response.json(loop, { status: 201 });
        }

        // If plan mode is enabled, start the plan mode session
        // Otherwise, start the loop immediately
        if (body.planMode) {
          try {
            await loopManager.startPlanMode(loop.config.id, {
              attachments: body.attachments,
            });
            // Return the loop with updated state after starting plan mode
            const updatedLoop = await loopManager.getLoop(loop.config.id);
            return Response.json(updatedLoop ?? loop, { status: 201 });
          } catch (startError) {
            // If start fails, delete the loop to avoid orphaned idle loops
            try {
              await loopManager.deleteLoop(loop.config.id);
            } catch (deleteError) {
              log.warn("Failed to clean up loop after start failure", { loopId: loop.config.id, error: String(deleteError) });
            }
            return startErrorResponse(startError, "start_plan_failed", "Loop created but failed to start plan mode", {
              loopId: loop.config.id,
              planMode: true,
            });
          }
        } else {
          // Always start the loop immediately after creation (normal mode)
          try {
            await loopManager.startLoop(loop.config.id, {
              attachments: body.attachments,
            });
            // Return the loop with updated state after starting
            const updatedLoop = await loopManager.getLoop(loop.config.id);
            return Response.json(updatedLoop ?? loop, { status: 201 });
          } catch (startError) {
            // If start fails for any reason, delete the loop to avoid orphaned idle loops
            try {
              await loopManager.deleteLoop(loop.config.id);
            } catch (deleteError) {
              log.warn("Failed to clean up loop after start failure", { loopId: loop.config.id, error: String(deleteError) });
            }
            return startErrorResponse(startError, "start_failed", "Loop created but failed to start", {
              loopId: loop.config.id,
              planMode: false,
            });
          }
        }
      } catch (error) {
        log.error("Failed to create loop", {
          workspaceId: body.workspaceId,
          error: String(error),
        });
        return errorResponse("create_failed", String(error), 500);
      }
    },
  },

  "/api/loops/title": {
    async POST(req: Request): Promise<Response> {
      const validation = await parseAndValidate(GenerateLoopTitleRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      const workspace = await getWorkspace(validation.data.workspaceId);
      if (!workspace) {
        return errorResponse("workspace_not_found", `Workspace not found: ${validation.data.workspaceId}`, 404);
      }

      await touchWorkspace(workspace.id);

      try {
        const title = await loopManager.generateLoopTitle({
          workspaceId: workspace.id,
          directory: workspace.directory,
          prompt: validation.data.prompt,
          model: validation.data.model,
          cheapModel: validation.data.cheapModel,
        });
        return Response.json({ title });
      } catch (error) {
        log.error("Failed to generate loop title", {
          workspaceId: workspace.id,
          error: String(error),
        });
        return errorResponse("title_generation_failed", String(error), 500);
      }
    },
  },
};
