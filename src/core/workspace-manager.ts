/**
 * Core workspace operations.
 *
 * This service owns workspace validation, persistence coordination, and
 * connection lifecycle side effects. API modules should only adapt its
 * domain results to HTTP responses.
 */

import {
  createWorkspace as createWorkspaceRecord,
  deleteWorkspace as deleteWorkspaceRecord,
  getWorkspace as getWorkspaceRecord,
  listWorkspaces as listWorkspaceRecords,
  touchWorkspace as touchWorkspaceRecord,
  updateWorkspace as updateWorkspaceRecord,
} from "../persistence/workspaces";
import { areServerSettingsEqual, getDefaultServerSettings, type ServerSettings } from "@/shared/settings";
import {
  executionHostBindingsEqual,
  type ExecutionHostDescriptor,
  type ExecutionHostRef,
  type Workspace,
  type WorkspaceType,
} from "@/shared";
import { DEFAULT_WORKSPACE_TYPE } from "@/shared/workspace";
import { backendManager } from "./backend-manager";
import { DomainError } from "./domain-error";
import {
  deleteWorkspaceWithOptions,
  type DeleteWorkspaceOptions,
  type DeleteWorkspaceResult,
} from "./workspace-deletion";
import { createLogger } from "@pablozaiden/webapp/server";
import { countTerminalSessionsByWorkspace } from "../persistence/terminal-sessions";
import { withWorkspaceExecutionLock } from "./workspace-execution-lock";
import { executionHostService } from "./execution-host-service";
import {
  captureWorkspaceSshTargetState,
  ensureWorkspaceSshTarget,
  prepareWorkspaceSshTarget,
  removeWorkspaceSshTarget,
  restoreWorkspaceSshTargetState,
  type WorkspaceSshTargetInput,
} from "../persistence/workspace-execution-targets";

const log = createLogger("core:workspace-manager");

export interface CreateWorkspaceInput {
  name: string;
  directory: string;
  workspaceType?: WorkspaceType;
  serverSettings?: ServerSettings;
  executionHost?: ExecutionHostRef;
  sshTarget?: WorkspaceSshTargetInput;
  provisioningHost?: ExecutionHostRef;
  skipValidation?: boolean;
  archived?: boolean;
  isPrivate?: boolean;
  allowClankyContext?: boolean;
  sourceDirectory?: string;
  repoUrl?: string;
  basePath?: string;
  devcontainerSubpath?: string;
}

export type UpdateWorkspaceInput = Partial<
  Pick<Workspace, "name" | "directory" | "serverSettings" | "executionTargetRevision" | "executionHostBinding" | "isPrivate" | "archived" | "allowClankyContext" | "devcontainerSubpath">
> & {
  executionHost?: ExecutionHostRef;
  sshTarget?: WorkspaceSshTargetInput | null;
  allowExecutionTargetChangeWithTerminals?: boolean;
};

export type WorkspaceDirectoryValidation = Awaited<
  ReturnType<typeof backendManager.validateRemoteDirectory>
>;

interface NormalizedCreateWorkspaceInput {
  name: string;
  directory: string;
  workspaceType: WorkspaceType;
  serverSettings: ServerSettings;
  executionHost?: ExecutionHostRef;
  sshTarget?: WorkspaceSshTargetInput;
  provisioningHost?: ExecutionHostRef;
  skipValidation: boolean;
  archived?: boolean;
  isPrivate?: boolean;
  allowClankyContext: boolean;
  sourceDirectory?: string;
  repoUrl?: string;
  basePath?: string;
  devcontainerSubpath?: string;
}

function normalizeCreateInput(input: CreateWorkspaceInput): NormalizedCreateWorkspaceInput {
  return {
    name: input.name.trim(),
    directory: input.directory.trim(),
    workspaceType: input.workspaceType ?? DEFAULT_WORKSPACE_TYPE,
    serverSettings: input.serverSettings ?? getDefaultServerSettings(),
    executionHost: input.executionHost,
    sshTarget: input.sshTarget,
    provisioningHost: input.provisioningHost,
    skipValidation: input.skipValidation === true,
    archived: input.archived,
    isPrivate: input.isPrivate,
    allowClankyContext: input.allowClankyContext === true,
    sourceDirectory: input.sourceDirectory,
    repoUrl: input.repoUrl,
    basePath: input.basePath,
    devcontainerSubpath: input.devcontainerSubpath,
  };
}

