import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Task accept and push routes.
 *
 * - POST /api/tasks/:id/accept       - Accept committed task changes locally
 * - POST /api/tasks/:id/push         - Push task branch to remote for PR workflow
 * - POST /api/tasks/:id/update-branch - Sync pushed branch with base branch
 * - POST /api/tasks/:id/mark-merged  - Mark an externally merged task as merged
 * - POST /api/tasks/:id/close-local  - Close a locally accepted task
 * - POST /api/tasks/:id/manual-complete - Promote a stopped/failed task to completed
 */

import { taskManager } from "../../core/task-manager";
import { createLogger } from "../../core/logger";
import { successResponse } from "../helpers";
import type { AcceptResponse, PushResponse } from "@/contracts";
import { taskActionErrorResponse } from "./helpers";

const log = createLogger("api:tasks");

export const tasksAcceptPushRoutes = defineRoutes({
  "/api/tasks/:id/accept": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Accept a completed task locally without pushing.",
    /**
     * POST /api/tasks/:id/accept - Accept a completed task locally.
     *
     * Leaves the task's commits in the working branch without pushing.
     * Only works for tasks in completed or max_iterations status.
     * After accept, the task status changes to `accepted_local`.
     *
     * @returns AcceptResponse with success
     */
    async POST(_req: Request, ctx): Promise<Response> {
      log.debug("POST /api/tasks/:id/accept", { taskId: ctx.params["id"]! });
      const result = await taskManager.acceptTask(ctx.params["id"]!);

      if (!result.success) {
        log.warn("POST /api/tasks/:id/accept - Failed", {
          taskId: ctx.params["id"]!,
          errorCode: result.error.code,
        });
        return taskActionErrorResponse(result.error, {
          error: "accept_failed",
          message: "Failed to accept task",
          status: 400,
        });
      }

      log.info("POST /api/tasks/:id/accept - Task accepted locally", { taskId: ctx.params["id"]! });
      const response: AcceptResponse = {
        success: true,
      };
      return Response.json(response);
    },
  },

  "/api/tasks/:id/push": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Push a completed task branch to the remote repository.",
    /**
     * POST /api/tasks/:id/push - Push a completed task's branch to remote.
     *
     * Pushes the task's working branch to the remote repository for PR workflow.
     * Only works for tasks in completed or max_iterations status.
     * After push, the task status changes to `pushed` and can receive review comments.
     *
     * @returns PushResponse with success and remoteBranch name
     */
    async POST(_req: Request, ctx): Promise<Response> {
      log.debug("POST /api/tasks/:id/push", { taskId: ctx.params["id"]! });
      const result = await taskManager.pushTask(ctx.params["id"]!);

      if (!result.success) {
        log.warn("POST /api/tasks/:id/push - Failed", {
          taskId: ctx.params["id"]!,
          errorCode: result.error.code,
        });
        return taskActionErrorResponse(result.error, {
          error: "push_failed",
          message: "Failed to push task",
          status: 400,
        });
      }

      log.info("POST /api/tasks/:id/push - Task pushed", { taskId: ctx.params["id"]!, remoteBranch: result.remoteBranch, syncStatus: result.syncStatus });
      const syncStatus = result.syncStatus ?? "already_up_to_date";
      let response: PushResponse;
      if (syncStatus === "conflicts_being_resolved") {
        response = { success: true, syncStatus };
      } else {
        response = { success: true, remoteBranch: result.remoteBranch!, syncStatus };
      }
      return Response.json(response);
    },
  },

  "/api/tasks/:id/update-branch": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Sync a pushed task branch with its base branch.",
    /**
     * POST /api/tasks/:id/update-branch - Update a pushed task's branch by syncing with the base branch.
     *
     * Pulls and merges from the base branch into the working branch, then re-pushes.
     * Only works for tasks in `pushed` status.
     * If the merge is clean, pushes immediately and the task remains in `pushed` status.
     * If there are conflicts, starts a conflict resolution engine and auto-pushes on completion.
     *
     * @returns PushResponse with success and sync status
     */
    async POST(_req: Request, ctx): Promise<Response> {
      log.debug("POST /api/tasks/:id/update-branch", { taskId: ctx.params["id"]! });
      const result = await taskManager.updateBranch(ctx.params["id"]!);

      if (!result.success) {
        log.warn("POST /api/tasks/:id/update-branch - Failed", {
          taskId: ctx.params["id"]!,
          errorCode: result.error.code,
        });
        return taskActionErrorResponse(result.error, {
          error: "update_branch_failed",
          message: "Failed to update task branch",
          status: 400,
        });
      }

      log.info("POST /api/tasks/:id/update-branch - Branch updated", { taskId: ctx.params["id"]!, remoteBranch: result.remoteBranch, syncStatus: result.syncStatus });
      const syncStatus = result.syncStatus ?? "already_up_to_date";
      let response: PushResponse;
      if (syncStatus === "conflicts_being_resolved") {
        response = { success: true, syncStatus };
      } else {
        response = { success: true, remoteBranch: result.remoteBranch!, syncStatus };
      }
      return Response.json(response);
    },
  },

  "/api/tasks/:id/mark-merged": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Mark a task as merged after an external merge.",
    /**
     * POST /api/tasks/:id/mark-merged - Mark an externally merged task as merged.
     *
     * Transitions the task to `merged` status, clears reviewMode.addressable,
     * and disconnects the backend. Because tasks may run in dedicated worktrees,
     * cleanup is deferred to the normal purge/discard flow instead of assuming
     * immediate branch teardown here.
     *
     * This is useful when a task's branch was merged externally (e.g., via GitHub PR)
     * and the user wants to sync the task's status with that merged result.
     *
     * Only works for tasks in final states (pushed, merged, completed, max_iterations).
     *
     * @returns Success response
     */
    async POST(_req: Request, ctx): Promise<Response> {
      const result = await taskManager.markMerged(ctx.params["id"]!);

      if (!result.success) {
        return taskActionErrorResponse(result.error, {
          error: "mark_merged_failed",
          message: "Failed to mark task as merged",
          status: 400,
        });
      }

      return successResponse();
    },
  },

  "/api/tasks/:id/close-local": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Close a locally accepted task without PR actions.",
    /**
     * POST /api/tasks/:id/close-local - Stop accepting follow-up comments locally.
     *
     * This is the local-only equivalent of ending PR review handling. It keeps
     * the local commits intact, disables follow-up comments, and performs no git
     * operations.
     *
     * @returns Success response
     */
    async POST(_req: Request, ctx): Promise<Response> {
      const result = await taskManager.closeLocalTask(ctx.params["id"]!);

      if (!result.success) {
        return taskActionErrorResponse(result.error, {
          error: "close_local_failed",
          message: "Failed to close local task",
          status: 400,
        });
      }

      return successResponse();
    },
  },

  "/api/tasks/:id/manual-complete": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Promote a stopped or failed task to completed.",
    /**
     * POST /api/tasks/:id/manual-complete - Manually finalize a halted task.
     *
     * Promotes a stopped or failed task into `completed` status without resuming
     * execution so the existing accept/push flows become available.
     *
     * @returns Success response
     */
    async POST(_req: Request, ctx): Promise<Response> {
      const result = await taskManager.manualCompleteTask(ctx.params["id"]!);

      if (!result.success) {
        return taskActionErrorResponse(result.error, {
          error: "manual_complete_failed",
          message: "Failed to manually complete task",
          status: 400,
        });
      }

      return successResponse();
    },
  },
});
