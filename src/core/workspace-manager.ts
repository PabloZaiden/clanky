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
import type { Workspace } from "@/shared/workspace";
import { backendManager } from "./backend-manager";
import { DomainError } from "./domain-error";
import {
  deleteWorkspaceWithOptions,
  type DeleteWorkspaceOptions,
  type DeleteWorkspaceResult,
} from "./workspace-deletion";
import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("core:workspace-manager");

export interface CreateWorkspaceInput {
  name: string;
  directory: string;
  serverSettings?: ServerSettings;
  archived?: boolean;
  isPrivate?: boolean;
  allowClankyContext?: boolean;
}

export type UpdateWorkspaceInput = Partial<
  Pick<Workspace, "name" | "serverSettings" | "isPrivate" | "archived" | "allowClankyContext">
>;

export type WorkspaceDirectoryValidation = Awaited<
  ReturnType<typeof backendManager.validateRemoteDirectory>
>;

function normalizeCreateInput(input: CreateWorkspaceInput): Required<
  Pick<CreateWorkspaceInput, "name" | "directory" | "serverSettings" | "allowClankyContext">
> & Pick<CreateWorkspaceInput, "archived" | "isPrivate"> {
  return {
    name: input.name.trim(),
    directory: input.directory.trim(),
    serverSettings: input.serverSettings ?? getDefaultServerSettings(),
    archived: input.archived,
    isPrivate: input.isPrivate,
    allowClankyContext: input.allowClankyContext === true,
  };
}

function getValidationFailure(
  validation: WorkspaceDirectoryValidation,
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

  if (!validation.isGitRepo) {
    return {
      code: "not_git_repo",
      message: "Directory must be a git repository",
    };
  }

  return null;
}

function createWorkspaceRecordFromInput(
  input: Required<Pick<CreateWorkspaceInput, "name" | "directory" | "serverSettings" | "allowClankyContext">>
    & Pick<CreateWorkspaceInput, "archived" | "isPrivate">,
): Workspace {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: input.name,
    directory: input.directory,
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
    directory: string,
  ): Promise<WorkspaceDirectoryValidation> {
    return await backendManager.validateRemoteDirectory(serverSettings, directory);
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    const normalized = normalizeCreateInput(input);
    log.debug("Creating workspace", {
      name: normalized.name,
      directory: normalized.directory,
      provider: normalized.serverSettings.agent.provider,
      transport: normalized.serverSettings.agent.transport,
    });

    const validation = await this.validateRemoteDirectory(
      normalized.serverSettings,
      normalized.directory,
    );
    const failure = getValidationFailure(validation);
    if (failure) {
      throw new DomainError(failure.code, failure.message, {
        details: {
          directory: normalized.directory,
          validation,
        },
      });
    }

    const workspace = createWorkspaceRecordFromInput(normalized);
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
    const current = await this.getWorkspace(id);
    if (!current) {
      return null;
    }

    const nameChanged = updates.name !== undefined && updates.name !== current.name;
    const serverSettingsChanged = updates.serverSettings !== undefined
      && !areServerSettingsEqual(current.serverSettings, updates.serverSettings);
    const privateChanged = updates.isPrivate !== undefined
      && updates.isPrivate !== (current.isPrivate === true);
    const archivedChanged = updates.archived !== undefined
      && updates.archived !== (current.archived === true);
    const allowClankyContextChanged = updates.allowClankyContext !== undefined
      && updates.allowClankyContext !== (current.allowClankyContext === true);

    if (!nameChanged && !serverSettingsChanged && !privateChanged && !archivedChanged && !allowClankyContextChanged) {
      return current;
    }

    const normalizedUpdates: UpdateWorkspaceInput = {};
    if (nameChanged) {
      normalizedUpdates.name = updates.name;
    }
    if (serverSettingsChanged) {
      normalizedUpdates.serverSettings = updates.serverSettings;
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

    const workspace = await updateWorkspaceRecord(id, normalizedUpdates);
    if (workspace && serverSettingsChanged) {
      await backendManager.resetWorkspaceConnection(id);
    }
    return workspace;
  }

  async updateServerSettings(
    id: string,
    serverSettings: ServerSettings,
  ): Promise<Workspace | null> {
    return await this.updateWorkspace(id, { serverSettings });
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
  ): Promise<Awaited<ReturnType<typeof backendManager.testConnection>>> {
    return await backendManager.testConnection(serverSettings, directory);
  }
}

export const workspaceManager = new WorkspaceManager();
