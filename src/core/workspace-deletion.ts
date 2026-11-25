import { deleteWorkspace as deleteWorkspaceRecord, getWorkspace } from "../persistence/workspaces";
import { workspaceHasRepositoryGroups } from "../persistence/chats/crud";
import type { Workspace } from "@/shared/workspace";
import type { DeleteWorkspaceResponse } from "@/contracts/api";
import { executionHostService } from "./execution-host-service";
import { DomainError } from "../domain/domain-error";
import { createLogger } from "@pablozaiden/webapp/server";
import { isAutoProvisionedWorkspace, isSafeProvisionedDirectory } from "../lib/workspace-deletion-safety";
import { managedCredentialService } from "./managed-credential-service";
import { terminalSessionManager } from "./terminal-session-manager";
import { withWorkspaceExecutionLock, withWorkspaceRuntimeLock } from "./workspace-execution-lock";
import { executeWorkspaceEnvironmentOperation } from "./environments/workspace-operation";
import { closeCommandExecutor } from "./command-executor";
import { meshManager } from "./mesh-manager";
import { workspaceWorkerEnrollmentService } from "./workspace-worker-enrollment-service";
import { requireExecutionOwnerUserId } from "../context/user-context";
import { resourcePrivacyEventEmitter } from "./event-emitter";

const log = createLogger("core:workspace-deletion");
const workspaceDeletionLocks = new Set<string>();

export interface DeleteWorkspaceOptions {
  deleteServerDirectory?: boolean;
}

export type WorkspaceDeletionErrorCode =
  | "workspace_deletion_in_progress"
  | "workspace_not_found"
  | "workspace_not_auto_provisioned"
  | "workspace_environment_cleanup_failed"
  | "workspace_repository_cleanup_failed"
  | "workspace_repository_groups_in_use"
  | "workspace_delete_failed";

export type DeleteWorkspaceResult =
  | DeleteWorkspaceResponse
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

async function deleteProvisionedServerDirectory(workspace: Workspace): Promise<void> {
  const sourceDirectory = workspace.sourceDirectory?.trim();
  const basePath = workspace.basePath?.trim();
  const binding = workspace.provisioningHostBinding ?? workspace.executionHostBinding;
  if (!sourceDirectory || !basePath || !isSafeProvisionedDirectory(sourceDirectory, basePath)) {
    throw new DomainError(
      "workspace_delete_metadata_invalid",
      "Workspace is missing safe auto-provisioned directory metadata",
      { details: { workspaceId: workspace.id } },
    );
  }

  const executor = await executionHostService.getCommandExecutor(binding, {
    operationId: `workspace-delete:${workspace.id}`,
    directory: sourceDirectory,
    provider: workspace.serverSettings.agent.provider,
  });
  try {
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
  } finally { closeCommandExecutor(executor); }
}

export async function deleteWorkspaceWithOptions(
  id: string,
  options: DeleteWorkspaceOptions = {},
): Promise<DeleteWorkspaceResult> {
  return await withWorkspaceRuntimeLock(id, async () => await withWorkspaceExecutionLock(
    id,
    async () => await deleteWorkspaceWithOptionsUnlocked(id, options),
  ));
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

  workspaceDeletionLocks.add(id);
  try {
    if (options.deleteServerDirectory && !isAutoProvisionedWorkspace(workspace)) {
      return deletionFailure(
        "workspace_not_auto_provisioned",
        "Workspace is not an auto-provisioned workspace with a safe server directory",
        { workspaceId: id },
      );
    }

    if (workspace.workspaceType === "multi-git" && workspaceHasRepositoryGroups(id, false)) {
      return deletionFailure(
        "workspace_repository_groups_in_use",
        "Remove existing chats and automation runs before deleting this workspace.",
        { workspaceId: id },
      );
    }

    const { previewSessionManager } = await import("./preview-session-manager");
    await previewSessionManager.closeWorkspacePreviews(id);
    const { chatManager } = await import("./chat-manager");
    const trash = await chatManager.emptyTrash({
      workspaceId: id,
      bestEffort: true,
    });
    if (workspace.workspaceType === "multi-git" && trash.failedCount > 0) {
      return deletionFailure(
        "workspace_repository_cleanup_failed",
        "The workspace was kept because one or more chat directories could not be removed.",
        { workspaceId: id },
      );
    }

    await terminalSessionManager.deleteSessionsForWorkspace(id, { lockAlreadyHeld: true });
    await managedCredentialService.revokeWorkspace(id);
    const { removeWorkspaceSshKeyAccess } = await import("./ssh-key-access-service");
    await removeWorkspaceSshKeyAccess(requireExecutionOwnerUserId(), id);
    const dedicatedWorker = workspaceWorkerEnrollmentService.getByWorkspace(
      requireExecutionOwnerUserId(),
      id,
    );
    if (dedicatedWorker) {
      await meshManager.cleanupDedicatedWorker(
        requireExecutionOwnerUserId(),
        dedicatedWorker.enrollment.id,
        { preserveRegistration: true },
      );
    }
    if (isAutoProvisionedWorkspace(workspace)) {
      try {
        await executeWorkspaceEnvironmentOperation(workspace, requireExecutionOwnerUserId(), "remove");
      } catch (error) {
        log.error("Managed environment cleanup failed; retaining workspace for retry", {
          workspaceId: id,
          error: String(error),
          ...(error instanceof DomainError ? { details: error.details } : {}),
        });
        return deletionFailure(
          "workspace_environment_cleanup_failed",
          "The workspace container could not be removed. The workspace and source directory were kept; check the provisioning host and retry deletion.",
          { workspaceId: id },
        );
      }
    }

    const warnings: string[] = [];
    if (options.deleteServerDirectory) {
      try {
        await deleteProvisionedServerDirectory(workspace);
      } catch (error) {
        log.warn("Provisioned workspace directory cleanup failed; continuing workspace deletion", {
          workspaceId: id,
          sourceDirectory: workspace.sourceDirectory,
          error: String(error),
        });
        warnings.push(`The server directory could not be removed. Clean it up manually: ${workspace.sourceDirectory}`);
      }
    }
    const deleted = await deleteWorkspaceRecord(id);
    if (deleted) {
      resourcePrivacyEventEmitter.emit({ type: "resource.privacy_changed" });
      if (dedicatedWorker?.enrollment.workerNodeId) {
        try {
          await meshManager.removeDedicatedWorker(
            requireExecutionOwnerUserId(),
            dedicatedWorker.enrollment.workerNodeId,
          );
        } catch (error) {
          log.warn("Failed to remove dedicated worker after workspace deletion", {
            workspaceId: id,
            workerNodeId: dedicatedWorker.enrollment.workerNodeId,
            error: String(error),
          });
          warnings.push("The workspace was deleted, but its dedicated worker registration could not be removed. Remove it manually.");
        }
      }
      return warnings.length > 0 ? { success: true, warnings } : { success: true };
    }

    const latestWorkspace = await getWorkspace(id);
    if (!latestWorkspace) {
      return deletionFailure("workspace_not_found", "Workspace not found", {
        workspaceId: id,
      });
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
