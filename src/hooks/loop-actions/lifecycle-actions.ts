/**
 * Loop lifecycle actions: stop, discard, delete, purge, generate title.
 */

import type { GenerateLoopTitleRequest, GenerateLoopTitleResponse } from "../../types";
import { apiCall, apiAction } from "./helpers";

export interface PurgeArchivedLoopsResult {
  success: boolean;
  workspaceId: string;
  totalArchived: number;
  purgedCount: number;
  purgedLoopIds: string[];
  failures: Array<{ loopId: string; error: string }>;
}

/**
 * Stop an active loop without deleting it.
 */
export async function stopLoopApi(loopId: string): Promise<boolean> {
  return apiAction(`/api/loops/${loopId}/stop`, "POST", "Stop loop");
}

/**
 * Generate a loop title from a prompt via the API.
 */
export async function generateLoopTitleApi(request: GenerateLoopTitleRequest): Promise<string> {
  const data = await apiCall<GenerateLoopTitleResponse>(
    "/api/loops/title",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
    "Generate loop title",
    (errorData) => (errorData["message"] as string | undefined) ?? (errorData["error"] as string | undefined),
  );
  return data.title;
}

/**
 * Discard a loop's changes via the API.
 */
export async function discardLoopApi(loopId: string): Promise<boolean> {
  return apiAction(`/api/loops/${loopId}/discard`, "POST", "Discard loop");
}

/**
 * Delete a loop via the API.
 */
export async function deleteLoopApi(loopId: string): Promise<boolean> {
  return apiAction(`/api/loops/${loopId}`, "DELETE", "Delete loop");
}

/**
 * Purge a loop (permanently delete) via the API.
 */
export async function purgeLoopApi(loopId: string): Promise<boolean> {
  return apiAction(`/api/loops/${loopId}/purge`, "POST", "Purge loop");
}

/**
 * Promote a stopped or failed loop into completed status via the API.
 */
export async function manualCompleteLoopApi(loopId: string): Promise<boolean> {
  return apiAction(`/api/loops/${loopId}/manual-complete`, "POST", "Manually complete loop");
}

/**
 * Purge all archived loops for a workspace via the API.
 */
export async function purgeArchivedWorkspaceLoopsApi(workspaceId: string): Promise<PurgeArchivedLoopsResult> {
  const data = await apiCall<{
    workspaceId: string;
    totalArchived: number;
    purgedCount: number;
    purgedLoopIds: string[];
    failures: Array<{ loopId: string; error: string }>;
  }>(
    `/api/workspaces/${workspaceId}/archived-loops/purge`,
    { method: "POST" },
    "Purge archived loops",
  );
  return {
    success: true,
    workspaceId: data.workspaceId,
    totalArchived: data.totalArchived,
    purgedCount: data.purgedCount,
    purgedLoopIds: data.purgedLoopIds,
    failures: data.failures,
  };
}
