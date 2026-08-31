/**
 * Terminal session actions for tasks.
 */

import type { WorkspaceTerminalSession } from "@/shared";
import { apiCall } from "./helpers";

/**
 * Fetch a task's linked terminal session via the API.
 */
export async function getTaskTerminalSessionApi(taskId: string): Promise<WorkspaceTerminalSession> {
  return apiCall<WorkspaceTerminalSession>(
    `/api/tasks/${taskId}/terminal-session`,
    { method: "GET" },
    "Fetch task terminal session",
  );
}

/**
 * Get or create a task's linked terminal session via the API.
 */
export async function getOrCreateTaskTerminalSessionApi(taskId: string): Promise<WorkspaceTerminalSession> {
  return apiCall<WorkspaceTerminalSession>(
    `/api/tasks/${taskId}/terminal-session`,
    { method: "POST" },
    "Connect task terminal session",
  );
}
