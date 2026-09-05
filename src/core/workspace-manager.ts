/**
 * Core workspace operations.
 *
 * This service owns workspace validation, persistence coordination, and
 * connection lifecycle side effects. API modules should only adapt its
 * domain results to HTTP responses.
 */

import {
  createWorkspace as createWorkspaceRecord,
  getWorkspace as getWorkspaceRecord,
  listWorkspaces as listWorkspaceRecords,
  touchWorkspace as touchWorkspaceRecord,
  updateWorkspace as updateWorkspaceRecord,
} from "../persistence/workspaces";
import { areServerSettingsEqual, getDefaultServerSettings, type ServerSettings } from "@/shared/settings";
import {
  executionHostRefsEqual,
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

const log = createLogger("core:workspace-manager");

export interface CreateWorkspaceInput {
  name: string;
  directory: string;
  workspaceType?: WorkspaceType;
  serverSettings?: ServerSettings;
  executionHost: ExecutionHostRef;
  archived?: boolean;
  isPrivate?: boolean;
  allowClankyContext?: boolean;
}

export type UpdateWorkspaceInput = Partial<
  Pick<Workspace, "name" | "serverSettings" | "executionTargetRevision" | "executionHostBinding" | "isPrivate" | "archived" | "allowClankyContext" | "devcontainerSubpath">
> & { executionHost?: ExecutionHostRef };

export type WorkspaceDirectoryValidation = Awaited<
  ReturnType<typeof backendManager.validateRemoteDirectory>
>;

function normalizeCreateInput(input: CreateWorkspaceInput): Required<
  Pick<CreateWorkspaceInput, "name" | "directory" | "workspaceType" | "serverSettings" | "allowClankyContext">
> & Pick<CreateWorkspaceInput, "executionHost" | "archived" | "isPrivate"> {
  return {
    name: input.name.trim(),
    directory: input.directory.trim(),
    workspaceType: input.workspaceType ?? DEFAULT_WORKSPACE_TYPE,
    serverSettings: input.serverSettings ?? getDefaultServerSettings(),
    executionHost: input.executionHost,
    archived: input.archived,
    isPrivate: input.isPrivate,
    allowClankyContext: input.allowClankyContext === true,
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
  input: Required<Pick<CreateWorkspaceInput, "name" | "directory" | "workspaceType" | "serverSettings" | "allowClankyContext">>
    & Pick<CreateWorkspaceInput, "executionHost">
    & Pick<CreateWorkspaceInput, "archived" | "isPrivate">,
  executionHostBinding: Workspace["executionHostBinding"],
): Workspace {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: input.name,
    directory: input.directory,
    workspaceType: input.workspaceType,
    executionTargetRevision: 1,
    executionHostBinding,
    serverSettings: input.serverSettings,
    createdAt: now,
    updatedAt: now,
    ...(input.archived !== undefined ? { archived: input.archived } : { archived: false }),
    ...(input.isPrivate !== undefined ? { isPrivate: input.isPrivate } : {}),
    allowClankyContext: input.allowClankyContext,
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
    executionHost: ExecutionHostRef,
    directory: string,
  ): Promise<WorkspaceDirectoryValidation> {
    return await backendManager.validateRemoteDirectory(
      serverSettings,
      directory,
      executionHost,
    );
  }

  async listExecutionTargets(): Promise<ExecutionHostDescriptor[]> {
    return await executionHostService.listHosts();
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    const normalized = normalizeCreateInput(input);
    log.debug("Creating workspace", {
      name: normalized.name,
      directory: normalized.directory,
      provider: normalized.serverSettings.agent.provider,
      transport: normalized.executionHost.kind,
    });

    const validation = await this.validateRemoteDirectory(
      normalized.serverSettings,
      normalized.executionHost,
      normalized.directory,
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

    const workspace = createWorkspaceRecordFromInput(
      normalized,
      executionHostService.getBinding(normalized.executionHost),
    );
    await createWorkspaceRecord(workspace);
    log.info("Workspace created", {
      workspaceId: workspace.id,
      name: workspace.name,
      directory: workspace.directory,
    });
    return workspace;
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
    const serverSettingsChanged = updates.serverSettings !== undefined
      && !areServerSettingsEqual(current.serverSettings, updates.serverSettings);
    const nextExecutionHost = updates.executionHost ?? current.executionHostBinding.host;
    const executionTargetChanged = !executionHostRefsEqual(
      current.executionHostBinding.host,
      nextExecutionHost,
    );
    const privateChanged = updates.isPrivate !== undefined
      && updates.isPrivate !== (current.isPrivate === true);
    const archivedChanged = updates.archived !== undefined
      && updates.archived !== (current.archived === true);
    const allowClankyContextChanged = updates.allowClankyContext !== undefined
      && updates.allowClankyContext !== (current.allowClankyContext === true);

    const devcontainerSubpathChanged = updates.devcontainerSubpath !== undefined
      && updates.devcontainerSubpath !== current.devcontainerSubpath;

    if (!nameChanged && !serverSettingsChanged && !executionTargetChanged && !privateChanged && !archivedChanged && !allowClankyContextChanged && !devcontainerSubpathChanged) {
      return current;
    }

    if (executionTargetChanged) {
      const terminalCount = await countTerminalSessionsByWorkspace(id);
      if (terminalCount > 0) {
        throw new DomainError(
          "workspace_execution_target_in_use",
          "Delete existing workspace terminals before changing the execution target.",
          { details: { workspaceId: id, terminalCount } },
        );
      }
    }

    const normalizedUpdates: UpdateWorkspaceInput = {};
    if (nameChanged) {
      normalizedUpdates.name = updates.name;
    }
    if (serverSettingsChanged) {
      normalizedUpdates.serverSettings = updates.serverSettings;
    }
    if (executionTargetChanged) {
      normalizedUpdates.executionTargetRevision = current.executionTargetRevision + 1;
    }
    if (executionTargetChanged) {
      normalizedUpdates.executionHostBinding = executionHostService.getBinding(nextExecutionHost);
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

    const workspace = await updateWorkspaceRecord(id, normalizedUpdates);
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
    executionHost: ExecutionHostRef,
  ): Promise<Awaited<ReturnType<typeof backendManager.testConnection>>> {
    try {
      return await backendManager.testConnection(serverSettings, directory, executionHost);
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
}

export const workspaceManager = new WorkspaceManager();
