/**
 * Internal row-conversion helpers for workspace persistence.
 */

import type { Workspace } from "../../types/workspace";
import type { AgentProvider } from "../../types/settings";
import { getServerFingerprint, parseServerSettings } from "../../types/settings";
import { requirePersistenceUserId } from "../ownership";

export function workspaceToRow(workspace: Workspace): Record<string, unknown> {
  return {
    id: workspace.id,
    user_id: requirePersistenceUserId(),
    name: workspace.name,
    directory: workspace.directory,
    server_fingerprint: getServerFingerprint(workspace.serverSettings),
    server_settings: JSON.stringify(workspace.serverSettings),
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
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
    serverSettings: parseServerSettings(row["server_settings"] as string | null),
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
    sourceDirectory: (row["source_directory"] as string | null) ?? undefined,
    sshServerId: (row["ssh_server_id"] as string | null) ?? undefined,
    repoUrl: (row["repo_url"] as string | null) ?? undefined,
    basePath: (row["base_path"] as string | null) ?? undefined,
    devcontainerSubpath: (row["devcontainer_subpath"] as string | null) ?? undefined,
    provider: (row["provider"] as AgentProvider | null) ?? undefined,
  };
}
