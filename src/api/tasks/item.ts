import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Task item routes.
 *
 * - GET /api/tasks/:id - Get a specific task
 * - PATCH /api/tasks/:id - Update a task's configuration; name updates are draft-only
 * - PUT /api/tasks/:id - Update a draft task's configuration
 * - DELETE /api/tasks/:id - Delete a task
 */

import { taskManager } from "../../core/task-manager";
import { TaskUpdateError } from "../../core/task/task-errors";
import { createLogger } from "@pablozaiden/webapp/server";
import { parseAndValidate } from "../validation";
import { errorResponse, internalErrorResponse, successResponse } from "../helpers";
import type { TaskConfig, Task } from "@/shared/task";
import type { z } from "zod";
import { UpdateTaskRequestSchema } from "@/contracts/schemas";

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
    if (body.issueNumber !== undefined) updates.issueNumber = body.issueNumber ?? undefined;
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
    if (!updatedTask) {
      return Response.json(updatedTask);
    }
    const responseTask = await taskManager.getTaskSummary(taskId);
    if (!responseTask) {
      throw new Error(`Task disappeared after mutation: ${taskId}`);
    }
    return Response.json(responseTask);
  } catch (error) {
    const errorMessage = String(error);
    if (error instanceof TaskUpdateError) {
      return errorResponse(error.code, error.message, 409);
    }
    log.error("Failed to update task", { taskId, error: errorMessage });
    return internalErrorResponse(error, {
      error: "update_failed",
      message: "Failed to update task",
      status: 500,
    });
  }
}

export const tasksItemRoutes = defineRoutes({
  "/api/tasks/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read, update, or delete a task.",
    requestSchema: UpdateTaskRequestSchema,
    /**
     * GET /api/tasks/:id - Get a specific task by ID.
     *
     * Returns the full task object including configuration and current state.
     *
     * @returns Task object or 404 if not found
     */
    async GET(_req: Request, ctx): Promise<Response> {
      log.debug("GET /api/tasks/:id", { taskId: ctx.params["id"]! });
      const task = await taskManager.getTaskSummary(ctx.params["id"]!);
      if (!task) {
        log.debug("GET /api/tasks/:id - Task not found", { taskId: ctx.params["id"]! });
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
    async PATCH(req: Request, ctx): Promise<Response> {
      log.debug("PATCH /api/tasks/:id", { taskId: ctx.params["id"]! });
      const task = await taskManager.getTask(ctx.params["id"]!);
      if (!task) {
        log.debug("PATCH /api/tasks/:id - Task not found", { taskId: ctx.params["id"]! });
        return errorResponse("not_found", "Task not found", 404);
      }

      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(UpdateTaskRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      return applyTaskUpdates(ctx.params["id"]!, validation.data, task);
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
    async PUT(req: Request, ctx): Promise<Response> {
      const task = await taskManager.getTask(ctx.params["id"]!);
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
        taskId: ctx.params["id"]!,
        hasPrompt: validation.data.prompt !== undefined,
        promptLength: typeof validation.data.prompt === "string" ? validation.data.prompt.length : 0,
        promptPreview: typeof validation.data.prompt === "string" ? validation.data.prompt.slice(0, 50) : null,
      });

      return applyTaskUpdates(ctx.params["id"]!, validation.data, task);
    },

    /**
     * DELETE /api/tasks/:id - Delete a task.
     *
     * Deletes a task and its associated resources. For tasks with git branches,
     * use discard or purge endpoints instead for proper cleanup.
     *
     * @returns Success response or 404 if not found
     */
    async DELETE(_req: Request, ctx): Promise<Response> {
      log.debug("DELETE /api/tasks/:id", { taskId: ctx.params["id"]! });
      const task = await taskManager.getTask(ctx.params["id"]!);
      if (!task) {
        log.debug("DELETE /api/tasks/:id - Task not found", { taskId: ctx.params["id"]! });
        return errorResponse("not_found", "Task not found", 404);
      }

      try {
        await taskManager.deleteTask(ctx.params["id"]!);
        log.info("DELETE /api/tasks/:id - Task deleted", { taskId: ctx.params["id"]! });
        return successResponse();
      } catch (error) {
        log.error("DELETE /api/tasks/:id - Delete failed", { taskId: ctx.params["id"]!, error: String(error) });
        return internalErrorResponse(error, {
          error: "delete_failed",
          message: "Failed to delete task",
          status: 500,
        });
      }
    },
  },
});
