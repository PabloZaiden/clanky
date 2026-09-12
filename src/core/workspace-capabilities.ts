import type { Workspace } from "@/shared/workspace";
import { DomainError } from "./domain-error";

export const WORKSPACE_GIT_REQUIRED_CODE = "workspace_git_required" as const;
export const WORKSPACE_WORKTREES_DISABLED_CODE = "workspace_worktrees_disabled" as const;

export function isGitBackedWorkspace(
  workspace: Pick<Workspace, "workspaceType">,
): boolean {
  return workspace.workspaceType === "git";
}

export function assertGitBackedWorkspace(
  workspace: Pick<Workspace, "id" | "workspaceType">,
  message = "This operation requires a Git-backed workspace.",
): void {
  if (isGitBackedWorkspace(workspace)) {
    return;
  }

  throw new DomainError(WORKSPACE_GIT_REQUIRED_CODE, message, {
    details: { workspaceId: workspace.id },
  });
}

export function assertWorktreesAllowed(
  workspace: Pick<Workspace, "id" | "workspaceType" | "allowWorktrees">,
  message = "Worktrees are disabled for this workspace.",
): void {
  if (workspace.allowWorktrees !== false) {
    return;
  }

  throw new DomainError(WORKSPACE_WORKTREES_DISABLED_CODE, message, {
    details: { workspaceId: workspace.id },
  });
}
