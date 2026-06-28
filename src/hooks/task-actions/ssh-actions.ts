/**
 * SSH session actions for tasks.
 */

import type { SshSession } from "../../types";
import { apiCall } from "./helpers";

/**
 * Fetch a task's linked SSH session via the API.
 */
export async function getTaskSshSessionApi(taskId: string): Promise<SshSession> {
  return apiCall<SshSession>(
    `/api/tasks/${taskId}/ssh-session`,
    { method: "GET" },
    "Fetch task SSH session",
  );
}

/**
 * Get or create a task's linked SSH session via the API.
 */
export async function getOrCreateTaskSshSessionApi(taskId: string): Promise<SshSession> {
  return apiCall<SshSession>(
    `/api/tasks/${taskId}/ssh-session`,
    { method: "POST" },
    "Connect task SSH session",
  );
}