function getValidationFailure(
  validation: WorkspaceDirectoryValidation,
  workspaceType: WorkspaceType,
): { code: "validation_failed" | "directory_not_found" | "not_git_repo"; message: string } | null {
  if (!validation.success) {
    return {
      code: "validation_failed",
      message: `Failed to validate directory: ${validation.error ?? "Unknown validation error"}`,
    };
  }

  if (validation.directoryExists === false) {
    return {
      code: "directory_not_found",
      message: "Directory does not exist on the remote server",
    };
  }

  if (workspaceType === "git" && !validation.isGitRepo) {
    return {
      code: "not_git_repo",
      message: "Directory must be a git repository",
    };
  }

  return null;
}

function createWorkspaceRecordFromInput(
  input: NormalizedCreateWorkspaceInput,
  workspaceId: string,
  executionHostBinding: Workspace["executionHostBinding"],
  provisioningHostBinding?: Workspace["provisioningHostBinding"],
  sshTarget?: Workspace["sshTarget"],
): Workspace {
  const now = new Date().toISOString();
  return {
    id: workspaceId,
    name: input.name,
    directory: input.directory,
    workspaceType: input.workspaceType,
    executionTargetRevision: 1,
    executionHostBinding,
    ...(provisioningHostBinding ? { provisioningHostBinding } : {}),
    ...(sshTarget ? { sshTarget } : {}),
    serverSettings: input.serverSettings,
    createdAt: now,
    updatedAt: now,
    ...(input.archived !== undefined ? { archived: input.archived } : { archived: false }),
    ...(input.isPrivate !== undefined ? { isPrivate: input.isPrivate } : {}),
    allowClankyContext: input.allowClankyContext,
    ...(input.sourceDirectory ? { sourceDirectory: input.sourceDirectory } : {}),
    ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}),
    ...(input.basePath ? { basePath: input.basePath } : {}),
    ...(input.devcontainerSubpath ? { devcontainerSubpath: input.devcontainerSubpath } : {}),
  };
}

export class WorkspaceManager {
  async getWorkspace(id: string): Promise<Workspace | null> {
    return await getWorkspaceRecord(id);
  }

  async requireWorkspace(id: string): Promise<Workspace> {
    const workspace = await this.getWorkspace(id);
    if (!workspace) {
      throw new DomainError("workspace_not_found", "Workspace not found", {
        details: { workspaceId: id },
      });
    }
    return workspace;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return await listWorkspaceRecords();
  }

  async validateRemoteDirectory(
    serverSettings: ServerSettings,
    executionHost: ExecutionHostRef | undefined,
    directory: string,
    sshTarget?: WorkspaceSshTargetInput,
  ): Promise<WorkspaceDirectoryValidation> {
    return await backendManager.validateRemoteDirectory(
      serverSettings,
      directory,
      executionHost,
      sshTarget,
    );
  }

  async listExecutionTargets(): Promise<ExecutionHostDescriptor[]> {
    return await executionHostService.listHosts();
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    const normalized = normalizeCreateInput(input);
    if (!normalized.executionHost && !normalized.sshTarget) {
      throw new DomainError(
        "execution_target_required",
        "A registered execution host or an ad hoc SSH target is required.",
      );
    }
    if (normalized.executionHost && normalized.sshTarget) {
      throw new DomainError(
        "execution_target_ambiguous",
        "Choose either a registered execution host or an ad hoc SSH target.",
      );
    }
    log.debug("Creating workspace", {
      name: normalized.name,
      directory: normalized.directory,
      provider: normalized.serverSettings.agent.provider,
      transport: normalized.sshTarget ? "ssh" : normalized.executionHost?.kind,
    });

    const validation = normalized.skipValidation
      ? { success: true, directoryExists: true, isGitRepo: true }
      : await this.validateRemoteDirectory(
        normalized.serverSettings,
        normalized.executionHost,
        normalized.directory,
        normalized.sshTarget,
      );
    const failure = getValidationFailure(validation, normalized.workspaceType);
    if (failure) {
      throw new DomainError(failure.code, failure.message, {
        details: {
          directory: normalized.directory,
          validation,
        },
      });
    }

    const workspaceId = crypto.randomUUID();
    let executionHostBinding: Workspace["executionHostBinding"];
    let sshTarget: Workspace["sshTarget"];
    let provisioningHostBinding: Workspace["provisioningHostBinding"];
    let workspaceCreated = false;
    try {
      if (normalized.sshTarget) {
        const target = prepareWorkspaceSshTarget(workspaceId, normalized.sshTarget);
        executionHostBinding = target.binding;
        sshTarget = {
          kind: target.target.kind,
          host: target.target.host,
          port: target.target.port,
          username: target.target.username,
          credentialConfigured: target.target.credentialConfigured,
          targetKey: target.target.targetKey,
          revision: target.target.revision,
        };
      } else {
        executionHostBinding = executionHostService.getBinding(normalized.executionHost!);
      }
      if (normalized.provisioningHost) {
        provisioningHostBinding = executionHostService.getBinding(normalized.provisioningHost);
      }
      const workspace = createWorkspaceRecordFromInput(
        normalized,
        workspaceId,
        executionHostBinding,
        provisioningHostBinding,
        sshTarget,
      );
      await createWorkspaceRecord(workspace);
      workspaceCreated = true;
      if (normalized.sshTarget) {
        await ensureWorkspaceSshTarget(workspaceId, normalized.sshTarget);
      }
      log.info("Workspace created", {
        workspaceId: workspace.id,
        name: workspace.name,
        directory: workspace.directory,
      });
      return workspace;
    } catch (error) {
      if (workspaceCreated) {
        await deleteWorkspaceRecord(workspaceId);
      }
      if (normalized.sshTarget) {
        await removeWorkspaceSshTarget(workspaceId);
      }
      throw error;
    }
  }

