import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Task comments routes.
 *
 * - GET /api/tasks/:id/comments - Get all review comments for a task
 */

import { taskManager } from "../../core/task-manager";
import { createLogger } from "../../core/logger";
import { errorResponse, internalErrorResponse } from "../helpers";
import type { GetCommentsResponse } from "@/contracts";

const log = createLogger("api:tasks");

export const tasksCommentsRoutes = defineRoutes({
  "/api/tasks/:id/comments": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List review comments for a task.",
    /**
     * GET /api/tasks/:id/comments - Get all review comments for a task.
     *
     * Returns all review comments submitted for a task across all review cycles.
     * Comments include their status (pending/addressed) and timestamps.
     *
     * @returns GetCommentsResponse with array of ReviewComment objects
     */
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        // Check if task exists
        const task = await taskManager.getTask(ctx.params["id"]!);
        if (!task) {
          return errorResponse("not_found", "Task not found", 404);
        }

        // Get comments from database via TaskManager
        const comments = taskManager.getReviewComments(ctx.params["id"]!);

        const responseBody: GetCommentsResponse = {
          success: true,
          comments,
        };
        return Response.json(responseBody);
      } catch (error) {
        log.error("Failed to get task comments", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "get_comments_failed",
          message: "Failed to load task comments",
          status: 500,
        });
      }
    },
  },
});
