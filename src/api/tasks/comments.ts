/**
 * Task comments routes.
 *
 * - GET /api/tasks/:id/comments - Get all review comments for a task
 */

import { taskManager } from "../../core/task-manager";
import { createLogger } from "../../core/logger";
import { errorResponse } from "../helpers";
import type { GetCommentsResponse } from "../../types/api";

const log = createLogger("api:tasks");

export const tasksCommentsRoutes = {
  "/api/tasks/:id/comments": {
    /**
     * GET /api/tasks/:id/comments - Get all review comments for a task.
     *
     * Returns all review comments submitted for a task across all review cycles.
     * Comments include their status (pending/addressed) and timestamps.
     *
     * @returns GetCommentsResponse with array of ReviewComment objects
     */
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        // Check if task exists
        const task = await taskManager.getTask(req.params.id);
        if (!task) {
          return errorResponse("not_found", "Task not found", 404);
        }

        // Get comments from database via TaskManager
        const comments = taskManager.getReviewComments(req.params.id);

        const responseBody: GetCommentsResponse = {
          success: true,
          comments,
        };
        return Response.json(responseBody);
      } catch (error) {
        log.error("Failed to get task comments", {
          taskId: req.params.id,
          error: String(error),
        });
        return errorResponse("get_comments_failed", String(error), 500);
      }
    },
  },
};