  async updateWorkspace(
    id: string,
    updates: UpdateWorkspaceInput,
  ): Promise<Workspace | null> {
    return await withWorkspaceExecutionLock(id, async () => {
      return await this.updateWorkspaceUnlocked(id, updates);
    });
  }

  private async updateWorkspaceUnlocked(
    id: string,
    updates: UpdateWorkspaceInput,
  ): Promise<Workspace | null> {
    const current = await this.getWorkspace(id);
    if (!current) {
      return null;
    }

    const nameChanged = updates.name !== undefined && updates.name !== current.name;
    const directoryChanged = updates.directory !== undefined && updates.directory !== current.directory;
    const serverSettingsChanged = updates.serverSettings !== undefined
      && !areServerSettingsEqual(current.serverSettings, updates.serverSettings);
    if (updates.executionHost !== undefined && updates.sshTarget !== undefined) {
      throw new DomainError(
        "execution_target_ambiguous",
        "Choose either a registered execution host or an ad hoc SSH target.",
      );
    }
    const targetSelectionChanged = updates.executionHost !== undefined
      || updates.sshTarget !== undefined;
    if (targetSelectionChanged) {
      const terminalCount = await countTerminalSessionsByWorkspace(id);
      if (terminalCount > 0 && updates.allowExecutionTargetChangeWithTerminals !== true) {
        throw new DomainError(
          "workspace_execution_target_in_use",
          "Delete existing workspace terminals before changing the execution target.",
          { details: { workspaceId: id, terminalCount } },
        );
      }
    }
    const previousSshTargetState = updates.sshTarget !== undefined && updates.sshTarget !== null
      ? captureWorkspaceSshTargetState(id)
      : undefined;
    let sshTargetMutationStarted = false;
    let executionTargetChanged = false;
    let nextExecutionHostBinding = current.executionHostBinding;
    let nextSshTarget = current.sshTarget;
    let removeSshTarget = false;
    let workspace: Workspace | null;
    try {
      if (updates.sshTarget !== undefined) {
        if (updates.sshTarget === null) {
          if (!updates.executionHost) {
            throw new DomainError(
              "execution_target_required",
              "A registered execution host is required when clearing the SSH target.",
            );
          }
          nextExecutionHostBinding = executionHostService.getBinding(updates.executionHost);
          nextSshTarget = undefined;
          removeSshTarget = true;
        } else {
          sshTargetMutationStarted = true;
          const target = await ensureWorkspaceSshTarget(id, updates.sshTarget);
          nextExecutionHostBinding = target.binding;
          nextSshTarget = {
            kind: target.target.kind,
            host: target.target.host,
            port: target.target.port,
            username: target.target.username,
            credentialConfigured: target.target.credentialConfigured,
            targetKey: target.target.targetKey,
            revision: target.target.revision,
          };
        }
      } else if (updates.executionHost !== undefined) {
        nextExecutionHostBinding = executionHostService.getBinding(updates.executionHost);
        nextSshTarget = undefined;
        removeSshTarget = current.sshTarget !== undefined;
      }
      const sshTargetChanged = updates.sshTarget !== undefined
        && (
          current.sshTarget?.host !== nextSshTarget?.host
          || current.sshTarget?.port !== nextSshTarget?.port
          || current.sshTarget?.username !== nextSshTarget?.username
          || current.sshTarget?.credentialConfigured !== nextSshTarget?.credentialConfigured
          || current.sshTarget?.targetKey !== nextSshTarget?.targetKey
          || current.sshTarget?.revision !== nextSshTarget?.revision
        );
      executionTargetChanged = sshTargetChanged || !executionHostBindingsEqual(
        current.executionHostBinding,
        nextExecutionHostBinding,
      );
      const privateChanged = updates.isPrivate !== undefined
        && updates.isPrivate !== (current.isPrivate === true);
      const archivedChanged = updates.archived !== undefined
        && updates.archived !== (current.archived === true);
      const allowClankyContextChanged = updates.allowClankyContext !== undefined
        && updates.allowClankyContext !== (current.allowClankyContext === true);

      const devcontainerSubpathChanged = updates.devcontainerSubpath !== undefined
        && updates.devcontainerSubpath !== current.devcontainerSubpath;

      if (!nameChanged && !directoryChanged && !serverSettingsChanged && !executionTargetChanged && !privateChanged && !archivedChanged && !allowClankyContextChanged && !devcontainerSubpathChanged) {
        return current;
      }

      const normalizedUpdates: UpdateWorkspaceInput = {};
      if (nameChanged) {
        normalizedUpdates.name = updates.name;
      }
      if (directoryChanged) {
        normalizedUpdates.directory = updates.directory;
      }
      if (serverSettingsChanged) {
        normalizedUpdates.serverSettings = updates.serverSettings;
      }
      if (executionTargetChanged) {
        normalizedUpdates.executionTargetRevision = current.executionTargetRevision + 1;
      }
      if (executionTargetChanged) {
        normalizedUpdates.executionHostBinding = nextExecutionHostBinding;
      }
      if (privateChanged) {
        normalizedUpdates.isPrivate = updates.isPrivate;
      }
      if (archivedChanged) {
        normalizedUpdates.archived = updates.archived;
      }
      if (allowClankyContextChanged) {
        normalizedUpdates.allowClankyContext = updates.allowClankyContext;
      }
      if (devcontainerSubpathChanged) {
        normalizedUpdates.devcontainerSubpath = updates.devcontainerSubpath;
      }

      workspace = await updateWorkspaceRecord(id, normalizedUpdates);
      if (!workspace) {
        if (previousSshTargetState && sshTargetMutationStarted) {
          restoreWorkspaceSshTargetState(id, previousSshTargetState);
        }
        return workspace;
      }
      if (removeSshTarget) {
        await removeWorkspaceSshTarget(id);
      }
    } catch (error) {
      if (previousSshTargetState && sshTargetMutationStarted) {
        try {
          restoreWorkspaceSshTargetState(id, previousSshTargetState);
        } catch (rollbackError) {
          log.error("Failed to restore workspace SSH target after update failure", {
            workspaceId: id,
            error: String(rollbackError),
            originalError: String(error),
          });
          throw new Error("Workspace SSH target update failed and rollback failed", {
            cause: error,
          });
        }
      }
      throw error;
    }

    if (workspace && (serverSettingsChanged || executionTargetChanged)) {
      await backendManager.resetWorkspaceConnection(id);
    }
    return workspace;
  }

