/**
 * SSH session and port-forward actions for tasks.
 */

import type { SshSession, PortForward } from "../../types";
import { apiCall, apiAction } from "./helpers";

export interface CreatePortForwardRequest {
  remotePort: number;
}

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

/**
 * List a task's forwarded ports via the API.
 */
export async function listTaskPortForwardsApi(taskId: string): Promise<PortForward[]> {
  return apiCall<PortForward[]>(
    `/api/tasks/${taskId}/port-forwards`,
    { method: "GET" },
    "List task port forwards",
  );
}

/**
 * Create a task port forward via the API.
 */
export async function createTaskPortForwardApi(
  taskId: string,
  request: CreatePortForwardRequest,
): Promise<PortForward> {
  return apiCall<PortForward>(
    `/api/tasks/${taskId}/port-forwards`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
    "Create task port forward",
  );
}

/**
 * Delete a task port forward via the API.
 */
export async function deleteTaskPortForwardApi(taskId: string, forwardId: string): Promise<boolean> {
  return apiAction(
    `/api/tasks/${taskId}/port-forwards/${forwardId}`,
    "DELETE",
    "Delete task port forward",
  );
}
