import { deleteWorkspace as deleteWorkspaceRecord, getWorkspace, countWorkspaceTasks } from "../persistence/workspaces";
import type { Workspace } from "@/shared/workspace";
import { sshCredentialManager } from "./ssh-credential-manager";
import { sshServerManager } from "./ssh-server-manager";
import { createLogger } from "./logger";
import { isAutoProvisionedWorkspace, isSafeProvisionedDirectory } from "../lib/workspace-deletion-safety";

const log = createLogger("core:workspace-deletion");
const workspaceDeletionLocks = new Set<string>();

export interface DeleteWorkspaceOptions {
  deleteServerDirectory?: boolean;
  credentialToken?: string | null;
}

export interface DeleteWorkspaceResult {
  success: boolean;
  reason?: string;
}

export { isAutoProvisionedWorkspace, isSafeProvisionedDirectory };

export function isWorkspaceDeletionInProgress(workspaceId: string): boolean {
  return workspaceDeletionLocks.has(workspaceId);
}

async function deleteProvisionedServerDirectory(workspace: Workspace, credentialToken?: string | null): Promise<void> {
  const sourceDirectory = workspace.sourceDirectory?.trim();
  const basePath = workspace.basePath?.trim();
  const sshServerId = workspace.sshServerId?.trim();
  if (!sourceDirectory || !basePath || !sshServerId || !isSafeProvisionedDirectory(sourceDirectory, basePath)) {
    throw new Error("Workspace is missing safe auto-provisioned directory metadata");
  }

  const token = credentialToken?.trim();
  const password = token ? sshCredentialManager.getPasswordForToken(sshServerId, token) : undefined;
  const { executor } = await sshServerManager.getCommandExecutor(sshServerId, password);
  if (!(await executor.directoryExists(sourceDirectory))) {
    log.info("Provisioned workspace source directory is already absent", {
      workspaceId: workspace.id,
      sourceDirectory,
    });
    return;
  }

  const result = await executor.exec("rm", ["-rf", "--", sourceDirectory], {
    cwd: "/",
    logFailures: false,
  });
  if (!result.success) {
    const detail = result.stderr.trim() || result.stdout.trim() || "Command failed";
    throw new Error(`Failed to delete server directory ${sourceDirectory}: ${detail}`);
  }
}

export async function deleteWorkspaceWithOptions(
  id: string,
  options: DeleteWorkspaceOptions = {},
): Promise<DeleteWorkspaceResult> {
  if (workspaceDeletionLocks.has(id)) {
    return { success: false, reason: "Workspace deletion is already in progress" };
  }

  const workspace = await getWorkspace(id);
  if (!workspace) {
    return { success: false, reason: "Workspace not found" };
  }

  const taskCount = await countWorkspaceTasks(id);
  if (taskCount > 0) {
    return {
      success: false,
      reason: `Workspace has ${taskCount} task(s). Delete all tasks first.`,
    };
  }

  workspaceDeletionLocks.add(id);
  try {
    if ((await countWorkspaceTasks(id)) > 0) {
      return {
        success: false,
        reason: "Workspace has task(s). Delete all tasks first.",
      };
    }

    if (options.deleteServerDirectory) {
      if (!isAutoProvisionedWorkspace(workspace)) {
        return {
          success: false,
          reason: "Workspace is not an auto-provisioned workspace with a safe server directory",
        };
      }
      await deleteProvisionedServerDirectory(workspace, options.credentialToken);
    }

    return await deleteWorkspaceRecord(id);
  } finally {
    workspaceDeletionLocks.delete(id);
  }
}
