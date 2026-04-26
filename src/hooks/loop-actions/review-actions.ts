/**
 * Review-related loop actions: address comments, send follow-up.
 */

import { apiCall, apiActionWithBody } from "./helpers";
import type { MessageImageAttachment } from "../../types/message-attachments";

/**
 * Result of an address comments action.
 */
export interface AddressCommentsResult {
  success: boolean;
  reviewCycle?: number;
  branch?: string;
}

export interface AutomaticPrFlowResult {
  success: boolean;
  automaticPrFlow?: {
    enabled: boolean;
    status: string;
    startedAt: string;
    updatedAt: string;
    lastCheckedAt?: string;
    pullRequestNumber?: number;
    pullRequestUrl?: string;
    lastError?: string;
    stoppedAt?: string;
  };
}

export interface PullRequestAutoMergeResult {
  success: boolean;
  pullRequest?: {
    number: number;
    url: string;
  };
}

/**
 * Address reviewer comments on a pushed/merged loop via the API.
 */
export async function addressReviewCommentsApi(
  loopId: string,
  comments: string,
  attachments?: MessageImageAttachment[],
): Promise<AddressCommentsResult> {
  const data = await apiCall<{ reviewCycle: number; branch: string }>(
    `/api/loops/${loopId}/address-comments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments, attachments: attachments ?? [] }),
    },
    "Address comments",
    // Handle both error shapes:
    // - ErrorResponse: { error: string, message: string } (validation errors)
    // - AddressCommentsResponse: { success: false, error: string } (logical failures)
    (errorData) => (errorData["message"] as string) || (errorData["error"] as string),
  );
  return {
    success: true,
    reviewCycle: data.reviewCycle,
    branch: data.branch,
  };
}

/**
 * Start a new feedback cycle from a restartable terminal state.
 */
export async function sendFollowUpApi(
  loopId: string,
  message: string,
  model?: { providerID: string; modelID: string },
  attachments?: MessageImageAttachment[],
): Promise<boolean> {
  return apiActionWithBody(
    `/api/loops/${loopId}/follow-up`,
    "POST",
    { message, model: model ? { ...model, variant: "" } : null, attachments: attachments ?? [] },
    "Send follow-up",
  );
}

export async function startAutomaticPrFlowApi(loopId: string): Promise<AutomaticPrFlowResult> {
  const data = await apiCall<{ automaticPrFlow: AutomaticPrFlowResult["automaticPrFlow"] }>(
    `/api/loops/${loopId}/automatic-pr-flow/start`,
    { method: "POST" },
    "Start automatic PR flow",
  );
  return {
    success: true,
    automaticPrFlow: data.automaticPrFlow,
  };
}

export async function stopAutomaticPrFlowApi(loopId: string): Promise<AutomaticPrFlowResult> {
  const data = await apiCall<{ automaticPrFlow: AutomaticPrFlowResult["automaticPrFlow"] }>(
    `/api/loops/${loopId}/automatic-pr-flow/stop`,
    { method: "POST" },
    "Stop automatic PR flow",
  );
  return {
    success: true,
    automaticPrFlow: data.automaticPrFlow,
  };
}

export async function enablePullRequestAutoMergeApi(loopId: string): Promise<PullRequestAutoMergeResult> {
  const data = await apiCall<{ pullRequest: PullRequestAutoMergeResult["pullRequest"] }>(
    `/api/loops/${loopId}/pull-request/auto-merge`,
    { method: "POST" },
    "Enable pull request auto-merge",
  );
  return {
    success: true,
    pullRequest: data.pullRequest,
  };
}
