import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Task pending prompt and follow-up routes.
 *
 * - PUT/DELETE /api/tasks/:id/pending-prompt - Modify the next iteration's prompt
 * - POST/DELETE /api/tasks/:id/pending      - Apply or clear the next message/model override
 * - POST /api/tasks/:id/follow-up           - Start a new feedback cycle from a terminal state
 */

import { taskManager } from "../../core/task-manager";
import { parseAndValidate } from "../validation";
import { errorResponse, successResponse } from "../helpers";
import { PendingPromptRequestSchema, SetPendingRequestSchema, FollowUpRequestSchema } from "@/contracts/schemas";
import { validateEnabledModelForTask } from "./helpers";

export const tasksPendingRoutes = defineRoutes({
  "/api/tasks/:id/pending-prompt": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Set the pending prompt used for the next task iteration.",
    requestSchema: PendingPromptRequestSchema,
    /**
     * PUT /api/tasks/:id/pending-prompt - Set the pending prompt for next iteration.
     *
     * Sets a custom prompt that will be used for the next iteration only.
     * The prompt replaces the default config.prompt for one iteration.
     * Only works while the task is active.
     *
     * Request Body:
     * - prompt (required): The prompt text for the next iteration
     *
     * @returns Success response
     */
    async PUT(req: Request, ctx): Promise<Response> {
      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(PendingPromptRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      const body = validation.data;

      const result = await taskManager.setPendingPrompt(ctx.params["id"]!, body.prompt, body.attachments);

      if (!result.success) {
        if (result.error?.includes("not found")) {
          return errorResponse("not_found", "Task not found", 404);
        }
        if (result.error?.includes("not running")) {
          return errorResponse("not_running", result.error, 409);
        }
        return errorResponse("set_pending_prompt_failed", result.error ?? "Unknown error", 400);
      }

      return successResponse();
    },

    /**
     * DELETE /api/tasks/:id/pending-prompt - Clear the pending prompt.
     *
     * Removes the pending prompt so the next iteration uses the default
     * config.prompt instead. Only works while the task is active.
     *
     * @returns Success response
     */
    async DELETE(_req: Request, ctx): Promise<Response> {
      const result = await taskManager.clearPendingPrompt(ctx.params["id"]!);

      if (!result.success) {
        if (result.error?.includes("not found")) {
          return errorResponse("not_found", "Task not found", 404);
        }
        if (result.error?.includes("not running")) {
          return errorResponse("not_running", result.error, 409);
        }
        return errorResponse("clear_pending_prompt_failed", result.error ?? "Unknown error", 400);
      }

      return successResponse();
    },
  },

  "/api/tasks/:id/pending": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Apply a pending message or model override for the next task iteration.",
    requestSchema: SetPendingRequestSchema,
    /**
     * POST /api/tasks/:id/pending - Apply a message and/or model override for the next iteration.
     *
     * Backend queueing is intentionally unsupported. Requests always use the
     * interrupt-first path (`immediate: true`) when a task is actively generating.
     * Set `immediate: false` requests are rejected so callers follow the explicit
     * stop-then-send flow instead of relying on queued backend behavior.
     *
     * Works for active tasks (running, waiting, planning, starting) and can also
     * jumpstart tasks in supported stopped states (completed, stopped, failed, max_iterations).
     *
     * Request Body:
     * - message (optional): Message for the next iteration
     * - model (optional): { providerID, modelID } for model change
     * - immediate (optional, default: true): Must be true. False is rejected.
     *
     * At least one of message or model must be provided.
     *
     * @returns Success response
     */
    async POST(req: Request, ctx): Promise<Response> {
      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(SetPendingRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      const body = validation.data;

      // At least one of message or model must be provided
      if (body.message === null && body.model === null) {
        return errorResponse("validation_error", "At least one of 'message' or 'model' must be provided");
      }

      // Trim message if provided and validate non-empty
      let trimmedMessage: string | undefined;
      if (body.message !== null) {
        trimmedMessage = body.message.trim();
        if (trimmedMessage === "") {
          return errorResponse("validation_error", "'message' must be a non-empty string");
        }
      }

      // Validate model is enabled before allowing the change
      if (body.model !== null) {
        const modelError = await validateEnabledModelForTask(ctx.params["id"]!, body.model);
        if (modelError) {
          return modelError;
        }
      }

      const immediate = body.immediate;

       if (!immediate) {
         return errorResponse(
           "queue_not_supported",
           "Queued pending input is no longer supported. Stop the task first, then send the new message.",
           409,
         );
       }

        const result = await taskManager.injectPending(ctx.params["id"]!, {
          message: trimmedMessage,
          model: body.model ?? undefined,
          attachments: body.attachments,
        });

      if (!result.success) {
        if (result.error?.includes("not found")) {
          return errorResponse("not_found", "Task not found", 404);
        }
        if (result.error?.includes("not running") || result.error?.includes("not in an active state")) {
          return errorResponse("not_running", result.error, 409);
        }
        return errorResponse("set_pending_failed", result.error ?? "Unknown error", 400);
      }

      return successResponse();
    },

    /**
     * DELETE /api/tasks/:id/pending - Clear all pending values (message and model).
     *
      * Removes any pending message and model change. Only works for active tasks.
     *
     * @returns Success response
     */
    async DELETE(_req: Request, ctx): Promise<Response> {
      const result = await taskManager.clearPending(ctx.params["id"]!);

      if (!result.success) {
        if (result.error?.includes("not found")) {
          return errorResponse("not_found", "Task not found", 404);
        }
        if (result.error?.includes("not running") || result.error?.includes("not in an active state")) {
          return errorResponse("not_running", result.error, 409);
        }
        return errorResponse("clear_pending_failed", result.error ?? "Unknown error", 400);
      }

      return successResponse();
    },
  },

  "/api/tasks/:id/follow-up": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Send a follow-up message to a task.",
    requestSchema: FollowUpRequestSchema,
    /**
     * POST /api/tasks/:id/follow-up - Start a new feedback cycle from a restartable terminal state.
     */
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(FollowUpRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      const body = validation.data;

      if (body.model !== null) {
        const modelError = await validateEnabledModelForTask(ctx.params["id"]!, body.model);
        if (modelError) {
          return modelError;
        }
      }

      const result = await taskManager.sendFollowUp(ctx.params["id"]!, {
        message: body.message.trim(),
        model: body.model ?? undefined,
        attachments: body.attachments,
        promptMode: body.promptMode ?? "task_context",
      });
      if (!result.success) {
        if (result.error?.includes("not found")) {
          return errorResponse("not_found", "Task not found", 404);
        }
        return errorResponse("invalid_state", result.error ?? "Task cannot accept a terminal follow-up", 400);
      }

      return successResponse();
    },
  },
});
