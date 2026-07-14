/**
 * Pending prompt and pending value actions for tasks.
 */

import type { MessageImageAttachment } from "@/shared/message-attachments";
import { apiCall, apiAction, apiActionWithBody } from "./helpers";

/**
 * Result of setting pending values.
 */
export interface SetPendingResult {
  success: boolean;
}

/**
 * Set a pending prompt for a task via the API.
 */
export async function setPendingPromptApi(
  taskId: string,
  prompt: string,
  attachments?: MessageImageAttachment[],
): Promise<boolean> {
  return apiActionWithBody(
    `/api/tasks/${taskId}/pending-prompt`,
    "PUT",
    { prompt, attachments: attachments ?? [] },
    "Set pending prompt",
  );
}

/**
 * Clear the pending prompt for a task via the API.
 */
export async function clearPendingPromptApi(taskId: string): Promise<boolean> {
  return apiAction(`/api/tasks/${taskId}/pending-prompt`, "DELETE", "Clear pending prompt");
}

/**
 * Set pending message and/or model for a task via the API.
 * Queueing is unsupported; the API now requires the interrupt-first path.
 */
export async function setPendingApi(
  taskId: string,
  options: { message?: string; model?: { providerID: string; modelID: string }; attachments?: MessageImageAttachment[] },
): Promise<SetPendingResult> {
  await apiCall(
    `/api/tasks/${taskId}/pending`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: options.message ?? null,
          model: options.model ? { ...options.model, variant: "" } : null,
          immediate: true,
          attachments: options.attachments ?? [],
        }),
    },
    "Set pending values",
  );
  return { success: true };
}

/**
 * Clear all pending values (message and model) for a task via the API.
 */
export async function clearPendingApi(taskId: string): Promise<boolean> {
  return apiAction(`/api/tasks/${taskId}/pending`, "DELETE", "Clear pending values");
}
