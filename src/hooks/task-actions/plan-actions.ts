/**
 * Plan-related task actions: feedback, accept, and discard.
 */

import type { PlanAcceptResponse } from "@/contracts";
import type { MessageAttachment } from "@/shared/message-attachments";
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
      success: false;
    };

/**
 * Send feedback to refine a plan via the API.
 */
export async function sendPlanFeedbackApi(
  taskId: string,
  feedback: string,
  attachments?: MessageAttachment[],
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
): Promise<AcceptPlanResult> {
  const data = await apiCall<PlanAcceptResponse>(
    `/api/tasks/${taskId}/plan/accept`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "start_task" }),
    },
    "Accept plan",
  );
  if (data.mode !== "start_task") {
    throw new Error(`Unexpected plan acceptance mode: ${data.mode}`);
  }
  return {
    success: true,
    mode: "start_task",
  };
}

/**
 * Discard a plan and delete the task via the API.
 */
export async function discardPlanApi(taskId: string): Promise<boolean> {
  return apiAction(`/api/tasks/${taskId}/plan/discard`, "POST", "Discard plan");
}
