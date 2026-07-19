/**
 * Git operation actions for the useTask hook.
 * Handles local accept, push, and branch update operations.
 */

import { useCallback } from "react";
import {
  acceptTaskApi,
  pushTaskApi,
  updateBranchApi,
  type AcceptTaskResult,
  type PushTaskResult,
} from "../taskActions";
import { createClientLogger } from "../../lib/client-logger";
import type { UseTaskActionsParams } from "./useTaskActions";

const log = createClientLogger("useTask");

export interface UseTaskGitActionsResult {
  accept: () => Promise<AcceptTaskResult>;
  push: () => Promise<PushTaskResult>;
  updateBranch: () => Promise<PushTaskResult>;
}

export function useTaskGitActions(params: UseTaskActionsParams): UseTaskGitActionsResult {
  const { taskId, isActiveTask, ignoreStaleTaskAction, ignoreStaleTaskError, setError, refresh } =
    params;

  const accept = useCallback(async (): Promise<AcceptTaskResult> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("accept", actionTaskId, { success: false });
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Accepting task", { taskId: actionTaskId });
    try {
      const result = await acceptTaskApi(actionTaskId);
      await refresh();
      if (!isActiveTask(actionTaskId)) {
        return { success: false };
      }
      log.info("Task accepted locally", { taskId: actionTaskId });
      return result;
    } catch (err) {
      const staleError = ignoreStaleTaskError("accept", actionTaskId, { success: false }, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to accept task", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return { success: false };
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError]);

  const push = useCallback(async (): Promise<PushTaskResult> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("push", actionTaskId, { success: false });
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Pushing task", { taskId: actionTaskId });
    try {
      const result = await pushTaskApi(actionTaskId);
      await refresh();
      if (!isActiveTask(actionTaskId)) {
        return { success: false };
      }
      log.info("Task pushed", { taskId: actionTaskId, remoteBranch: result.remoteBranch });
      return result;
    } catch (err) {
      const staleError = ignoreStaleTaskError("push", actionTaskId, { success: false }, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to push task", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return { success: false };
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError]);

  const updateBranch = useCallback(async (): Promise<PushTaskResult> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("updateBranch", actionTaskId, { success: false });
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Updating branch", { taskId: actionTaskId });
    try {
      const result = await updateBranchApi(actionTaskId);
      await refresh();
      if (!isActiveTask(actionTaskId)) {
        return { success: false };
      }
      log.info("Branch updated", {
        taskId: actionTaskId,
        remoteBranch: result.remoteBranch,
        syncStatus: result.syncStatus,
      });
      return result;
    } catch (err) {
      const staleError = ignoreStaleTaskError("updateBranch", actionTaskId, { success: false }, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to update branch", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return { success: false };
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError]);

  return { accept, push, updateBranch };
}
