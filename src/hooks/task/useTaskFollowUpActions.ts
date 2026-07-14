/**
 * Follow-up and review actions for the useTask hook.
 * Handles reviewer comments, terminal-state follow-ups, and task SSH connections.
 */

import { useCallback } from "react";
import {
  addressReviewCommentsApi,
  enablePullRequestAutoMergeApi,
  sendFollowUpApi,
  getOrCreateTaskSshSessionApi,
  type AddressCommentsResult,
  type PullRequestAutoMergeResult,
  startAutomaticPrFlowApi,
  stopAutomaticPrFlowApi,
  type AutomaticPrFlowResult,
} from "../taskActions";
import { createLogger } from "../../lib/logger";
import type { FollowUpPromptMode } from "@/shared/task";
import type { SshSession } from "@/shared";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import type { UseTaskActionsParams } from "./useTaskActions";

const log = createLogger("useTask");

export interface UseTaskFollowUpActionsResult {
  addressReviewComments: (comments: string, attachments?: MessageImageAttachment[]) => Promise<AddressCommentsResult>;
  enablePullRequestAutoMerge: () => Promise<PullRequestAutoMergeResult>;
  startAutomaticPrFlow: () => Promise<AutomaticPrFlowResult>;
  stopAutomaticPrFlow: () => Promise<AutomaticPrFlowResult>;
  sendFollowUp: (
    message: string,
    model?: { providerID: string; modelID: string },
    attachments?: MessageImageAttachment[],
    promptMode?: FollowUpPromptMode,
  ) => Promise<boolean>;
  connectViaSsh: () => Promise<SshSession | null>;
}

