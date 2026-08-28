/**
 * Internal row-conversion helpers for workspace persistence.
 */

import { DEFAULT_WORKSPACE_TYPE, type Workspace } from "@/shared/workspace";
import type { AgentProvider } from "@/shared/settings";
import { getServerFingerprint, parseServerSettings } from "@/shared/settings";
import { requirePersistenceUserId } from "../ownership";

export function workspaceToRow(workspace: Workspace): Record<string, unknown> {
  return {
    id: workspace.id,
    user_id: requirePersistenceUserId(),
    name: workspace.name,
    directory: workspace.directory,
    workspace_type: workspace.workspaceType,
    execution_node_id: workspace.serverSettings.agent.transport === "stdio"
      ? workspace.executionNodeId ?? null
      : null,
    server_fingerprint: getServerFingerprint(workspace.serverSettings, workspace.executionNodeId),
    server_settings: JSON.stringify(workspace.serverSettings),
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
    is_private: workspace.isPrivate ? 1 : 0,
    archived: workspace.archived ? 1 : 0,
    allow_clanky_context: workspace.allowClankyContext === true ? 1 : 0,
    source_directory: workspace.sourceDirectory ?? null,
    ssh_server_id: workspace.sshServerId ?? null,
    repo_url: workspace.repoUrl ?? null,
    base_path: workspace.basePath ?? null,
    devcontainer_subpath: workspace.devcontainerSubpath ?? null,
    provider: workspace.provider ?? null,
  };
}

export function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    directory: row["directory"] as string,
    workspaceType: row["workspace_type"] === "directory"
      ? "directory"
      : DEFAULT_WORKSPACE_TYPE,
    executionNodeId: (row["execution_node_id"] as string | null) ?? null,
    serverSettings: parseServerSettings(row["server_settings"] as string | null),
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
    isPrivate: row["is_private"] === 1,
    archived: row["archived"] === 1,
    allowClankyContext: row["allow_clanky_context"] === 1,
    sourceDirectory: (row["source_directory"] as string | null) ?? undefined,
    sshServerId: (row["ssh_server_id"] as string | null) ?? undefined,
    repoUrl: (row["repo_url"] as string | null) ?? undefined,
    basePath: (row["base_path"] as string | null) ?? undefined,
    devcontainerSubpath: (row["devcontainer_subpath"] as string | null) ?? undefined,
    provider: (row["provider"] as AgentProvider | null) ?? undefined,
  };
}
