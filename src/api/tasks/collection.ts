/**
 * Tasks collection routes.
 *
 * - GET /api/tasks - List all tasks
 * - POST /api/tasks - Create a new task (auto-starts unless draft mode)
 * - POST /api/tasks/title - Generate a suggested task title
 */

import { taskManager } from "../../core/task-manager";
import { backendManager } from "../../core/backend-manager";
import { GitService } from "../../core/git-service";
import { getWorkspace, touchWorkspace } from "../../persistence/workspaces";
import { createLogger } from "../../core/logger";
import { isModelEnabled } from "../models";
import { parseAndValidate } from "../validation";
import { errorResponse } from "../helpers";
import { CreateTaskRequestSchema, GenerateTaskTitleRequestSchema } from "../../types/schemas";
import { startErrorResponse } from "./helpers";
import { normalizeUploadedPlanningFiles } from "../../core/planning-file-service";
import type { ValidatedPlanningFiles } from "../../core/planning-file-service";
import { UPLOADED_PLAN_IMPLEMENTATION_PROMPT } from "../../lib/uploaded-plan";

const log = createLogger("api:tasks");

export const tasksCollectionRoutes = {
  "/api/tasks": {
    /**
     * GET /api/tasks - List all tasks.
     *
     * Returns all tasks with their configurations and current states.
     * Tasks are returned regardless of status (idle, running, completed, etc.).
     *
     * @returns Array of Task objects with config and state
     */
    async GET(_req: Request): Promise<Response> {
      log.debug("GET /api/tasks - Listing all tasks");
      const tasks = await taskManager.getTaskSummaries();
      log.debug("GET /api/tasks - Retrieved tasks", { count: tasks.length });
      return Response.json(tasks);
    },

    /**
     * POST /api/tasks - Create a new task.
     *
     * Creates a new Clanky Task with the specified configuration. The task is
     * automatically started unless `draft: true` is specified.
     *
     * The task name is supplied by the client. The dashboard may generate a
     * suggested name up front, but this endpoint receives the final value.
     *
     * Request Body Fields:
     * - name (required): Human-readable task name
     * - workspaceId (required): Workspace to create the task in
     * - prompt (required): Task prompt/PRD
     * - model: { providerID, modelID } for AI model selection
     * - useWorktree (required): Whether to use a dedicated git worktree
     * - maxIterations: Maximum iterations (unlimited if not set)
     * - maxConsecutiveErrors: Max identical errors before failsafe (default: 10)
     * - activityTimeoutSeconds: Seconds without events before error (omit or null for unlimited, min: 60 when set)
     * - stopPattern: Regex for completion detection
     * - git: { branchPrefix, commitScope } for git integration
     * - baseBranch: Base branch to create task from
      * - clearPlanningFolder: Clear .clanky-planning folder before starting
      * - planMode: Start in plan creation mode
       * - autoAcceptPlan: Whether a ready plan should auto-start execution
      * - draft: Save as draft without starting
     *
      * Errors:
      * - 400: Validation error or invalid JSON body
      * - 500: Task created but failed to start
     *
     * @returns Created Task object with 201 status
     */
    async POST(req: Request): Promise<Response> {
      log.debug("POST /api/tasks - Creating new task");

      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(CreateTaskRequestSchema, req);
      if (!validation.success) {
        log.debug("POST /api/tasks - Validation failed");
        return validation.response;
      }
      const body = validation.data;
      let uploadedPlan: ValidatedPlanningFiles | null = null;
      if (body.uploadedPlan) {
        try {
          uploadedPlan = normalizeUploadedPlanningFiles(body.uploadedPlan);
        } catch (error) {
          log.warn("POST /api/tasks - Uploaded plan validation failed", {
            workspaceId: body.workspaceId,
            error: String(error),
          });
          return errorResponse(
            "invalid_uploaded_plan",
            error instanceof Error ? error.message : String(error),
            400,
          );
        }
      }
      const hasUploadedPlan = uploadedPlan !== null;
      const effectivePlanMode = hasUploadedPlan ? true : body.planMode;
      const effectiveAutoAcceptPlan = hasUploadedPlan ? true : body.autoAcceptPlan;

      log.debug("POST /api/tasks - Request validated", {
        name: body.name,
        workspaceId: body.workspaceId,
        planMode: effectivePlanMode,
        draft: body.draft,
        hasModel: !!body.model,
        hasUploadedPlan,
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

      // With worktrees, each task operates in its own isolated directory.
      // No need to check for uncommitted changes or active tasks in the main repo.

      // Validate model is enabled if provided
      // All tasks (including drafts) require a connected model to ensure valid configurations
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
          log.debug(`Auto-detected default branch for task: ${effectiveBaseBranch}`);
        } catch (error) {
          log.warn(`Failed to detect default branch, will fall back to current branch: ${String(error)}`);
          // Continue without baseBranch - task engine will use current branch as fallback
        }
      }

      try {
        const task = await taskManager.createTask({
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
          planMode: effectivePlanMode,
          autoAcceptPlan: effectiveAutoAcceptPlan,
          fullyAutonomous: body.fullyAutonomous,
          draft: body.draft,
        });

        // Save the model as last used if provided
        await taskManager.saveLastUsedModel({
          providerID: body.model.providerID,
          modelID: body.model.modelID,
          variant: body.model.variant,
        });
        await taskManager.saveLastUsedCheapModel(body.cheapModel);

        // If draft mode is enabled, return the task without starting
        if (body.draft) {
          return Response.json(task, { status: 201 });
        }

        if (uploadedPlan) {
          try {
            await taskManager.seedPlanFiles(task.config.id, uploadedPlan);
            await taskManager.acceptPlan(task.config.id, {
              mode: "start_task",
              executionPrompt: UPLOADED_PLAN_IMPLEMENTATION_PROMPT,
              executionPromptMode: "plain_chat",
            });
            const updatedTask = await taskManager.getTask(task.config.id);
            return Response.json(updatedTask ?? task, { status: 201 });
          } catch (startError) {
            try {
              await taskManager.deleteTask(task.config.id);
            } catch (deleteError) {
              log.warn("Failed to clean up task after uploaded plan start failure", {
                taskId: task.config.id,
                error: String(deleteError),
              });
            }
            return startErrorResponse(startError, "start_uploaded_plan_failed", "Task created but failed to start from uploaded plan", {
              taskId: task.config.id,
              planMode: true,
            });
          }
        }

        // If plan mode is enabled, start the plan mode session
        // Otherwise, start the task immediately
        if (body.planMode) {
          try {
            await taskManager.startPlanMode(task.config.id, {
              attachments: body.attachments,
            });
            // Return the task with updated state after starting plan mode
            const updatedTask = await taskManager.getTask(task.config.id);
            return Response.json(updatedTask ?? task, { status: 201 });
          } catch (startError) {
            // If start fails, delete the task to avoid orphaned idle tasks
            try {
              await taskManager.deleteTask(task.config.id);
            } catch (deleteError) {
              log.warn("Failed to clean up task after start failure", { taskId: task.config.id, error: String(deleteError) });
            }
            return startErrorResponse(startError, "start_plan_failed", "Task created but failed to start plan mode", {
              taskId: task.config.id,
              planMode: true,
            });
          }
        } else {
          // Always start the task immediately after creation (normal mode)
          try {
            await taskManager.startTask(task.config.id, {
              attachments: body.attachments,
            });
            // Return the task with updated state after starting
            const updatedTask = await taskManager.getTask(task.config.id);
            return Response.json(updatedTask ?? task, { status: 201 });
          } catch (startError) {
            // If start fails for any reason, delete the task to avoid orphaned idle tasks
            try {
              await taskManager.deleteTask(task.config.id);
            } catch (deleteError) {
              log.warn("Failed to clean up task after start failure", { taskId: task.config.id, error: String(deleteError) });
            }
            return startErrorResponse(startError, "start_failed", "Task created but failed to start", {
              taskId: task.config.id,
              planMode: false,
            });
          }
        }
      } catch (error) {
        log.error("Failed to create task", {
          workspaceId: body.workspaceId,
          error: String(error),
        });
        return errorResponse("create_failed", String(error), 500);
      }
    },
  },

  "/api/tasks/title": {
    async POST(req: Request): Promise<Response> {
      const validation = await parseAndValidate(GenerateTaskTitleRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      const workspace = await getWorkspace(validation.data.workspaceId);
      if (!workspace) {
        return errorResponse("workspace_not_found", `Workspace not found: ${validation.data.workspaceId}`, 404);
      }

      await touchWorkspace(workspace.id);

      try {
        const title = await taskManager.generateTaskTitle({
          workspaceId: workspace.id,
          directory: workspace.directory,
          prompt: validation.data.prompt,
          model: validation.data.model,
          cheapModel: validation.data.cheapModel,
        });
        return Response.json({ title });
      } catch (error) {
        log.error("Failed to generate task title", {
          workspaceId: workspace.id,
          error: String(error),
        });
        return errorResponse("title_generation_failed", String(error), 500);
      }
    },
  },
};
