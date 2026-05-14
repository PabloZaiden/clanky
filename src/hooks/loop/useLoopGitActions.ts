/**
 * Git operation actions for the useLoop hook.
 * Handles local accept, push, and branch update operations.
 */

import { useCallback } from "react";
import {
  acceptLoopApi,
  pushLoopApi,
  updateBranchApi,
  type AcceptLoopResult,
  type PushLoopResult,
} from "../loopActions";
import { createLogger } from "../../lib/logger";
import type { UseLoopActionsParams } from "./useLoopActions";

const log = createLogger("useLoop");

export interface UseLoopGitActionsResult {
  accept: () => Promise<AcceptLoopResult>;
  push: () => Promise<PushLoopResult>;
  updateBranch: () => Promise<PushLoopResult>;
}

export function useLoopGitActions(params: UseLoopActionsParams): UseLoopGitActionsResult {
  const { loopId, isActiveLoop, ignoreStaleLoopAction, ignoreStaleLoopError, setError, refresh } =
    params;

  const accept = useCallback(async (): Promise<AcceptLoopResult> => {
    const actionLoopId = loopId;
    const staleAction = ignoreStaleLoopAction("accept", actionLoopId, { success: false });
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Accepting loop", { loopId: actionLoopId });
    try {
      const result = await acceptLoopApi(actionLoopId);
      await refresh();
      if (!isActiveLoop(actionLoopId)) {
        return { success: false };
      }
      log.info("Loop accepted locally", { loopId: actionLoopId });
      return result;
    } catch (err) {
      const staleError = ignoreStaleLoopError("accept", actionLoopId, { success: false }, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to accept loop", { loopId: actionLoopId, error: String(err) });
      setError(String(err));
      return { success: false };
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError]);

  const push = useCallback(async (): Promise<PushLoopResult> => {
    const actionLoopId = loopId;
    const staleAction = ignoreStaleLoopAction("push", actionLoopId, { success: false });
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Pushing loop", { loopId: actionLoopId });
    try {
      const result = await pushLoopApi(actionLoopId);
      await refresh();
      if (!isActiveLoop(actionLoopId)) {
        return { success: false };
      }
      log.info("Loop pushed", { loopId: actionLoopId, remoteBranch: result.remoteBranch });
      return result;
    } catch (err) {
      const staleError = ignoreStaleLoopError("push", actionLoopId, { success: false }, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to push loop", { loopId: actionLoopId, error: String(err) });
      setError(String(err));
      return { success: false };
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError]);

  const updateBranch = useCallback(async (): Promise<PushLoopResult> => {
    const actionLoopId = loopId;
    const staleAction = ignoreStaleLoopAction("updateBranch", actionLoopId, { success: false });
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Updating branch", { loopId: actionLoopId });
    try {
      const result = await updateBranchApi(actionLoopId);
      await refresh();
      if (!isActiveLoop(actionLoopId)) {
        return { success: false };
      }
      log.info("Branch updated", {
        loopId: actionLoopId,
        remoteBranch: result.remoteBranch,
        syncStatus: result.syncStatus,
      });
      return result;
    } catch (err) {
      const staleError = ignoreStaleLoopError("updateBranch", actionLoopId, { success: false }, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to update branch", { loopId: actionLoopId, error: String(err) });
      setError(String(err));
      return { success: false };
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError]);

  return { accept, push, updateBranch };
}
