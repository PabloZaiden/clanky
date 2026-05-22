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
import { errorResponse, successResponse } from "../helpers";
import type { PlanAcceptResponse } from "../../types/api";
import {
  PlanFeedbackRequestSchema,
  PlanAcceptRequestSchema,
} from "../../types/schemas";

const log = createLogger("api:tasks");

export const tasksPlanRoutes = {
  "/api/tasks/:id/plan/feedback": {
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
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(PlanFeedbackRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      const body = validation.data;

      try {
        await taskManager.sendPlanFeedback(req.params.id, body.feedback, body.attachments);
        return successResponse();
      } catch (error) {
        const errorMsg = String(error);
        if (errorMsg.includes("not running") || errorMsg.includes("not found")) {
          return errorResponse("not_running", errorMsg, 409);
        }
        if (errorMsg.includes("not in planning status")) {
          return errorResponse("not_planning", errorMsg, 400);
        }
        log.error("Failed to send plan feedback", {
          taskId: req.params.id,
          error: errorMsg,
        });
        return errorResponse("feedback_failed", errorMsg, 500);
      }
    },
  },

  "/api/tasks/:id/plan/accept": {
    /**
     * POST /api/tasks/:id/plan/accept - Accept the plan and either start execution or open SSH.
     *
     * Accepts the current plan and transitions the task from planning status
     * to running or completed, depending on the chosen acceptance mode.
     * Only works for tasks in planning status.
     *
     * @returns Success response
     */
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const validation = await parseAndValidate(PlanAcceptRequestSchema, req);
        if (!validation.success) {
          return validation.response;
        }

        const result = await taskManager.acceptPlan(req.params.id, {
          mode: validation.data.mode,
        });
        const response: PlanAcceptResponse = result.mode === "open_ssh"
          ? { success: true, mode: result.mode, sshSession: result.sshSession }
          : { success: true, mode: result.mode };
        return Response.json(response);
      } catch (error) {
        const errorMsg = String(error);
        if (errorMsg.includes("not running")) {
          return errorResponse("not_running", errorMsg, 409);
        }
        if (errorMsg.includes("not in planning status")) {
          return errorResponse("not_planning", errorMsg, 400);
        }
        if (errorMsg.includes("Plan is not ready yet")) {
          return errorResponse("plan_not_ready", errorMsg, 400);
        }
        log.error("Failed to accept plan", {
          taskId: req.params.id,
          error: errorMsg,
        });
        return errorResponse("accept_failed", errorMsg, 500);
      }
    },
  },

  "/api/tasks/:id/plan/discard": {
    /**
     * POST /api/tasks/:id/plan/discard - Discard the plan and delete the task.
     *
     * Discards the plan and deletes the task entirely. This is a shortcut
     * for discarding during plan review without executing anything.
     *
     * @returns Success response
     */
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const deleted = await taskManager.discardPlan(req.params.id);
        if (!deleted) {
          return errorResponse("not_found", "Task not found", 404);
        }
        return successResponse();
      } catch (error) {
        log.error("Failed to discard plan", {
          taskId: req.params.id,
          error: String(error),
        });
        return errorResponse("discard_failed", String(error), 500);
      }
    },
  },
};
