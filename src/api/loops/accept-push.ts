/**
 * Loop accept and push routes.
 *
 * - POST /api/loops/:id/accept       - Merge loop branch into original branch
 * - POST /api/loops/:id/push         - Push loop branch to remote for PR workflow
 * - POST /api/loops/:id/update-branch - Sync pushed branch with base branch
 * - POST /api/loops/:id/mark-merged  - Mark an externally merged loop as merged
 * - POST /api/loops/:id/manual-complete - Promote a stopped/failed loop to completed
 */

import { loopManager } from "../../core/loop-manager";
import { createLogger } from "../../core/logger";
import { errorResponse, successResponse } from "../helpers";
import type { AcceptResponse, PushResponse } from "../../types/api";

const log = createLogger("api:loops");

export const loopsAcceptPushRoutes = {
  "/api/loops/:id/accept": {
    /**
     * POST /api/loops/:id/accept - Accept and merge a completed loop.
     *
     * Merges the loop's working branch into the original branch.
     * Only works for loops in completed or max_iterations status.
     * After merge, the loop status changes to `merged`.
     *
     * @returns AcceptResponse with success and mergeCommit SHA
     */
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      log.debug("POST /api/loops/:id/accept", { loopId: req.params.id });
      const result = await loopManager.acceptLoop(req.params.id);

      if (!result.success) {
        log.warn("POST /api/loops/:id/accept - Failed", { loopId: req.params.id, error: result.error });
        if (result.error?.includes("not found")) {
          return errorResponse("not_found", "Loop not found", 404);
        }
        return errorResponse("accept_failed", result.error ?? "Unknown error", 400);
      }

      log.info("POST /api/loops/:id/accept - Loop accepted", { loopId: req.params.id, mergeCommit: result.mergeCommit });
      const response: AcceptResponse = {
        success: true,
        mergeCommit: result.mergeCommit!,
      };
      return Response.json(response);
    },
  },

  "/api/loops/:id/push": {
    /**
     * POST /api/loops/:id/push - Push a completed loop's branch to remote.
     *
     * Pushes the loop's working branch to the remote repository for PR workflow.
     * Only works for loops in completed or max_iterations status.
     * After push, the loop status changes to `pushed` and can receive review comments.
     *
     * @returns PushResponse with success and remoteBranch name
     */
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      log.debug("POST /api/loops/:id/push", { loopId: req.params.id });
      const result = await loopManager.pushLoop(req.params.id);

      if (!result.success) {
        log.warn("POST /api/loops/:id/push - Failed", { loopId: req.params.id, error: result.error });
        if (result.error?.includes("not found")) {
          return errorResponse("not_found", "Loop not found", 404);
        }
        return errorResponse("push_failed", result.error ?? "Unknown error", 400);
      }

      log.info("POST /api/loops/:id/push - Loop pushed", { loopId: req.params.id, remoteBranch: result.remoteBranch, syncStatus: result.syncStatus });
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

  "/api/loops/:id/update-branch": {
    /**
     * POST /api/loops/:id/update-branch - Update a pushed loop's branch by syncing with the base branch.
     *
     * Pulls and merges from the base branch into the working branch, then re-pushes.
     * Only works for loops in `pushed` status.
     * If the merge is clean, pushes immediately and the loop remains in `pushed` status.
     * If there are conflicts, starts a conflict resolution engine and auto-pushes on completion.
     *
     * @returns PushResponse with success and sync status
     */
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      log.debug("POST /api/loops/:id/update-branch", { loopId: req.params.id });
      const result = await loopManager.updateBranch(req.params.id);

      if (!result.success) {
        log.warn("POST /api/loops/:id/update-branch - Failed", { loopId: req.params.id, error: result.error });
        if (result.error?.includes("not found")) {
          return errorResponse("not_found", "Loop not found", 404);
        }
        return errorResponse("update_branch_failed", result.error ?? "Unknown error", 400);
      }

      log.info("POST /api/loops/:id/update-branch - Branch updated", { loopId: req.params.id, remoteBranch: result.remoteBranch, syncStatus: result.syncStatus });
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

  "/api/loops/:id/mark-merged": {
    /**
     * POST /api/loops/:id/mark-merged - Mark an externally merged loop as merged.
     *
     * Transitions the loop to `merged` status, clears reviewMode.addressable,
     * and disconnects the backend. Because loops may run in dedicated worktrees,
     * cleanup is deferred to the normal purge/discard flow instead of assuming
     * immediate branch teardown here.
     *
     * This is useful when a loop's branch was merged externally (e.g., via GitHub PR)
     * and the user wants to sync the loop's status with that merged result.
     *
     * Only works for loops in final states (pushed, merged, completed, max_iterations).
     *
     * @returns Success response
     */
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const result = await loopManager.markMerged(req.params.id);

      if (!result.success) {
        if (result.error?.includes("not found")) {
          return errorResponse("not_found", "Loop not found", 404);
        }
        return errorResponse("mark_merged_failed", result.error ?? "Unknown error", 400);
      }

      return successResponse();
    },
  },

  "/api/loops/:id/manual-complete": {
    /**
     * POST /api/loops/:id/manual-complete - Manually finalize a halted loop.
     *
     * Promotes a stopped or failed loop into `completed` status without resuming
     * execution so the existing accept/push flows become available.
     *
     * @returns Success response
     */
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const result = await loopManager.manualCompleteLoop(req.params.id);

      if (!result.success) {
        if (result.error?.includes("not found")) {
          return errorResponse("not_found", "Loop not found", 404);
        }
        return errorResponse("manual_complete_failed", result.error ?? "Unknown error", 400);
      }

      return successResponse();
    },
  },
};
