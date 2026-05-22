/**
 * Git-related task actions: accept local, push, update-branch, mark-merged.
 */

import { apiCall, apiAction } from "./helpers";

/**
 * Result of an accept task action.
 */
export interface AcceptTaskResult {
  success: boolean;
}

/**
 * Result of a push task action.
 */
export interface PushTaskResult {
  success: boolean;
  remoteBranch?: string;
  /** Sync status with base branch */
  syncStatus?: "already_up_to_date" | "clean" | "conflicts_being_resolved";
}

/**
 * Accept a task's committed changes locally via the API.
 */
export async function acceptTaskApi(taskId: string): Promise<AcceptTaskResult> {
  await apiCall<{ success: true }>(
    `/api/tasks/${taskId}/accept`,
    { method: "POST" },
    "Accept task",
  );
  return { success: true };
}

/**
 * Push a task's branch to remote via the API.
 */
export async function pushTaskApi(taskId: string): Promise<PushTaskResult> {
  const data = await apiCall<{ remoteBranch?: string; syncStatus?: string }>(
    `/api/tasks/${taskId}/push`,
    { method: "POST" },
    "Push task",
  );
  return {
    success: true,
    remoteBranch: data.remoteBranch,
    syncStatus: data.syncStatus as PushTaskResult["syncStatus"],
  };
}

/**
 * Update a pushed task's branch by syncing with the base branch and re-pushing.
 */
export async function updateBranchApi(taskId: string): Promise<PushTaskResult> {
  const data = await apiCall<{ remoteBranch?: string; syncStatus?: string }>(
    `/api/tasks/${taskId}/update-branch`,
    { method: "POST" },
    "Update branch",
  );
  return {
    success: true,
    remoteBranch: data.remoteBranch,
    syncStatus: data.syncStatus as PushTaskResult["syncStatus"],
  };
}

/**
 * Mark a task as merged and sync with remote via the API.
 *
 * This is useful when a task's branch was merged externally (e.g., via GitHub PR)
 * and the user wants to preserve the task as merged instead of treating it
 * like a deleted task.
 */
export async function markMergedApi(taskId: string): Promise<boolean> {
  return apiAction(`/api/tasks/${taskId}/mark-merged`, "POST", "Mark task as merged");
}

/**
 * Close a locally accepted task without performing PR or git operations.
 */
export async function closeLocalTaskApi(taskId: string): Promise<boolean> {
  return apiAction(`/api/tasks/${taskId}/close-local`, "POST", "Close local task");
}
