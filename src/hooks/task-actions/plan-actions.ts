/**
 * Plan-related task actions: feedback, accept, and discard.
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
      mode: "start_task";
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
  taskId: string,
  feedback: string,
  attachments?: MessageImageAttachment[],
): Promise<boolean> {
  return apiActionWithBody(
    `/api/tasks/${taskId}/plan/feedback`,
    "POST",
    { feedback, attachments: attachments ?? [] },
    "Send plan feedback",
  );
}

/**
 * Accept a plan and start the task execution via the API.
 */
export async function acceptPlanApi(
  taskId: string,
  mode: "start_task" | "open_ssh" = "start_task",
): Promise<AcceptPlanResult> {
  const data = await apiCall<PlanAcceptResponse>(
    `/api/tasks/${taskId}/plan/accept`,
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
 * Discard a plan and delete the task via the API.
 */
export async function discardPlanApi(taskId: string): Promise<boolean> {
  return apiAction(`/api/tasks/${taskId}/plan/discard`, "POST", "Discard plan");
}
