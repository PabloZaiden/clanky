import { posix as pathPosix } from "node:path";
import { deleteWorkspace as deleteWorkspaceRecord, getWorkspace, countWorkspaceLoops } from "../persistence/workspaces";
import type { Workspace } from "../types/workspace";
import { sshCredentialManager } from "./ssh-credential-manager";
import { sshServerManager } from "./ssh-server-manager";
import { createLogger } from "./logger";

const log = createLogger("core:workspace-deletion");

export interface DeleteWorkspaceOptions {
  deleteServerDirectory?: boolean;
  credentialToken?: string | null;
}

export interface DeleteWorkspaceResult {
  success: boolean;
  reason?: string;
}

export function isAutoProvisionedWorkspace(workspace: Workspace): boolean {
  const sourceDirectory = workspace.sourceDirectory?.trim();
  const basePath = workspace.basePath?.trim();
  return Boolean(
    sourceDirectory
      && workspace.sshServerId?.trim()
      && basePath
      && isSafeProvisionedDirectory(sourceDirectory, basePath),
  );
}

function isSafeProvisionedDirectory(sourceDirectory: string, basePath: string): boolean {
  if (!sourceDirectory.startsWith("/") || !basePath.startsWith("/")) {
    return false;
  }
  if (sourceDirectory.split("/").includes("..") || basePath.split("/").includes("..")) {
    return false;
  }
  const normalizedSource = pathPosix.normalize(sourceDirectory);
  const normalizedBase = pathPosix.normalize(basePath);
  if (normalizedSource === "/" || normalizedBase === "/" || normalizedSource === normalizedBase) {
    return false;
  }
  if (!normalizedSource.startsWith(`${normalizedBase}/`)) {
    return false;
  }
  return normalizedSource.split("/").filter(Boolean).length >= 2;
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
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return { success: false, reason: "Workspace not found" };
  }

  const loopCount = await countWorkspaceLoops(id);
  if (loopCount > 0) {
    return {
      success: false,
      reason: `Workspace has ${loopCount} loop(s). Delete all loops first.`,
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
}
