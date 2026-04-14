/**
 * Plan-related loop actions: feedback, accept, and discard.
 */

import type { SshSession, PlanAcceptResponse } from "../../types";
import type { MessageImageAttachment } from "../../types/message-attachments";
import { apiCall, apiAction, apiActionWithBody } from "./helpers";

/**
 * Result of accepting a plan.
 */
export type AcceptPlanResult =
  | {
      success: true;
      mode: "start_loop";
    }
  | {
      success: true;
      mode: "open_ssh";
      sshSession: SshSession;
    }
  | {
      success: false;
    };

/**
 * Send feedback to refine a plan via the API.
 */
export async function sendPlanFeedbackApi(
  loopId: string,
  feedback: string,
  attachments?: MessageImageAttachment[],
): Promise<boolean> {
  return apiActionWithBody(
    `/api/loops/${loopId}/plan/feedback`,
    "POST",
    { feedback, attachments: attachments ?? [] },
    "Send plan feedback",
  );
}

/**
 * Accept a plan and start the loop execution via the API.
 */
export async function acceptPlanApi(
  loopId: string,
  mode: "start_loop" | "open_ssh" = "start_loop",
): Promise<AcceptPlanResult> {
  const data = await apiCall<PlanAcceptResponse>(
    `/api/loops/${loopId}/plan/accept`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    },
    "Accept plan",
  );
  if (data.mode === "open_ssh") {
    return {
      success: true,
      mode: data.mode,
      sshSession: data.sshSession,
    };
  }
  return {
    success: true,
    mode: data.mode,
  };
}

/**
 * Discard a plan and delete the loop via the API.
 */
export async function discardPlanApi(loopId: string): Promise<boolean> {
  return apiAction(`/api/loops/${loopId}/plan/discard`, "POST", "Discard plan");
}
