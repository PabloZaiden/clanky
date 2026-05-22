/**
 * Draft task start routes.
 *
 * - POST /api/tasks/:id/draft/start - Transition a draft task to planning or execution
 */

import { taskManager } from "../../core/task-manager";
import { parseAndValidate } from "../validation";
import { errorResponse } from "../helpers";
import { StartDraftRequestSchema } from "../../types/schemas";
import { startErrorResponse } from "./helpers";

export const tasksDraftRoutes = {
  "/api/tasks/:id/draft/start": {
    /**
     * POST /api/tasks/:id/draft/start - Start a draft task.
     *
     * Transitions a draft task to either planning mode or immediate execution.
     * Each task operates in its own worktree, so no uncommitted-changes checks are needed.
     *
     * Request Body:
     * - planMode (required): If true, start in plan mode; if false, start immediately
     *
     * Errors:
     * - 400: Task is not in draft status or invalid body
     * - 404: Task not found
     *
     * @returns Updated Task object
     */
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(StartDraftRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      const body = validation.data;

      // Load the task
      const task = await taskManager.getTask(req.params.id);
      if (!task) {
        return errorResponse("not_found", "Task not found", 404);
      }

      // Verify it's a draft
      if (task.state.status !== "draft") {
        return errorResponse("not_draft", "Task is not in draft status", 400);
      }

      // With worktrees, each task operates in its own isolated directory.
      // No need to check for active tasks or uncommitted changes.

      // Delegate the draft → start transition to TaskManager
      try {
        const updatedTask = await taskManager.startDraft(req.params.id, {
          planMode: body.planMode,
          attachments: body.attachments,
        });
        return Response.json(updatedTask);
      } catch (startError) {
        return startErrorResponse(
          startError,
          body.planMode ? "start_plan_failed" : "start_failed",
          body.planMode ? "Failed to start plan mode" : "Failed to start task",
          {
            taskId: req.params.id,
            planMode: body.planMode,
          },
        );
      }
    },
  },
};
