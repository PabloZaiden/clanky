import { deleteWorkspace as deleteWorkspaceRecord, getWorkspace, countWorkspaceTasks } from "../persistence/workspaces";
import type { Workspace } from "@/shared/workspace";
import { sshCredentialManager } from "./ssh-credential-manager";
import { executionHostService } from "./execution-host-service";
import { DomainError } from "./domain-error";
import { createLogger } from "@pablozaiden/webapp/server";
import { isAutoProvisionedWorkspace, isSafeProvisionedDirectory } from "../lib/workspace-deletion-safety";
import { managedCredentialService } from "./managed-credential-service";
import { terminalSessionManager } from "./terminal-session-manager";
import { withWorkspaceExecutionLock } from "./workspace-execution-lock";

const log = createLogger("core:workspace-deletion");
const workspaceDeletionLocks = new Set<string>();

export interface DeleteWorkspaceOptions {
  deleteServerDirectory?: boolean;
  credentialToken?: string | null;
}

export type WorkspaceDeletionErrorCode =
  | "workspace_deletion_in_progress"
  | "workspace_not_found"
  | "workspace_has_tasks"
  | "workspace_not_auto_provisioned"
  | "workspace_delete_failed";

export type DeleteWorkspaceResult =
  | { success: true }
  | {
      success: false;
      error: DomainError<WorkspaceDeletionErrorCode>;
    };

export { isAutoProvisionedWorkspace, isSafeProvisionedDirectory };

export function isWorkspaceDeletionInProgress(workspaceId: string): boolean {
  return workspaceDeletionLocks.has(workspaceId);
}

function deletionFailure(
  code: WorkspaceDeletionErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): DeleteWorkspaceResult {
  return {
    success: false,
    error: new DomainError(code, message, { details }),
  };
}

async function deleteProvisionedServerDirectory(workspace: Workspace, credentialToken?: string | null): Promise<void> {
  const sourceDirectory = workspace.sourceDirectory?.trim();
  const basePath = workspace.basePath?.trim();
  await executionHostService.listHosts();
  const binding = workspace.executionHostBinding;
  if (!sourceDirectory || !basePath || !isSafeProvisionedDirectory(sourceDirectory, basePath)) {
    throw new DomainError(
      "workspace_delete_metadata_invalid",
      "Workspace is missing safe auto-provisioned directory metadata",
      { details: { workspaceId: workspace.id } },
    );
  }

  const token = credentialToken?.trim();
  const password = binding.host.kind === "ssh" && token
    ? sshCredentialManager.getPasswordForToken(binding.host.serverId, token)
    : undefined;
  const executor = await executionHostService.getCommandExecutor(binding, {
    operationId: `workspace-delete:${workspace.id}`,
    directory: sourceDirectory,
    provider: workspace.serverSettings.agent.provider,
    sshPassword: password,
  });
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
    throw new DomainError(
      "workspace_delete_remote_failed",
      "Failed to delete the auto-provisioned workspace directory",
      {
        details: {
          workspaceId: workspace.id,
          exitCode: result.exitCode,
        },
      },
    );
  }
}

export async function deleteWorkspaceWithOptions(
  id: string,
  options: DeleteWorkspaceOptions = {},
): Promise<DeleteWorkspaceResult> {
  return await withWorkspaceExecutionLock(
    id,
    async () => await deleteWorkspaceWithOptionsUnlocked(id, options),
  );
}

async function deleteWorkspaceWithOptionsUnlocked(
  id: string,
  options: DeleteWorkspaceOptions,
): Promise<DeleteWorkspaceResult> {
  if (workspaceDeletionLocks.has(id)) {
    return deletionFailure(
      "workspace_deletion_in_progress",
      "Workspace deletion is already in progress",
      { workspaceId: id },
    );
  }

  const workspace = await getWorkspace(id);
  if (!workspace) {
    return deletionFailure("workspace_not_found", "Workspace not found", {
      workspaceId: id,
    });
  }

  const taskCount = await countWorkspaceTasks(id);
  if (taskCount > 0) {
    return deletionFailure(
      "workspace_has_tasks",
      `Workspace has ${taskCount} task(s). Delete all tasks first.`,
      { workspaceId: id, taskCount },
    );
  }

  workspaceDeletionLocks.add(id);
  try {
    if ((await countWorkspaceTasks(id)) > 0) {
      return deletionFailure(
        "workspace_has_tasks",
        "Workspace has task(s). Delete all tasks first.",
        { workspaceId: id },
      );
    }

    if (options.deleteServerDirectory) {
      if (!isAutoProvisionedWorkspace(workspace)) {
        return deletionFailure(
          "workspace_not_auto_provisioned",
          "Workspace is not an auto-provisioned workspace with a safe server directory",
          { workspaceId: id },
        );
      }
      await deleteProvisionedServerDirectory(workspace, options.credentialToken);
    }

    await terminalSessionManager.deleteSessionsForWorkspace(id, { lockAlreadyHeld: true });
    await managedCredentialService.revokeWorkspace(id);
    const deleted = await deleteWorkspaceRecord(id);
    if (deleted) {
      return { success: true };
    }

    const latestWorkspace = await getWorkspace(id);
    if (!latestWorkspace) {
      return deletionFailure("workspace_not_found", "Workspace not found", {
        workspaceId: id,
      });
    }

    const remainingTaskCount = await countWorkspaceTasks(id);
    if (remainingTaskCount > 0) {
      return deletionFailure(
        "workspace_has_tasks",
        "Workspace has task(s). Delete all tasks first.",
        { workspaceId: id, taskCount: remainingTaskCount },
      );
    }

    return deletionFailure(
      "workspace_delete_failed",
      "Failed to delete workspace",
      { workspaceId: id },
    );
  } finally {
    workspaceDeletionLocks.delete(id);
  }
}
