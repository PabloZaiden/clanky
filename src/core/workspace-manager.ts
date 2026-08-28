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
import type { Workspace, WorkspaceExecutionTarget } from "@/shared/workspace";
import { backendManager } from "./backend-manager";
import { DomainError } from "./domain-error";
import {
  deleteWorkspaceWithOptions,
  type DeleteWorkspaceOptions,
  type DeleteWorkspaceResult,
} from "./workspace-deletion";
import { createLogger } from "@pablozaiden/webapp/server";
import { ensureLocalMeshNodeIdentity } from "../persistence/mesh-node-identity";
import {
  getMeshLinkForLocalUser,
  getMeshNode,
  listMeshLinkMembers,
} from "../persistence/mesh";
import { requireCurrentUserId } from "./user-context";

const log = createLogger("core:workspace-manager");

export interface CreateWorkspaceInput {
  name: string;
  directory: string;
  serverSettings?: ServerSettings;
  executionNodeId?: string | null;
  archived?: boolean;
  isPrivate?: boolean;
  allowClankyContext?: boolean;
}

export type UpdateWorkspaceInput = Partial<
  Pick<Workspace, "name" | "serverSettings" | "executionNodeId" | "isPrivate" | "archived" | "allowClankyContext">
>;

export type WorkspaceDirectoryValidation = Awaited<
  ReturnType<typeof backendManager.validateRemoteDirectory>
>;

function normalizeCreateInput(input: CreateWorkspaceInput): Required<
  Pick<CreateWorkspaceInput, "name" | "directory" | "serverSettings" | "allowClankyContext">
> & Pick<CreateWorkspaceInput, "executionNodeId" | "archived" | "isPrivate"> {
  return {
    name: input.name.trim(),
    directory: input.directory.trim(),
    serverSettings: input.serverSettings ?? getDefaultServerSettings(),
    executionNodeId: input.executionNodeId,
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
    & Pick<CreateWorkspaceInput, "executionNodeId">
    & Pick<CreateWorkspaceInput, "archived" | "isPrivate">,
): Workspace {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: input.name,
    directory: input.directory,
    executionNodeId: null,
    serverSettings: input.serverSettings,
    createdAt: now,
    updatedAt: now,
    ...(input.archived !== undefined ? { archived: input.archived } : { archived: false }),
    ...(input.isPrivate !== undefined ? { isPrivate: input.isPrivate } : {}),
    allowClankyContext: input.allowClankyContext,
  };
}

export class WorkspaceManager {
  private async resolveExecutionNodeId(
    serverSettings: ServerSettings,
    executionNodeId?: string | null,
  ): Promise<string | null> {
    if (serverSettings.agent.transport !== "stdio") {
      return null;
    }
    const identity = await ensureLocalMeshNodeIdentity();
    const targetNodeId = executionNodeId ?? identity.nodeId;
    if (targetNodeId === identity.nodeId) {
      return targetNodeId;
    }
    const link = await getMeshLinkForLocalUser(requireCurrentUserId());
    const member = link
      ? (await listMeshLinkMembers(link.linkId)).find((candidate) => candidate.nodeId === targetNodeId)
      : undefined;
    const node = await getMeshNode(targetNodeId);
    if (
      !link
      || link.status !== "active"
      || !member
      || member.status === "pending"
      || member.status === "revoked"
      || !node
      || node.status === "pending"
      || node.status === "revoked"
    ) {
      throw new DomainError(
        "workspace_execution_target_not_trusted",
        "The selected stdio execution target is not a trusted mesh peer.",
        { details: { executionNodeId: targetNodeId } },
      );
    }
    return targetNodeId;
  }

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
    executionNodeId?: string | null,
  ): Promise<WorkspaceDirectoryValidation> {
    const targetNodeId = await this.resolveExecutionNodeId(serverSettings, executionNodeId);
    return await backendManager.validateRemoteDirectory(serverSettings, directory, targetNodeId);
  }

  async listExecutionTargets(): Promise<WorkspaceExecutionTarget[]> {
    const identity = await ensureLocalMeshNodeIdentity();
    const targets: WorkspaceExecutionTarget[] = [{
      nodeId: identity.nodeId,
      name: identity.instanceName?.trim() || "This Clanky instance",
      kind: "local",
      availability: "local",
    }];
    const link = await getMeshLinkForLocalUser(requireCurrentUserId());
    if (!link || link.status !== "active") {
      return targets;
    }

    for (const member of await listMeshLinkMembers(link.linkId)) {
      if (
        member.nodeId === identity.nodeId
        || member.status === "pending"
        || member.status === "revoked"
      ) {
        continue;
      }
      const node = await getMeshNode(member.nodeId);
      targets.push({
        nodeId: member.nodeId,
        name: node?.instanceName?.trim() || member.instanceName?.trim() || `Mesh peer ${member.nodeId.slice(0, 8)}`,
        kind: "mesh",
        availability: member.status === "active" && node?.status === "active"
          ? "online"
          : "offline",
      });
    }
    return targets;
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    const normalized = normalizeCreateInput(input);
    const executionNodeId = await this.resolveExecutionNodeId(
      normalized.serverSettings,
      normalized.executionNodeId,
    );
    log.debug("Creating workspace", {
      name: normalized.name,
      directory: normalized.directory,
      provider: normalized.serverSettings.agent.provider,
      transport: normalized.serverSettings.agent.transport,
    });

    const validation = await this.validateRemoteDirectory(
      normalized.serverSettings,
      normalized.directory,
      executionNodeId,
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
    workspace.executionNodeId = executionNodeId;
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
    const nextSettings = updates.serverSettings ?? current.serverSettings;
    const requestedExecutionNodeId = nextSettings.agent.transport === "stdio"
      ? updates.executionNodeId
      : null;
    const executionTargetChanged = updates.executionNodeId !== undefined
      && requestedExecutionNodeId !== current.executionNodeId;
    const privateChanged = updates.isPrivate !== undefined
      && updates.isPrivate !== (current.isPrivate === true);
    const archivedChanged = updates.archived !== undefined
      && updates.archived !== (current.archived === true);
    const allowClankyContextChanged = updates.allowClankyContext !== undefined
      && updates.allowClankyContext !== (current.allowClankyContext === true);

    if (!nameChanged && !serverSettingsChanged && !executionTargetChanged && !privateChanged && !archivedChanged && !allowClankyContextChanged) {
      return current;
    }

    const normalizedUpdates: UpdateWorkspaceInput = {};
    if (nameChanged) {
      normalizedUpdates.name = updates.name;
    }
    if (serverSettingsChanged) {
      normalizedUpdates.serverSettings = updates.serverSettings;
    }
    if (serverSettingsChanged || executionTargetChanged) {
      normalizedUpdates.executionNodeId = await this.resolveExecutionNodeId(
        nextSettings,
        updates.executionNodeId ?? current.executionNodeId,
      );
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
    if (workspace && (serverSettingsChanged || executionTargetChanged)) {
      await backendManager.resetWorkspaceConnection(id);
    }
    return workspace;
  }

  async updateServerSettings(
    id: string,
    serverSettings: ServerSettings,
    executionNodeId?: string | null,
  ): Promise<Workspace | null> {
    return await this.updateWorkspace(id, { serverSettings, executionNodeId });
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
    executionNodeId?: string | null,
  ): Promise<Awaited<ReturnType<typeof backendManager.testConnection>>> {
    try {
      const targetNodeId = await this.resolveExecutionNodeId(serverSettings, executionNodeId);
      return await backendManager.testConnection(serverSettings, directory, targetNodeId);
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
}

export const workspaceManager = new WorkspaceManager();
