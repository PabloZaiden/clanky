/**
 * Task item routes.
 *
 * - GET /api/tasks/:id - Get a specific task
 * - PATCH /api/tasks/:id - Update a task's configuration; name updates are draft-only
 * - PUT /api/tasks/:id - Update a draft task's configuration
 * - DELETE /api/tasks/:id - Delete a task
 */

import { taskManager } from "../../core/task-manager";
import { createLogger } from "../../core/logger";
import { parseAndValidate } from "../validation";
import { errorResponse, successResponse } from "../helpers";
import type { TaskConfig, Task } from "../../types/task";
import type { z } from "zod";
import { UpdateTaskRequestSchema } from "../../types/schemas";

const log = createLogger("api:tasks");

/**
 * Transform a validated update request body into TaskConfig updates and apply them.
 * Shared by PATCH and PUT handlers to eliminate duplication.
 *
 * @returns Response with the updated task or an error response
 */
async function applyTaskUpdates(
  taskId: string,
  body: z.infer<typeof UpdateTaskRequestSchema>,
  currentTask: Task,
): Promise<Response> {
  try {
    const updates: Partial<Omit<TaskConfig, "id" | "createdAt">> = {};

    if (body.name !== undefined) {
      const trimmedName = body.name.trim();
      if (trimmedName === "") {
        return errorResponse("validation_error", "Name cannot be empty");
      }
      updates.name = trimmedName;
    }
    if (body.directory !== undefined) updates.directory = body.directory;
    if (body.prompt !== undefined) updates.prompt = body.prompt;
    if (body.issueNumber !== undefined) updates.issueNumber = body.issueNumber;
    if (body.maxIterations !== undefined) {
      updates.maxIterations = body.maxIterations ?? Infinity;
    }
    if (body.maxConsecutiveErrors !== undefined) updates.maxConsecutiveErrors = body.maxConsecutiveErrors;
    if (body.activityTimeoutSeconds !== undefined) updates.activityTimeoutSeconds = body.activityTimeoutSeconds;
    if (body.stopPattern !== undefined) updates.stopPattern = body.stopPattern;
    if (body.baseBranch !== undefined) updates.baseBranch = body.baseBranch;
    if (body.useWorktree !== undefined) updates.useWorktree = body.useWorktree;
    if (body.clearPlanningFolder !== undefined) updates.clearPlanningFolder = body.clearPlanningFolder;
    if (body.planMode !== undefined) updates.planMode = body.planMode;
    if (body.autoAcceptPlan !== undefined) updates.autoAcceptPlan = body.autoAcceptPlan;
    if (body.fullyAutonomous !== undefined) updates.fullyAutonomous = body.fullyAutonomous;
    if (body.isPrivate !== undefined) updates.isPrivate = body.isPrivate;

    if (body.model !== undefined) {
      updates.model = {
        providerID: body.model.providerID,
        modelID: body.model.modelID,
        variant: body.model.variant,
      };
    }
    if (body.cheapModel !== undefined) {
      updates.cheapModel = body.cheapModel;
    }

    if (body.git !== undefined) {
      updates.git = {
        branchPrefix: body.git.branchPrefix ?? currentTask.config.git.branchPrefix,
        commitScope: body.git.commitScope ?? currentTask.config.git.commitScope,
      };
    }

    const updatedTask = await taskManager.updateTask(taskId, updates);
    if (body.model !== undefined) {
      await taskManager.saveLastUsedModel(updatedTask?.config.model ?? body.model);
    }
    if (body.cheapModel !== undefined) {
      await taskManager.saveLastUsedCheapModel(
        updatedTask?.config.cheapModel ?? body.cheapModel,
      );
    }
    return Response.json(updatedTask);
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
      if (code === "ACTIVE_TASK_UPDATE_RESTRICTED") {
        return errorResponse("active_task_update_restricted", errorMessage, status ?? 409);
      }
      if (code === "PLANNING_UPDATE_RESTRICTED") {
        return errorResponse("planning_update_restricted", errorMessage, status ?? 409);
      }
      if (code === "PLAN_EXECUTION_UPDATE_RESTRICTED") {
        return errorResponse("plan_execution_update_restricted", errorMessage, status ?? 409);
      }
      if (code === "TASK_RENAME_RESTRICTED") {
        return errorResponse("task_rename_restricted", errorMessage, status ?? 409);
      }
    }
    log.error("Failed to update task", { taskId, error: errorMessage });
    return errorResponse("update_failed", errorMessage, 500);
  }
}

