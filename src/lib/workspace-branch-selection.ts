import type { BranchInfo } from "@/contracts";

function getWorkspaceBranchNames(
  branches: BranchInfo[],
  currentBranch: string,
  defaultBranch: string,
): Set<string> {
  return new Set([
    ...branches.map((branch) => branch.name),
    currentBranch,
    defaultBranch,
  ].map((branch) => branch.trim()).filter(Boolean));
}

export function isWorkspaceBranchSelectionValid(
  selectedBranch: string,
  branches: BranchInfo[],
  currentBranch: string,
  defaultBranch: string,
): boolean {
  const normalizedBranch = selectedBranch.trim();
  return normalizedBranch === ""
    || getWorkspaceBranchNames(branches, currentBranch, defaultBranch).has(normalizedBranch);
}

export function resolveWorkspaceBranchSelection(
  selectedBranch: string,
  branches: BranchInfo[],
  currentBranch: string,
  defaultBranch: string,
): string {
  const normalizedBranch = selectedBranch.trim();
  const branchNames = getWorkspaceBranchNames(branches, currentBranch, defaultBranch);
  if (normalizedBranch && branchNames.has(normalizedBranch)) {
    return normalizedBranch;
  }
  return defaultBranch.trim() || currentBranch.trim();
}
