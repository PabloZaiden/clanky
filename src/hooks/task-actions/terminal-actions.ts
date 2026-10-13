/**
 * Terminal session actions for tasks.
 */

import type { CreateTaskTerminalSessionRequest } from "@/contracts";
import type { TerminalSession } from "@/shared";
import { apiCall } from "./helpers";

/**
 * Fetch a task's linked terminal session via the API.
 */
export async function getTaskTerminalSessionApi(taskId: string): Promise<TerminalSession> {
  return apiCall<TerminalSession>(
    `/api/tasks/${taskId}/terminal-session`,
    { method: "GET" },
    "Fetch task terminal session",
  );
}

/**
 * Get or create a task's linked terminal session via the API.
 */
export async function getOrCreateTaskTerminalSessionApi(
  taskId: string,
  request?: CreateTaskTerminalSessionRequest,
): Promise<TerminalSession> {
  return apiCall<TerminalSession>(
    `/api/tasks/${taskId}/terminal-session`,
    {
      method: "POST",
      ...(request ? { body: JSON.stringify(request) } : {}),
    },
    "Connect task terminal session",
  );
}