export function useTaskFollowUpActions(params: UseTaskActionsParams): UseTaskFollowUpActionsResult {
  const { taskId, isActiveTask, ignoreStaleTaskAction, ignoreStaleTaskError, setError, refresh } = params;

  const addressReviewComments = useCallback(
    async (comments: string, attachments?: MessageImageAttachment[]): Promise<AddressCommentsResult> => {
      const actionTaskId = taskId;
      const staleAction = ignoreStaleTaskAction("addressReviewComments", actionTaskId, {
        success: false,
      });
      if (staleAction !== null) {
        return staleAction;
      }
      log.debug("Addressing review comments", {
        taskId: actionTaskId,
        commentsLength: comments.length,
      });
      try {
        const result = await addressReviewCommentsApi(actionTaskId, comments, attachments);
        await refresh();
        if (!isActiveTask(actionTaskId)) {
          return { success: false };
        }
        log.info("Review comments addressed", {
          taskId: actionTaskId,
          reviewCycle: result.reviewCycle,
        });
        return result;
      } catch (err) {
        const staleError = ignoreStaleTaskError(
          "addressReviewComments",
          actionTaskId,
          { success: false },
          err,
        );
        if (staleError !== null) {
          return staleError;
        }
        log.error("Failed to address review comments", {
          taskId: actionTaskId,
          error: String(err),
        });
        setError(String(err));
        return { success: false };
      }
    },
    [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError],
  );

  const sendFollowUp = useCallback(
    async (
      message: string,
      model?: { providerID: string; modelID: string },
      attachments?: MessageImageAttachment[],
      promptMode: FollowUpPromptMode = "task_context",
    ): Promise<boolean> => {
      const actionTaskId = taskId;
      const staleAction = ignoreStaleTaskAction("sendFollowUp", actionTaskId, false);
      if (staleAction !== null) {
        return staleAction;
      }
      log.debug("Sending terminal follow-up", {
        taskId: actionTaskId,
        messageLength: message.length,
      });
      try {
        await sendFollowUpApi(actionTaskId, message, model, attachments, promptMode);
        await refresh();
        if (!isActiveTask(actionTaskId)) {
          return false;
        }
        log.debug("Terminal follow-up sent", { taskId: actionTaskId });
        return true;
      } catch (err) {
        const staleError = ignoreStaleTaskError("sendFollowUp", actionTaskId, false, err);
        if (staleError !== null) {
          return staleError;
        }
        log.error("Failed to send terminal follow-up", {
          taskId: actionTaskId,
          error: String(err),
        });
        setError(String(err));
        return false;
      }
    },
    [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError],
  );

  const enablePullRequestAutoMerge = useCallback(async (): Promise<PullRequestAutoMergeResult> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("enablePullRequestAutoMerge", actionTaskId, { success: false });
    if (staleAction !== null) {
      return staleAction;
    }
    try {
      const result = await enablePullRequestAutoMergeApi(actionTaskId);
      await refresh();
      if (!isActiveTask(actionTaskId)) {
        return { success: false };
      }
      return result;
    } catch (err) {
      const staleError = ignoreStaleTaskError("enablePullRequestAutoMerge", actionTaskId, { success: false }, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to enable pull request auto-merge", {
        taskId: actionTaskId,
        error: String(err),
      });
      setError(String(err));
      return { success: false };
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError]);

  const startAutomaticPrFlow = useCallback(async (): Promise<AutomaticPrFlowResult> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("startAutomaticPrFlow", actionTaskId, { success: false });
    if (staleAction !== null) {
      return staleAction;
    }
    try {
      const result = await startAutomaticPrFlowApi(actionTaskId);
      await refresh();
      if (!isActiveTask(actionTaskId)) {
        return { success: false };
      }
      return result;
    } catch (err) {
      const staleError = ignoreStaleTaskError("startAutomaticPrFlow", actionTaskId, { success: false }, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to start automatic PR flow", {
        taskId: actionTaskId,
        error: String(err),
      });
      setError(String(err));
      return { success: false };
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError]);

  const stopAutomaticPrFlow = useCallback(async (): Promise<AutomaticPrFlowResult> => {
    const actionTaskId = taskId;
    const staleAction = ignoreStaleTaskAction("stopAutomaticPrFlow", actionTaskId, { success: false });
    if (staleAction !== null) {
      return staleAction;
    }
    try {
      const result = await stopAutomaticPrFlowApi(actionTaskId);
      await refresh();
      if (!isActiveTask(actionTaskId)) {
        return { success: false };
      }
      return result;
    } catch (err) {
      const staleError = ignoreStaleTaskError("stopAutomaticPrFlow", actionTaskId, { success: false }, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to stop automatic PR flow", {
        taskId: actionTaskId,
        error: String(err),
      });
      setError(String(err));
      return { success: false };
    }
  }, [ignoreStaleTaskAction, ignoreStaleTaskError, isActiveTask, taskId, refresh, setError]);

  const connectViaSsh = useCallback(async (): Promise<SshSession | null> => {
    const actionTaskId = taskId;
    if (!isActiveTask(actionTaskId)) {
      log.debug("Ignoring stale task action", {
        actionName: "connectViaSsh",
        expectedTaskId: actionTaskId,
        activeTaskId: "(stale)",
      });
      return null;
    }
    log.debug("Connecting task SSH session", { taskId: actionTaskId });
    try {
      const session = await getOrCreateTaskSshSessionApi(actionTaskId);
      if (!isActiveTask(actionTaskId)) {
        return null;
      }
      return session;
    } catch (err) {
      if (!isActiveTask(actionTaskId)) {
        log.debug("Ignoring stale task action error", {
          actionName: "connectViaSsh",
          expectedTaskId: actionTaskId,
          activeTaskId: "(stale)",
          error: String(err),
        });
        return null;
      }
      log.error("Failed to connect task SSH session", { taskId: actionTaskId, error: String(err) });
      setError(String(err));
      return null;
    }
  }, [isActiveTask, taskId, setError]);

  return {
    addressReviewComments,
    enablePullRequestAutoMerge,
    startAutomaticPrFlow,
    stopAutomaticPrFlow,
    sendFollowUp,
    connectViaSsh,
  };
}
