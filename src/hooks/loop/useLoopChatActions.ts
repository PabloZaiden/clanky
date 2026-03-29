/**
 * Chat and communication actions for the useLoop hook.
 * Handles chat messages, follow-ups, SSH connections, and review comment addressing.
 */

import { useCallback } from "react";
import {
  addressReviewCommentsApi,
  convertChatToLoopApi,
  sendChatMessageApi,
  sendFollowUpApi,
  getOrCreateLoopSshSessionApi,
  type AddressCommentsResult,
} from "../loopActions";
import { createLogger } from "../../lib/logger";
import type { SshSession } from "../../types";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type { UseLoopActionsParams } from "./useLoopActions";

const log = createLogger("useLoop");

export interface UseLoopChatActionsResult {
  addressReviewComments: (comments: string, attachments?: MessageImageAttachment[]) => Promise<AddressCommentsResult>;
  convertChatToLoop: () => Promise<boolean>;
  sendChatMessage: (
    message: string,
    model?: { providerID: string; modelID: string },
    attachments?: MessageImageAttachment[],
  ) => Promise<boolean>;
  sendFollowUp: (
    message: string,
    model?: { providerID: string; modelID: string },
    attachments?: MessageImageAttachment[],
  ) => Promise<boolean>;
  connectViaSsh: () => Promise<SshSession | null>;
}

export function useLoopChatActions(params: UseLoopActionsParams): UseLoopChatActionsResult {
  const { loopId, isActiveLoop, ignoreStaleLoopAction, ignoreStaleLoopError, setError, setLoop, refresh } =
    params;

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

  const sendChatMessage = useCallback(
      async (
        message: string,
        model?: { providerID: string; modelID: string },
        attachments?: MessageImageAttachment[],
      ): Promise<boolean> => {
      const actionLoopId = loopId;
      const staleAction = ignoreStaleLoopAction("sendChatMessage", actionLoopId, false);
      if (staleAction !== null) {
        return staleAction;
      }
      log.debug("Sending chat message", { loopId: actionLoopId, messageLength: message.length });
      try {
        await sendChatMessageApi(actionLoopId, message, model, attachments);
        await refresh();
        if (!isActiveLoop(actionLoopId)) {
          return false;
        }
        log.debug("Chat message sent", { loopId: actionLoopId });
        return true;
      } catch (err) {
        const staleError = ignoreStaleLoopError("sendChatMessage", actionLoopId, false, err);
        if (staleError !== null) {
          return staleError;
        }
        log.error("Failed to send chat message", { loopId: actionLoopId, error: String(err) });
        setError(String(err));
        return false;
      }
    },
    [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError],
  );

  const convertChatToLoop = useCallback(async (): Promise<boolean> => {
    const actionLoopId = loopId;
    const staleAction = ignoreStaleLoopAction("convertChatToLoop", actionLoopId, false);
    if (staleAction !== null) {
      return staleAction;
    }

    try {
      const loop = await convertChatToLoopApi(actionLoopId);
      setLoop(loop);
      await refresh();
      if (!isActiveLoop(actionLoopId)) {
        return false;
      }
      return true;
    } catch (err) {
      const staleError = ignoreStaleLoopError("convertChatToLoop", actionLoopId, false, err);
      if (staleError !== null) {
        return staleError;
      }
      log.error("Failed to convert chat to loop", { loopId: actionLoopId, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [ignoreStaleLoopAction, ignoreStaleLoopError, isActiveLoop, loopId, refresh, setError, setLoop]);

  const sendFollowUp = useCallback(
      async (
        message: string,
        model?: { providerID: string; modelID: string },
        attachments?: MessageImageAttachment[],
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
        await sendFollowUpApi(actionLoopId, message, model, attachments);
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

  return { addressReviewComments, convertChatToLoop, sendChatMessage, sendFollowUp, connectViaSsh };
}
