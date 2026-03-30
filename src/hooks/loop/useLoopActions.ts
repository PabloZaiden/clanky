/**
 * Action callbacks for the useLoop hook.
 * Thin compositor that aggregates focused sub-hooks by domain:
 * - useLoopLifecycleActions – update, remove, stop, discard, purge, markMerged
 * - useLoopGitActions       – accept, push, updateBranch
 * - useLoopPlanActions      – sendPlanFeedback, answerPlanQuestion, acceptPlan, discardPlan
 * - useLoopPendingActions   – setPendingPrompt, clearPendingPrompt, setPending, clearPending
 * - useLoopFollowUpActions  – sendFollowUp, connectViaSsh, addressReviewComments
 */

import type { Dispatch, SetStateAction } from "react";
import type { Loop, UpdateLoopRequest, SshSession } from "../../types";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type {
  AcceptLoopResult,
  AcceptPlanResult,
  PushLoopResult,
  AddressCommentsResult,
  SetPendingResult,
} from "../loopActions";
import { useLoopLifecycleActions } from "./useLoopLifecycleActions";
import { useLoopGitActions } from "./useLoopGitActions";
import { useLoopPlanActions } from "./useLoopPlanActions";
import { useLoopPendingActions } from "./useLoopPendingActions";
import { useLoopFollowUpActions } from "./useLoopFollowUpActions";

export interface UseLoopActionsParams {
  loopId: string;
  isActiveLoop: (expectedLoopId: string) => boolean;
  ignoreStaleLoopAction: <T>(actionName: string, expectedLoopId: string, fallback: T) => T | null;
  ignoreStaleLoopError: <T>(
    actionName: string,
    expectedLoopId: string,
    fallback: T,
    error: unknown,
  ) => T | null;
  setLoop: Dispatch<SetStateAction<Loop | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  refresh: () => Promise<void>;
}

export interface UseLoopActionsResult {
  update: (request: UpdateLoopRequest) => Promise<boolean>;
  remove: () => Promise<boolean>;
  stopLoop: () => Promise<boolean>;
  accept: () => Promise<AcceptLoopResult>;
  push: () => Promise<PushLoopResult>;
  updateBranch: () => Promise<PushLoopResult>;
  discard: () => Promise<boolean>;
  purge: () => Promise<boolean>;
  markMerged: () => Promise<boolean>;
  setPendingPrompt: (prompt: string, attachments?: MessageImageAttachment[]) => Promise<boolean>;
  clearPendingPrompt: () => Promise<boolean>;
  sendPlanFeedback: (feedback: string, attachments?: MessageImageAttachment[]) => Promise<boolean>;
  answerPlanQuestion: (answers: string[][]) => Promise<boolean>;
  acceptPlan: (mode?: "start_loop" | "open_ssh") => Promise<AcceptPlanResult>;
  discardPlan: () => Promise<boolean>;
  addressReviewComments: (comments: string, attachments?: MessageImageAttachment[]) => Promise<AddressCommentsResult>;
  setPending: (options: {
    message?: string;
    model?: { providerID: string; modelID: string };
    attachments?: MessageImageAttachment[];
  }) => Promise<SetPendingResult>;
  clearPending: () => Promise<boolean>;
  sendFollowUp: (
    message: string,
    model?: { providerID: string; modelID: string },
    attachments?: MessageImageAttachment[],
  ) => Promise<boolean>;
  connectViaSsh: () => Promise<SshSession | null>;
}

export function useLoopActions(params: UseLoopActionsParams): UseLoopActionsResult {
  const lifecycle = useLoopLifecycleActions(params);
  const git = useLoopGitActions(params);
  const plan = useLoopPlanActions(params);
  const pending = useLoopPendingActions(params);
  const followUp = useLoopFollowUpActions(params);

  return {
    ...lifecycle,
    ...git,
    ...plan,
    ...pending,
    ...followUp,
  };
}
