import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Draft task start routes.
 *
 * - POST /api/tasks/:id/draft/start - Transition a draft task to planning or execution
 */

import { taskManager } from "../../core/task-manager";
import { parseAndValidate } from "../validation";
import { errorResponse } from "../helpers";
import { StartDraftRequestSchema } from "@/contracts/schemas";
import { startErrorResponse } from "./helpers";

export const tasksDraftRoutes = defineRoutes({
  "/api/tasks/:id/draft/start": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Start draft generation for a task.",
    requestSchema: StartDraftRequestSchema,
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
    async POST(req: Request, ctx): Promise<Response> {
      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(StartDraftRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      const body = validation.data;

      // Load the task
      const task = await taskManager.getTask(ctx.params["id"]!);
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
        const updatedTask = await taskManager.startDraft(ctx.params["id"]!, {
          planMode: body.planMode,
          attachments: body.attachments,
        });
        if (!updatedTask) {
          return Response.json(updatedTask);
        }
        const responseTask = await taskManager.getTaskSummary(ctx.params["id"]!);
        if (!responseTask) {
          throw new Error(`Task disappeared after draft start: ${ctx.params["id"]!}`);
        }
        return Response.json(responseTask);
      } catch (startError) {
        return startErrorResponse(
          startError,
          body.planMode ? "start_plan_failed" : "start_failed",
          body.planMode ? "Failed to start plan mode" : "Failed to start task",
          {
            taskId: ctx.params["id"]!,
            planMode: body.planMode,
          },
        );
      }
    },
  },
});
