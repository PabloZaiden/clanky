/**
 * Internal row-conversion helpers for workspace persistence.
 */

import { DEFAULT_WORKSPACE_TYPE, type Workspace } from "@/shared/workspace";
import { parseServerSettings } from "@/shared/settings";
import { requirePersistenceUserId } from "../ownership";
import {
  executionHostBindingFromRow,
  resolveExecutionHostBindingId,
} from "../execution-hosts";

export function workspaceToRow(workspace: Workspace): Record<string, unknown> {
  const userId = requirePersistenceUserId();
  const executionHostId = resolveExecutionHostBindingId(
    userId,
    workspace.executionHostBinding,
  );
  return {
    id: workspace.id,
    user_id: userId,
    name: workspace.name,
    directory: workspace.directory,
    workspace_type: workspace.workspaceType,
    execution_target_revision: Math.max(1, Math.floor(workspace.executionTargetRevision)),
    server_settings: JSON.stringify(workspace.serverSettings),
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
    is_private: workspace.isPrivate ? 1 : 0,
    archived: workspace.archived ? 1 : 0,
    allow_clanky_context: workspace.allowClankyContext === true ? 1 : 0,
    source_directory: workspace.sourceDirectory ?? null,
    repo_url: workspace.repoUrl ?? null,
    base_path: workspace.basePath ?? null,
    devcontainer_subpath: workspace.devcontainerSubpath ?? null,
    execution_host_id: executionHostId,
    execution_host_revision: workspace.executionHostBinding.revision,
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
    executionTargetRevision: typeof row["execution_target_revision"] === "number"
      ? Math.max(1, Math.floor(row["execution_target_revision"] as number))
      : 1,
    executionHostBinding: requireExecutionHostBinding(row),
    serverSettings: parseServerSettings(row["server_settings"] as string | null),
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
    isPrivate: row["is_private"] === 1,
    archived: row["archived"] === 1,
    allowClankyContext: row["allow_clanky_context"] === 1,
    sourceDirectory: (row["source_directory"] as string | null) ?? undefined,
    repoUrl: (row["repo_url"] as string | null) ?? undefined,
    basePath: (row["base_path"] as string | null) ?? undefined,
    devcontainerSubpath: (row["devcontainer_subpath"] as string | null) ?? undefined,
  };
}

function requireExecutionHostBinding(
  row: Record<string, unknown>,
): Workspace["executionHostBinding"] {
  const binding = executionHostBindingFromRow(row);
  if (!binding) {
    throw new Error(`Workspace ${String(row["id"])} has no execution-host binding`);
  }
  return binding;
}
