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
import { DEFAULT_WORKSPACE_TYPE, type Workspace, type WorkspaceExecutionTarget, type WorkspaceType } from "@/shared/workspace";
import { backendManager } from "./backend-manager";
import { DomainError } from "./domain-error";
import {
  deleteWorkspaceWithOptions,
  type DeleteWorkspaceOptions,
  type DeleteWorkspaceResult,
} from "./workspace-deletion";
import { createLogger } from "@pablozaiden/webapp/server";
import { countTerminalSessionsByWorkspace } from "../persistence/terminal-sessions";
import { resolveWorkspaceExecutionTarget } from "./workspace-execution-target";
import { ensureLocalMeshNodeIdentity } from "../persistence/mesh-node-identity";
import {
  getMeshLinkForLocalUser,
  getMeshNode,
  listMeshLinkMembers,
} from "../persistence/mesh";
import { requireCurrentUserId } from "./user-context";
import { withWorkspaceExecutionLock } from "./workspace-execution-lock";

const log = createLogger("core:workspace-manager");

export interface CreateWorkspaceInput {
  name: string;
  directory: string;
  workspaceType?: WorkspaceType;
  serverSettings?: ServerSettings;
  executionNodeId?: string | null;
  archived?: boolean;
  isPrivate?: boolean;
  allowClankyContext?: boolean;
}

export type UpdateWorkspaceInput = Partial<
  Pick<Workspace, "name" | "serverSettings" | "executionNodeId" | "executionTargetRevision" | "isPrivate" | "archived" | "allowClankyContext" | "devcontainerSubpath">
>;

export type WorkspaceDirectoryValidation = Awaited<
  ReturnType<typeof backendManager.validateRemoteDirectory>
>;

function normalizeCreateInput(input: CreateWorkspaceInput): Required<
  Pick<CreateWorkspaceInput, "name" | "directory" | "workspaceType" | "serverSettings" | "allowClankyContext">
> & Pick<CreateWorkspaceInput, "executionNodeId" | "archived" | "isPrivate"> {
  return {
    name: input.name.trim(),
    directory: input.directory.trim(),
    workspaceType: input.workspaceType ?? DEFAULT_WORKSPACE_TYPE,
    serverSettings: input.serverSettings ?? getDefaultServerSettings(),
    executionNodeId: input.executionNodeId,
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
    & Pick<CreateWorkspaceInput, "executionNodeId">
    & Pick<CreateWorkspaceInput, "archived" | "isPrivate">,
): Workspace {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: input.name,
    directory: input.directory,
    workspaceType: input.workspaceType,
    executionNodeId: null,
    executionTargetRevision: 1,
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
    const target = await resolveWorkspaceExecutionTarget(
      { serverSettings, executionNodeId },
    );
    if (target.kind === "ssh") {
      return null;
    }
    return target.kind === "mesh" ? target.nodeId : target.executionNodeId;
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
    const failure = getValidationFailure(validation, normalized.workspaceType);
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
    const nextSettings = updates.serverSettings ?? current.serverSettings;
    const requestedExecutionNodeId = nextSettings.agent.transport === "stdio"
      ? updates.executionNodeId ?? (
        current.serverSettings.agent.transport === "stdio"
          ? current.executionNodeId
          : null
      )
      : null;
    const currentTarget = await resolveWorkspaceExecutionTarget(
      current,
      { validateMeshTarget: false },
    );
    const nextTarget = await resolveWorkspaceExecutionTarget(
      { serverSettings: nextSettings, executionNodeId: requestedExecutionNodeId },
      { validateMeshTarget: false },
    );
    const executionTargetChanged = currentTarget.targetKey !== nextTarget.targetKey;
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

    const resolvedNextTarget = serverSettingsChanged || updates.executionNodeId !== undefined
      ? await resolveWorkspaceExecutionTarget({
        serverSettings: nextSettings,
        executionNodeId: requestedExecutionNodeId,
      })
      : nextTarget;
    const normalizedUpdates: UpdateWorkspaceInput = {};
    if (nameChanged) {
      normalizedUpdates.name = updates.name;
    }
    if (serverSettingsChanged) {
      normalizedUpdates.serverSettings = updates.serverSettings;
    }
    if (serverSettingsChanged || updates.executionNodeId !== undefined) {
      normalizedUpdates.executionNodeId = resolvedNextTarget.kind === "ssh"
        ? null
        : resolvedNextTarget.kind === "mesh"
          ? resolvedNextTarget.nodeId
          : resolvedNextTarget.executionNodeId;
    }
    if (executionTargetChanged) {
      normalizedUpdates.executionTargetRevision = (current.executionTargetRevision ?? 1) + 1;
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
