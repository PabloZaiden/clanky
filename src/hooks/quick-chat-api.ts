import { appFetch } from "../lib/public-path";
import type { ModelInfo, PublicWorkspace } from "../types";

interface BranchesResponse {
  currentBranch?: string;
}

interface DefaultBranchResponse {
  defaultBranch?: string;
}

async function parseQuickChatFetchError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

export async function fetchQuickChatModels(
  workspace: PublicWorkspace,
  options?: { signal?: AbortSignal },
): Promise<ModelInfo[]> {
  const response = await appFetch(
    `/api/models?workspaceId=${encodeURIComponent(workspace.id)}`,
    { signal: options?.signal },
  );
  if (!response.ok) {
    throw new Error(await parseQuickChatFetchError(response, "Failed to load quick chat models"));
  }
  return await response.json() as ModelInfo[];
}

export async function fetchQuickChatBaseBranch(workspace: PublicWorkspace): Promise<string> {
  const query = `workspaceId=${encodeURIComponent(workspace.id)}`;
  const [defaultBranchResponse, branchesResponse] = await Promise.all([
    appFetch(`/api/git/default-branch?${query}`),
    appFetch(`/api/git/branches?${query}`),
  ]);

  const defaultBranch = defaultBranchResponse.ok
    ? ((await defaultBranchResponse.json()) as DefaultBranchResponse).defaultBranch?.trim() ?? ""
    : "";
  const currentBranch = branchesResponse.ok
    ? ((await branchesResponse.json()) as BranchesResponse).currentBranch?.trim() ?? ""
    : "";
  const baseBranch = defaultBranch || currentBranch;

  if (!baseBranch) {
    throw new Error("Could not determine a base branch for quick chat");
  }

  return baseBranch;
}
