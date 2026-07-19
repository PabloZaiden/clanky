/**
 * Pending/prompt actions for the useTask hook.
 * Handles setting and clearing pending prompts and model/message values.
 */

import { useCallback } from "react";
import {
  setPendingPromptApi,
  clearPendingPromptApi,
  setPendingApi,
  clearPendingApi,
  type SetPendingResult,
} from "../taskActions";
import { createLogger } from "@pablozaiden/webapp/web";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import type { UseTaskActionsParams } from "./useTaskActions";

const log = createLogger("useTask");

export interface UseTaskPendingActionsResult {
  setPendingPrompt: (prompt: string, attachments?: MessageImageAttachment[]) => Promise<boolean>;
  clearPendingPrompt: () => Promise<boolean>;
  setPending: (options: {
    message?: string;
    model?: { providerID: string; modelID: string };
    attachments?: MessageImageAttachment[];
  }) => Promise<SetPendingResult>;
  clearPending: () => Promise<boolean>;
}

export function useTaskPendingActions(params: UseTaskActionsParams): UseTaskPendingActionsResult {
  const { taskId, isActiveTask, ignoreStaleTaskAction, ignoreStaleTaskError, setError, refresh } =
    params;

  const setPendingPrompt = useCallback(
    async (prompt: string, attachments?: MessageImageAttachment[]): Promise<boolean> => {
      const actionTaskId = taskId;
      const staleAction = ignoreStaleTaskAction("setPendingPrompt", actionTaskId, false);
      if (staleAction !== null) {
        return staleAction;
      }
      log.debug("Setting pending prompt", { taskId: actionTaskId, promptLength: prompt.length });
      try {
        await setPendingPromptApi(actionTaskId, prompt, attachments);
        await refresh();
        if (!isActiveTask(actionTaskId)) {
          return false;
        }
        log.debug("Pending prompt set", { taskId: actionTaskId });
        return true;
      } catch (err) {
        const staleError = ignoreStaleTaskError("setPendingPrompt", actionTaskId, false, err);
        if (staleError !== null) {
          return staleError;
        }
        log.error("Failed to set pending prompt", { taskId: actionTaskId, error: String(err) });
        setError(String(err));
        return false;
      }
    },
    [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError],
  );

  const clearPendingPrompt = useCallback(async (): Promise<boolean> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("clearPendingPrompt", actionTaskId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.debug("Clearing pending prompt", { taskId: actionTaskId });
    try {
      await clearPendingPromptApi(actionTaskId);
      await refresh();
      if (!isActiveTask(actionTaskId)) {
        return false;
      }
      log.debug("Pending prompt cleared", { taskId: actionTaskId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleTaskError("clearPendingPrompt", actionTaskId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to clear pending prompt", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError]);

  const setPending = useCallback(
    async (options: {
      message?: string;
      model?: { providerID: string; modelID: string };
      attachments?: MessageImageAttachment[];
    }): Promise<SetPendingResult> => {
      const actionTaskId = taskId;
      const staleAction = ignoreStaleTaskAction("setPending", actionTaskId, { success: false });
      if (staleAction !== null) {
        return staleAction;
      }
      log.debug("Setting pending", {
        taskId: actionTaskId,
        hasMessage: options.message !== undefined,
        hasModel: options.model !== undefined,
      });
      try {
        const result = await setPendingApi(actionTaskId, options);
        await refresh();
        if (!isActiveTask(actionTaskId)) {
          return { success: false };
        }
        log.debug("Pending values set", { taskId: actionTaskId });
        return result;
      } catch (err) {
        const staleError = ignoreStaleTaskError(
          "setPending",
          actionTaskId,
          { success: false },
          err,
        );
        if (staleError !== null) {
          return staleError;
        }
        log.error("Failed to set pending", { taskId: actionTaskId, error: String(err) });
        setError(String(err));
        return { success: false };
      }
    },
    [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError],
  );

  const clearPending = useCallback(async (): Promise<boolean> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("clearPending", actionTaskId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.debug("Clearing pending values", { taskId: actionTaskId });
    try {
      await clearPendingApi(actionTaskId);
      await refresh();
      if (!isActiveTask(actionTaskId)) {
        return false;
      }
      log.debug("Pending values cleared", { taskId: actionTaskId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleTaskError("clearPending", actionTaskId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to clear pending", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError]);

  return { setPendingPrompt, clearPendingPrompt, setPending, clearPending };
}
