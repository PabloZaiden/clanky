import { apiRequest } from "../lib/api-client";
import type { PublicWorkspace } from "@/shared";
import type { ModelInfo } from "@/contracts";

interface BranchesResponse {
  currentBranch?: string;
}

interface DefaultBranchResponse {
  defaultBranch?: string;
}

export async function fetchQuickChatModels(
  workspace: PublicWorkspace,
  options?: { signal?: AbortSignal },
): Promise<ModelInfo[]> {
  return await apiRequest<ModelInfo[]>(
    `/api/models?workspaceId=${encodeURIComponent(workspace.id)}`,
    {
      signal: options?.signal,
      action: "Load quick chat models",
      fallbackMessage: "Failed to load quick chat models",
    },
  );
}

export async function fetchQuickChatBaseBranch(workspace: PublicWorkspace): Promise<string> {
  const query = `workspaceId=${encodeURIComponent(workspace.id)}`;
  const [defaultBranchResult, branchesResult] = await Promise.allSettled([
    apiRequest<DefaultBranchResponse>(`/api/git/default-branch?${query}`, {
      action: "Load quick chat default branch",
      fallbackMessage: "Failed to load the default branch",
    }),
    apiRequest<BranchesResponse>(`/api/git/branches?${query}`, {
      action: "Load quick chat branches",
      fallbackMessage: "Failed to load branches",
    }),
  ]);

  const defaultBranch = defaultBranchResult.status === "fulfilled"
    ? defaultBranchResult.value.defaultBranch?.trim() ?? ""
    : "";
  const currentBranch = branchesResult.status === "fulfilled"
    ? branchesResult.value.currentBranch?.trim() ?? ""
    : "";
  const baseBranch = defaultBranch || currentBranch;

  if (!baseBranch) {
    throw new Error("Could not determine a base branch for quick chat");
  }

  return baseBranch;
}
