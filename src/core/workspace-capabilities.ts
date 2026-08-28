import type { Workspace } from "@/shared/workspace";
import { DomainError } from "./domain-error";

export const WORKSPACE_GIT_REQUIRED_CODE = "workspace_git_required" as const;

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
