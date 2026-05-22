/**
 * Action callbacks for the useTask hook.
 * Thin compositor that aggregates focused sub-hooks by domain:
 * - useTaskLifecycleActions – update, remove, stop, discard, purge, markMerged, closeLocalTask, manualCompleteTask
 * - useTaskGitActions       – accept, push, updateBranch
 * - useTaskPlanActions      – sendPlanFeedback, acceptPlan, discardPlan
 * - useTaskPendingActions   – setPendingPrompt, clearPendingPrompt, setPending, clearPending
 * - useTaskFollowUpActions  – sendFollowUp, connectViaSsh, addressReviewComments
 */

import type { Dispatch, SetStateAction } from "react";
import type { Task, UpdateTaskRequest, SshSession } from "../../types";
import type { FollowUpPromptMode } from "../../types/task";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type {
  AcceptTaskResult,
  AcceptPlanResult,
  PushTaskResult,
  AddressCommentsResult,
  AutomaticPrFlowResult,
  PullRequestAutoMergeResult,
  SetPendingResult,
} from "../taskActions";
import { useTaskLifecycleActions } from "./useTaskLifecycleActions";
import { useTaskGitActions } from "./useTaskGitActions";
import { useTaskPlanActions } from "./useTaskPlanActions";
import { useTaskPendingActions } from "./useTaskPendingActions";
import { useTaskFollowUpActions } from "./useTaskFollowUpActions";

export interface UseTaskActionsParams {
  taskId: string;
  isActiveTask: (expectedTaskId: string) => boolean;
  ignoreStaleTaskAction: <T>(actionName: string, expectedTaskId: string, fallback: T) => T | null;
  ignoreStaleTaskError: <T>(
    actionName: string,
    expectedTaskId: string,
    fallback: T,
    error: unknown,
  ) => T | null;
  setTask: Dispatch<SetStateAction<Task | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  refresh: () => Promise<void>;
}

export interface UseTaskActionsResult {
  update: (request: UpdateTaskRequest) => Promise<boolean>;
  remove: () => Promise<boolean>;
  stopTask: () => Promise<boolean>;
  accept: () => Promise<AcceptTaskResult>;
  push: () => Promise<PushTaskResult>;
  updateBranch: () => Promise<PushTaskResult>;
  discard: () => Promise<boolean>;
  purge: () => Promise<boolean>;
  markMerged: () => Promise<boolean>;
  closeLocalTask: () => Promise<boolean>;
  manualCompleteTask: () => Promise<boolean>;
  setPendingPrompt: (prompt: string, attachments?: MessageImageAttachment[]) => Promise<boolean>;
  clearPendingPrompt: () => Promise<boolean>;
  sendPlanFeedback: (feedback: string, attachments?: MessageImageAttachment[]) => Promise<boolean>;
  acceptPlan: (mode?: "start_task" | "open_ssh") => Promise<AcceptPlanResult>;
  discardPlan: () => Promise<boolean>;
  addressReviewComments: (comments: string, attachments?: MessageImageAttachment[]) => Promise<AddressCommentsResult>;
  enablePullRequestAutoMerge: () => Promise<PullRequestAutoMergeResult>;
  startAutomaticPrFlow: () => Promise<AutomaticPrFlowResult>;
  stopAutomaticPrFlow: () => Promise<AutomaticPrFlowResult>;
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
    promptMode?: FollowUpPromptMode,
  ) => Promise<boolean>;
  connectViaSsh: () => Promise<SshSession | null>;
}

export function useTaskActions(params: UseTaskActionsParams): UseTaskActionsResult {
  const lifecycle = useTaskLifecycleActions(params);
  const git = useTaskGitActions(params);
  const plan = useTaskPlanActions(params);
  const pending = useTaskPendingActions(params);
  const followUp = useTaskFollowUpActions(params);

  return {
    ...lifecycle,
    ...git,
    ...plan,
    ...pending,
    ...followUp,
  };
}