export const tasksItemRoutes = {
  "/api/tasks/:id": {
    /**
     * GET /api/tasks/:id - Get a specific task by ID.
     *
     * Returns the full task object including configuration and current state.
     *
     * @returns Task object or 404 if not found
     */
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      log.debug("GET /api/tasks/:id", { taskId: req.params.id });
      const task = await taskManager.getTask(req.params.id);
      if (!task) {
        log.debug("GET /api/tasks/:id - Task not found", { taskId: req.params.id });
        return errorResponse("not_found", "Task not found", 404);
      }
      return Response.json(task);
    },

    /**
     * PATCH /api/tasks/:id - Update a task's configuration.
     *
     * Updates the specified fields of a task's configuration. Name updates are
     * only accepted while the task is still a draft. Active execution
     * tasks must be stopped first, except active planning tasks may update only
     * autoAcceptPlan and fullyAutonomous. Partial updates are supported.
     *
     * Updatable fields: name (draft-only), directory, prompt, model, maxIterations,
     * maxConsecutiveErrors, activityTimeoutSeconds, stopPattern, baseBranch,
     * clearPlanningFolder, planMode, git, autoAcceptPlan, fullyAutonomous
     *
     * @returns Updated Task object or 404 if not found
     */
    async PATCH(req: Request & { params: { id: string } }): Promise<Response> {
      log.debug("PATCH /api/tasks/:id", { taskId: req.params.id });
      const task = await taskManager.getTask(req.params.id);
      if (!task) {
        log.debug("PATCH /api/tasks/:id - Task not found", { taskId: req.params.id });
        return errorResponse("not_found", "Task not found", 404);
      }

      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(UpdateTaskRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      return applyTaskUpdates(req.params.id, validation.data, task);
    },

    /**
     * PUT /api/tasks/:id - Update a draft task's configuration.
     *
     * Updates the specified fields of a draft task's configuration.
     * Only works for tasks in `draft` status. Use PATCH for other statuses.
     * Partial updates are supported.
     *
     * @returns Updated Task object, 404 if not found, or 400 if not a draft
     */
    async PUT(req: Request & { params: { id: string } }): Promise<Response> {
      const task = await taskManager.getTask(req.params.id);
      if (!task) {
        return errorResponse("not_found", "Task not found", 404);
      }

      // Only allow PUT for draft tasks
      if (task.state.status !== "draft") {
        return errorResponse("not_draft", "Only draft tasks can be updated via PUT", 400);
      }

      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(UpdateTaskRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      log.debug("PUT /api/tasks/:id - Request body", {
        taskId: req.params.id,
        hasPrompt: validation.data.prompt !== undefined,
        promptLength: typeof validation.data.prompt === "string" ? validation.data.prompt.length : 0,
        promptPreview: typeof validation.data.prompt === "string" ? validation.data.prompt.slice(0, 50) : null,
      });

      return applyTaskUpdates(req.params.id, validation.data, task);
    },

    /**
     * DELETE /api/tasks/:id - Delete a task.
     *
     * Deletes a task and its associated resources. For tasks with git branches,
     * use discard or purge endpoints instead for proper cleanup.
     *
     * @returns Success response or 404 if not found
     */
    async DELETE(req: Request & { params: { id: string } }): Promise<Response> {
      log.debug("DELETE /api/tasks/:id", { taskId: req.params.id });
      const task = await taskManager.getTask(req.params.id);
      if (!task) {
        log.debug("DELETE /api/tasks/:id - Task not found", { taskId: req.params.id });
        return errorResponse("not_found", "Task not found", 404);
      }

      try {
        await taskManager.deleteTask(req.params.id);
        log.info("DELETE /api/tasks/:id - Task deleted", { taskId: req.params.id });
        return successResponse();
      } catch (error) {
        log.error("DELETE /api/tasks/:id - Delete failed", { taskId: req.params.id, error: String(error) });
        return errorResponse("delete_failed", String(error), 500);
      }
    },
  },
};
