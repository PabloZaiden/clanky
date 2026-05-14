/**
 * Follow-up and review actions for the useLoop hook.
 * Handles reviewer comments, terminal-state follow-ups, and loop SSH connections.
 */

import { useCallback } from "react";
import {
  addressReviewCommentsApi,
  enablePullRequestAutoMergeApi,
  sendFollowUpApi,
  getOrCreateLoopSshSessionApi,
  type AddressCommentsResult,
  type PullRequestAutoMergeResult,
  startAutomaticPrFlowApi,
  stopAutomaticPrFlowApi,
  type AutomaticPrFlowResult,
} from "../loopActions";
import { createLogger } from "../../lib/logger";
import type { FollowUpPromptMode } from "../../types/loop";
import type { SshSession } from "../../types";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type { UseLoopActionsParams } from "./useLoopActions";

const log = createLogger("useLoop");

export interface UseLoopFollowUpActionsResult {
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

export function useLoopFollowUpActions(params: UseLoopActionsParams): UseLoopFollowUpActionsResult {
  const { loopId, isActiveLoop, ignoreStaleLoopAction, ignoreStaleLoopError, setError, refresh } = params;

  const addressReviewComments = useCallback(
    async (comments: string, attachments?: MessageImageAttachment[]): Promise<AddressCommentsResult> => {
      const actionLoopId = loopId;
      const staleAction = ignoreStaleLoopAction("addressReviewComments", actionLoopId, {
        success: false,
      });
      if (staleAction !== null) {
        return staleAction;
      }
      log.debug("Addressing review comments", {
        loopId: actionLoopId,
        commentsLength: comments.length,
      });
      try {
        const result = await addressReviewCommentsApi(actionLoopId, comments, attachments);
        await refresh();
        if (!isActiveLoop(actionLoopId)) {
          return { success: false };
        }
        log.info("Review comments addressed", {
          loopId: actionLoopId,
          reviewCycle: result.reviewCycle,
        });
        return result;
      } catch (err) {
        const staleError = ignoreStaleLoopError(
          "addressReviewComments",
          actionLoopId,
          { success: false },
          err,
        );
        if (staleError !== null) {
          return staleError;
        }
        log.error("Failed to address review comments", {
          loopId: actionLoopId,
          error: String(err),
        });
        setError(String(err));
        return { success: false };
      }
    },
    [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError],
  );

  const sendFollowUp = useCallback(
    async (
      message: string,
      model?: { providerID: string; modelID: string },
      attachments?: MessageImageAttachment[],
      promptMode: FollowUpPromptMode = "loop_context",
    ): Promise<boolean> => {
      const actionLoopId = loopId;
      const staleAction = ignoreStaleLoopAction("sendFollowUp", actionLoopId, false);
      if (staleAction !== null) {
        return staleAction;
      }
      log.debug("Sending terminal follow-up", {
        loopId: actionLoopId,
        messageLength: message.length,
      });
      try {
        await sendFollowUpApi(actionLoopId, message, model, attachments, promptMode);
        await refresh();
        if (!isActiveLoop(actionLoopId)) {
          return false;
        }
        log.debug("Terminal follow-up sent", { loopId: actionLoopId });
        return true;
      } catch (err) {
        const staleError = ignoreStaleLoopError("sendFollowUp", actionLoopId, false, err);
        if (staleError !== null) {
          return staleError;
        }
        log.error("Failed to send terminal follow-up", {
          loopId: actionLoopId,
          error: String(err),
        });
        setError(String(err));
        return false;
      }
    },
    [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError],
  );

  const enablePullRequestAutoMerge = useCallback(async (): Promise<PullRequestAutoMergeResult> => {
    const actionLoopId = loopId;
    const staleAction = ignoreStaleLoopAction("enablePullRequestAutoMerge", actionLoopId, { success: false });
    if (staleAction !== null) {
      return staleAction;
    }
    try {
      const result = await enablePullRequestAutoMergeApi(actionLoopId);
      await refresh();
      if (!isActiveLoop(actionLoopId)) {
        return { success: false };
      }
      return result;
    } catch (err) {
      const staleError = ignoreStaleLoopError("enablePullRequestAutoMerge", actionLoopId, { success: false }, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to enable pull request auto-merge", {
        loopId: actionLoopId,
        error: String(err),
      });
      setError(String(err));
      return { success: false };
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError]);

  const startAutomaticPrFlow = useCallback(async (): Promise<AutomaticPrFlowResult> => {
    const actionLoopId = loopId;
    const staleAction = ignoreStaleLoopAction("startAutomaticPrFlow", actionLoopId, { success: false });
    if (staleAction !== null) {
      return staleAction;
    }
    try {
      const result = await startAutomaticPrFlowApi(actionLoopId);
      await refresh();
      if (!isActiveLoop(actionLoopId)) {
        return { success: false };
      }
      return result;
    } catch (err) {
      const staleError = ignoreStaleLoopError("startAutomaticPrFlow", actionLoopId, { success: false }, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to start automatic PR flow", {
        loopId: actionLoopId,
        error: String(err),
      });
      setError(String(err));
      return { success: false };
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError]);

  const stopAutomaticPrFlow = useCallback(async (): Promise<AutomaticPrFlowResult> => {
    const actionLoopId = loopId;
    const staleAction = ignoreStaleLoopAction("stopAutomaticPrFlow", actionLoopId, { success: false });
    if (staleAction !== null) {
      return staleAction;
    }
    try {
      const result = await stopAutomaticPrFlowApi(actionLoopId);
      await refresh();
      if (!isActiveLoop(actionLoopId)) {
        return { success: false };
      }
      return result;
    } catch (err) {
      const staleError = ignoreStaleLoopError("stopAutomaticPrFlow", actionLoopId, { success: false }, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to stop automatic PR flow", {
        loopId: actionLoopId,
        error: String(err),
      });
      setError(String(err));
      return { success: false };
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError]);

  const connectViaSsh = useCallback(async (): Promise<SshSession | null> => {
    const actionLoopId = loopId;
    if (!isActiveLoop(actionLoopId)) {
      log.debug("Ignoring stale loop action", {
        actionName: "connectViaSsh",
        expectedLoopId: actionLoopId,
        activeLoopId: "(stale)",
      });
      return null;
    }
    log.debug("Connecting loop SSH session", { loopId: actionLoopId });
    try {
      const session = await getOrCreateLoopSshSessionApi(actionLoopId);
      if (!isActiveLoop(actionLoopId)) {
        return null;
      }
      return session;
    } catch (err) {
      if (!isActiveLoop(actionLoopId)) {
        log.debug("Ignoring stale loop action error", {
          actionName: "connectViaSsh",
          expectedLoopId: actionLoopId,
          activeLoopId: "(stale)",
          error: String(err),
        });
        return null;
      }
      log.error("Failed to connect loop SSH session", { loopId: actionLoopId, error: String(err) });
      setError(String(err));
      return null;
    }
  }, [isActiveLoop, loopId, setError]);

  return {
    addressReviewComments,
    enablePullRequestAutoMerge,
    startAutomaticPrFlow,
    stopAutomaticPrFlow,
    sendFollowUp,
    connectViaSsh,
  };
}
