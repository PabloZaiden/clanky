import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Tasks review routes - handle review comments after push/merge.
 *
 * These endpoints allow addressing reviewer feedback on completed tasks:
 * - POST /api/tasks/:id/address-comments - Start addressing reviewer comments
 * - GET /api/tasks/:id/review-history - Get review history for a task
 */

import { taskManager } from "../../core/task-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { parseAndValidate } from "../validation";
import { domainErrorResponse, successResponse } from "../helpers";
import type { AddressCommentsResponse, ReviewHistoryResponse } from "@/contracts";
import { AddressCommentsRequestSchema } from "@/contracts/schemas";
import { isTaskOperationError } from "../../core/task/task-errors";
import { taskErrorResponse } from "./helpers";

const log = createLogger("api:tasks");

export const tasksReviewRoutes = defineRoutes({
  "/api/tasks/:id/address-comments": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Address review comments for a task.",
    requestSchema: AddressCommentsRequestSchema,
    /**
     * POST /api/tasks/:id/address-comments - Start addressing reviewer comments.
     *
     * Creates a new review cycle and restarts the task to address the provided
     * reviewer comments. The task will work on addressing the feedback.
     * Only works for tasks in pushed or merged status that aren't already running.
     *
     * Request Body:
     * - comments (required): Reviewer's comments to address
     *
     * @returns AddressCommentsResponse with reviewCycle, branch, and commentIds
     */
    async POST(req: Request, ctx): Promise<Response> {
      // Parse and validate request body using Zod schema
      const validation = await parseAndValidate(AddressCommentsRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      const body = validation.data;

      try {
        const result = await taskManager.addressReviewComments(ctx.params["id"]!, body.comments, body.attachments);

        if (!result.success) {
          const mappedResponse = taskErrorResponse(result.error, {
            error: "address_comments_failed",
            message: "Failed to address review comments",
            status: 400,
          });

          const responseBody: AddressCommentsResponse = {
            success: false,
            error: result.error.message,
          };
          return Response.json(
            { ...responseBody, code: result.error.code },
            { status: mappedResponse.status },
          );
        }

        const responseBody: AddressCommentsResponse = {
          success: true,
          reviewCycle: result.reviewCycle!,
          branch: result.branch!,
          commentIds: result.commentIds!,
        };
        return Response.json(responseBody);
      } catch (error) {
        log.error("Failed to address review comments", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        if (isTaskOperationError(error)) {
          return taskErrorResponse(error, {
            error: "address_comments_failed",
            message: "Failed to address review comments",
            status: 500,
          });
        }
        const responseBody: AddressCommentsResponse = {
          success: false,
          error: "Failed to address review comments",
        };
        return Response.json(responseBody, { status: 500 });
      }
    },
  },

  "/api/tasks/:id/review-history": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read review history for a task.",
    /**
     * GET /api/tasks/:id/review-history - Get review history for a task.
     *
     * Returns the review history including addressability, completion action,
     * number of review cycles, and list of review branches created.
     *
     * @returns ReviewHistoryResponse with history object
     */
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const result = await taskManager.getReviewHistory(ctx.params["id"]!);

        if (!result.success) {
          const mappedResponse = taskErrorResponse(result.error, {
            error: "get_review_history_failed",
            message: "Failed to get task review history",
            status: 400,
          });
          const responseBody: ReviewHistoryResponse = {
            success: false,
            error: result.error.message,
          };
          return Response.json(
            { ...responseBody, code: result.error.code },
            { status: mappedResponse.status },
          );
        }

        const responseBody: ReviewHistoryResponse = {
          success: true,
          history: result.history!,
        };
        return Response.json(responseBody);
      } catch (error) {
        log.error("Failed to get task review history", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        if (isTaskOperationError(error)) {
          return taskErrorResponse(error, {
            error: "get_review_history_failed",
            message: "Failed to get task review history",
            status: 500,
          });
        }
        return domainErrorResponse(error, {
          fallback: {
            error: "get_review_history_failed",
            message: "Failed to get task review history",
            status: 500,
          },
        });
      }
    },
  },

  "/api/tasks/:id/automatic-pr-flow/start": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Enable automatic pull request monitoring for a task.",
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const result = await taskManager.startAutomaticPrFlow(ctx.params["id"]!);
        if (!result.success) {
          return taskErrorResponse(result.error, {
            error: "automatic_pr_flow_start_failed",
            message: "Failed to start automatic PR flow",
            status: 400,
          });
        }
        return successResponse({ automaticPrFlow: result.automaticPrFlow });
      } catch (error) {
        log.error("Failed to start automatic PR flow", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        if (isTaskOperationError(error)) {
          return taskErrorResponse(error, {
            error: "automatic_pr_flow_start_failed",
            message: "Failed to start automatic PR flow",
            status: 500,
          });
        }
        return domainErrorResponse(error, {
          fallback: {
            error: "automatic_pr_flow_start_failed",
            message: "Failed to start automatic PR flow",
            status: 500,
          },
        });
      }
    },
  },

  "/api/tasks/:id/automatic-pr-flow/stop": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Disable automatic pull request monitoring for a task.",
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const result = await taskManager.stopAutomaticPrFlow(ctx.params["id"]!);
        if (!result.success) {
          return taskErrorResponse(result.error, {
            error: "automatic_pr_flow_stop_failed",
            message: "Failed to stop automatic PR flow",
            status: 400,
          });
        }
        return successResponse({ automaticPrFlow: result.automaticPrFlow });
      } catch (error) {
        log.error("Failed to stop automatic PR flow", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        if (isTaskOperationError(error)) {
          return taskErrorResponse(error, {
            error: "automatic_pr_flow_stop_failed",
            message: "Failed to stop automatic PR flow",
            status: 500,
          });
        }
        return domainErrorResponse(error, {
          fallback: {
            error: "automatic_pr_flow_stop_failed",
            message: "Failed to stop automatic PR flow",
            status: 500,
          },
        });
      }
    },
  },

  "/api/tasks/:id/pull-request/auto-merge": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Enable pull request auto-merge for a task.",
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const result = await taskManager.enablePullRequestAutoMerge(ctx.params["id"]!);
        if (!result.success) {
          return taskErrorResponse(result.error, {
            error: "pull_request_auto_merge_enable_failed",
            message: "Failed to enable pull request auto-merge",
            status: 400,
          });
        }
        return successResponse({ pullRequest: result.pullRequest });
      } catch (error) {
        log.error("Failed to enable pull request auto-merge", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        if (isTaskOperationError(error)) {
          return taskErrorResponse(error, {
            error: "pull_request_auto_merge_enable_failed",
            message: "Failed to enable pull request auto-merge",
            status: 500,
          });
        }
        return domainErrorResponse(error, {
          fallback: {
            error: "pull_request_auto_merge_enable_failed",
            message: "Failed to enable pull request auto-merge",
            status: 500,
          },
        });
      }
    },
  },
});
