/**
 * Pending prompt and pending value actions for loops.
 */

import type { MessageImageAttachment } from "../../types/message-attachments";
import { apiCall, apiAction, apiActionWithBody } from "./helpers";

/**
 * Result of setting pending values.
 */
export interface SetPendingResult {
  success: boolean;
}

/**
 * Set a pending prompt for a loop via the API.
 */
export async function setPendingPromptApi(
  loopId: string,
  prompt: string,
  attachments?: MessageImageAttachment[],
): Promise<boolean> {
  return apiActionWithBody(
    `/api/loops/${loopId}/pending-prompt`,
    "PUT",
    { prompt, attachments },
    "Set pending prompt",
  );
}

/**
 * Clear the pending prompt for a loop via the API.
 */
export async function clearPendingPromptApi(loopId: string): Promise<boolean> {
  return apiAction(`/api/loops/${loopId}/pending-prompt`, "DELETE", "Clear pending prompt");
}

/**
 * Set pending message and/or model for a loop via the API.
 * Queueing is unsupported; the API now requires the interrupt-first path.
 */
export async function setPendingApi(
  loopId: string,
  options: { message?: string; model?: { providerID: string; modelID: string }; attachments?: MessageImageAttachment[] },
): Promise<SetPendingResult> {
  await apiCall(
    `/api/loops/${loopId}/pending`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    },
    "Set pending values",
  );
  return { success: true };
}

/**
 * Clear all pending values (message and model) for a loop via the API.
 */
export async function clearPendingApi(loopId: string): Promise<boolean> {
  return apiAction(`/api/loops/${loopId}/pending`, "DELETE", "Clear pending values");
}
