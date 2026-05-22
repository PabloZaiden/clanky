/**
 * Task lifecycle actions: stop, discard, delete, purge, generate title.
 */

import type { GenerateTaskTitleRequest, GenerateTaskTitleResponse } from "../../types";
import { apiCall, apiAction } from "./helpers";

export interface PurgeArchivedTasksResult {
  success: boolean;
  workspaceId: string;
  totalArchived: number;
  purgedCount: number;
  purgedTaskIds: string[];
  failures: Array<{ taskId: string; error: string }>;
}

export interface PurgeTerminalTasksResult {
  success: boolean;
  totalWorkspaces: number;
  totalArchived: number;
  purgedCount: number;
  purgedTaskIds: string[];
  failures: Array<{ workspaceId: string; taskId: string; error: string }>;
  workspaces: Array<{
    workspaceId: string;
    totalArchived: number;
    purgedCount: number;
    purgedTaskIds: string[];
    failures: Array<{ taskId: string; error: string }>;
  }>;
}

/**
 * Stop an active task without deleting it.
 */
export async function stopTaskApi(taskId: string): Promise<boolean> {
  return apiAction(`/api/tasks/${taskId}/stop`, "POST", "Stop task");
}

/**
 * Generate a task title from a prompt via the API.
 */
export async function generateTaskTitleApi(request: GenerateTaskTitleRequest): Promise<string> {
  const data = await apiCall<GenerateTaskTitleResponse>(
    "/api/tasks/title",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
    "Generate task title",
    (errorData) => (errorData["message"] as string | undefined) ?? (errorData["error"] as string | undefined),
  );
  return data.title;
}

/**
 * Discard a task's changes via the API.
 */
export async function discardTaskApi(taskId: string): Promise<boolean> {
  return apiAction(`/api/tasks/${taskId}/discard`, "POST", "Discard task");
}

/**
 * Delete a task via the API.
 */
export async function deleteTaskApi(taskId: string): Promise<boolean> {
  return apiAction(`/api/tasks/${taskId}`, "DELETE", "Delete task");
}

/**
 * Purge a task (permanently delete) via the API.
 */
export async function purgeTaskApi(taskId: string): Promise<boolean> {
  return apiAction(`/api/tasks/${taskId}/purge`, "POST", "Purge task");
}

/**
 * Promote a stopped or failed task into completed status via the API.
 */
export async function manualCompleteTaskApi(taskId: string): Promise<boolean> {
  return apiAction(`/api/tasks/${taskId}/manual-complete`, "POST", "Manually complete task");
}

/**
 * Purge all archived tasks for a workspace via the API.
 */
export async function purgeArchivedWorkspaceTasksApi(workspaceId: string): Promise<PurgeArchivedTasksResult> {
  const data = await apiCall<{
    workspaceId: string;
    totalArchived: number;
    purgedCount: number;
    purgedTaskIds: string[];
    failures: Array<{ taskId: string; error: string }>;
  }>(
    `/api/workspaces/${workspaceId}/archived-tasks/purge`,
    { method: "POST" },
    "Purge archived tasks",
  );
  return {
    success: true,
    workspaceId: data.workspaceId,
    totalArchived: data.totalArchived,
    purgedCount: data.purgedCount,
    purgedTaskIds: data.purgedTaskIds,
    failures: data.failures,
  };
}

/**
 * Purge all archived tasks across every workspace via the API.
 */
export async function purgeTerminalTasksApi(): Promise<PurgeTerminalTasksResult> {
  const data = await apiCall<Omit<PurgeTerminalTasksResult, "success">>(
    "/api/settings/purge-terminal-tasks",
    { method: "POST" },
    "Purge terminal-state tasks",
  );
  return {
    ...data,
    success: true,
  };
}
