/**
 * Plan-phase actions for the useTask hook.
 * Handles planning interactions: feedback, accept, and discard.
 */

import { useCallback } from "react";
import {
  sendPlanFeedbackApi,
  acceptPlanApi,
  discardPlanApi,
  type AcceptPlanResult,
} from "../taskActions";
import { createClientLogger } from "../../lib/client-logger";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import type { UseTaskActionsParams } from "./useTaskActions";

const log = createClientLogger("useTask");

export interface UseTaskPlanActionsResult {
  sendPlanFeedback: (feedback: string, attachments?: MessageImageAttachment[]) => Promise<boolean>;
  acceptPlan: (mode?: "start_task" | "open_ssh") => Promise<AcceptPlanResult>;
  discardPlan: () => Promise<boolean>;
}

export function useTaskPlanActions(params: UseTaskActionsParams): UseTaskPlanActionsResult {
  const { taskId, isActiveTask, ignoreStaleTaskAction, ignoreStaleTaskError, setTask, setError, refresh } =
    params;

  const sendPlanFeedback = useCallback(
    async (feedback: string, attachments?: MessageImageAttachment[]): Promise<boolean> => {
      const actionTaskId = taskId;
      const staleAction = ignoreStaleTaskAction("sendPlanFeedback", actionTaskId, false);
      if (staleAction !== null) {
        return staleAction;
      }
      log.info("Sending plan feedback", {
        taskId: actionTaskId,
        feedbackLength: feedback.length,
      });
      try {
        await sendPlanFeedbackApi(actionTaskId, feedback, attachments);
        await refresh();
        if (!isActiveTask(actionTaskId)) {
          return false;
        }
        log.info("Plan feedback sent", { taskId: actionTaskId });
        return true;
      } catch (err) {
        const staleError = ignoreStaleTaskError("sendPlanFeedback", actionTaskId, false, err);
        if (staleError !== null) {
          return staleError;
        }
        log.error("Failed to send plan feedback", { taskId: actionTaskId, error: String(err) });
        setError(String(err));
        return false;
      }
    },
    [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError],
  );

  const acceptPlan = useCallback(
    async (mode: "start_task" | "open_ssh" = "start_task"): Promise<AcceptPlanResult> => {
      const actionTaskId = taskId;
      const staleAction = ignoreStaleTaskAction<AcceptPlanResult>("acceptPlan", actionTaskId, {
        success: false,
      });
      if (staleAction !== null) {
        return staleAction;
      }
      log.info("Accepting plan", { taskId: actionTaskId, mode });
      try {
        const result = await acceptPlanApi(actionTaskId, mode);
        await refresh();
        if (!isActiveTask(actionTaskId)) {
          return { success: false };
        }
        if (result.success) {
          log.info("Plan accepted", { taskId: actionTaskId, mode: result.mode });
        }
        return result;
      } catch (err) {
        const staleError = ignoreStaleTaskError<AcceptPlanResult>(
          "acceptPlan",
          actionTaskId,
          { success: false },
          err,
        );
        if (staleError !== null) {
          return staleError;
        }
        log.error("Failed to accept plan", { taskId: actionTaskId, mode, error: String(err) });
        setError(String(err));
        return { success: false };
      }
    },
    [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError],
  );

  const discardPlan = useCallback(async (): Promise<boolean> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("discardPlan", actionTaskId, false);
    if (staleAction !== null) {
      return staleAction;
    }
    log.info("Discarding plan", { taskId: actionTaskId });
    try {
      await discardPlanApi(actionTaskId);
      if (!isActiveTask(actionTaskId)) {
        return false;
      }
      setTask(null);
      log.info("Plan discarded", { taskId: actionTaskId });
      return true;
    } catch (err) {
      const staleError = ignoreStaleTaskError("discardPlan", actionTaskId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to discard plan", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, setError, setTask]);

  return { sendPlanFeedback, acceptPlan, discardPlan };
}