  async updateServerSettings(
    id: string,
    serverSettings: ServerSettings,
    executionHost?: ExecutionHostRef,
  ): Promise<Workspace | null> {
    return await this.updateWorkspace(id, { serverSettings, executionHost });
  }

  async touchWorkspace(id: string): Promise<void> {
    await touchWorkspaceRecord(id);
  }

  async deleteWorkspace(
    id: string,
    options: DeleteWorkspaceOptions = {},
  ): Promise<DeleteWorkspaceResult> {
    const result = await deleteWorkspaceWithOptions(id, options);
    if (result.success) {
      await backendManager.resetWorkspaceConnection(id);
    }
    return result;
  }

  async getWorkspaceStatus(
    id: string,
  ): Promise<Awaited<ReturnType<typeof backendManager.getWorkspaceStatus>>> {
    await this.requireWorkspace(id);
    return await backendManager.getWorkspaceStatus(id);
  }

  async testConnection(
    serverSettings: ServerSettings,
    directory: string,
    executionHost?: ExecutionHostRef,
    sshTarget?: WorkspaceSshTargetInput,
  ): Promise<Awaited<ReturnType<typeof backendManager.testConnection>>> {
    try {
      return await backendManager.testConnection(
        serverSettings,
        directory,
        executionHost,
        sshTarget,
      );
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
}

export const workspaceManager = new WorkspaceManager();
