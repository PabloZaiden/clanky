import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Task plan management routes.
 *
 * - POST /api/tasks/:id/plan/feedback        - Send feedback to refine the plan
 * - POST /api/tasks/:id/plan/accept          - Accept the plan and start execution or open SSH
 * - POST /api/tasks/:id/plan/discard         - Discard the plan and delete the task
 */

import { taskManager } from "../../core/task-manager";
import { createLogger } from "../../core/logger";
import { parseAndValidate } from "../validation";
import { domainErrorResponse, errorResponse, successResponse } from "../helpers";
import type { PlanAcceptResponse } from "@/contracts";
import { PlanFeedbackRequestSchema, PlanAcceptRequestSchema } from "@/contracts/schemas";
import { isTaskOperationError } from "../../core/task/task-errors";
import { taskErrorResponse } from "./helpers";

const log = createLogger("api:tasks");

export const tasksPlanRoutes = defineRoutes({
  "/api/tasks/:id/plan/feedback": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Submit feedback on a generated task plan.",
    requestSchema: PlanFeedbackRequestSchema,
    /**
     * POST /api/tasks/:id/plan/feedback - Send feedback to refine the plan.
     *
     * Sends user feedback to the AI to refine the plan during planning phase.
     * If the AI is currently generating, the session is aborted immediately and
     * the feedback is injected into the next iteration. If the AI is idle (plan
     * was ready), a new plan iteration is started.
     *
     * Increments the feedback round counter. Only works for tasks in planning status.
     * Returns immediately after setting up the injection — does not wait for
     * the iteration to complete.
     *
     * Request Body:
     * - feedback (required): User's feedback/comments on the plan
     *
     * @returns Success response
     */
    async POST(req: Request, ctx): Promise<Response> {
      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(PlanFeedbackRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      const body = validation.data;

      try {
        await taskManager.sendPlanFeedback(ctx.params["id"]!, body.feedback, body.attachments);
        return successResponse();
      } catch (error) {
        if (isTaskOperationError(error)) {
          if (error.code === "task_not_found") {
            return errorResponse("not_running", "Task not found", 409);
          }
          return taskErrorResponse(error, {
            error: "feedback_failed",
            message: "Failed to send plan feedback",
            status: 500,
          });
        }
        log.error("Failed to send plan feedback", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        return domainErrorResponse(error, {
          fallback: {
            error: "feedback_failed",
            message: "Failed to send plan feedback",
            status: 500,
          },
        });
      }
    },
  },

  "/api/tasks/:id/plan/accept": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Accept a generated task plan.",
    requestSchema: PlanAcceptRequestSchema,
    /**
     * POST /api/tasks/:id/plan/accept - Accept the plan and either start execution or open SSH.
     *
     * Accepts the current plan and transitions the task from planning status
     * to running or completed, depending on the chosen acceptance mode.
     * Only works for tasks in planning status.
     *
     * @returns Success response
     */
    async POST(req: Request, ctx): Promise<Response> {
      try {
        const validation = await parseAndValidate(PlanAcceptRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const result = await taskManager.acceptPlan(ctx.params["id"]!, {
          mode: validation.data.mode,
        });
        const response: PlanAcceptResponse = result.mode === "open_ssh"
          ? { success: true, mode: result.mode, sshSession: result.sshSession }
          : { success: true, mode: result.mode };
        return Response.json(response);
      } catch (error) {
        if (isTaskOperationError(error)) {
          return taskErrorResponse(error, {
            error: "accept_failed",
            message: "Failed to accept plan",
            status: 500,
          });
        }
        log.error("Failed to accept plan", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        return domainErrorResponse(error, {
          fallback: {
            error: "accept_failed",
            message: "Failed to accept plan",
            status: 500,
          },
        });
      }
    },
  },

  "/api/tasks/:id/plan/discard": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Discard a generated task plan and delete the task.",
    /**
     * POST /api/tasks/:id/plan/discard - Discard the plan and delete the task.
     *
     * Discards the plan and deletes the task entirely. This is a shortcut
     * for discarding during plan review without executing anything.
     *
     * @returns Success response
     */
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const deleted = await taskManager.discardPlan(ctx.params["id"]!);
        if (!deleted) {
          return errorResponse("not_found", "Task not found", 404);
        }
        return successResponse();
      } catch (error) {
        log.error("Failed to discard plan", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        return domainErrorResponse(error, {
          fallback: {
            error: "discard_failed",
            message: "Failed to discard plan",
            status: 500,
          },
        });
      }
    },
  },
});
