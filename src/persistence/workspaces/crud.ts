/**
 * CRUD operations for workspace persistence.
 *
 * Note: Most exported functions are marked `async` despite using synchronous
 * bun:sqlite APIs. This is intentional for interface consistency — callers
 * already `await` these functions, and the persistence layer may switch to
 * async storage in the future.
 */

import type { Workspace } from "@/shared/workspace";
import { getDatabase } from "../database";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  rowToWorkspace,
  workspaceToRow,
} from "./helpers";
import { requirePersistenceUserId } from "../ownership";
import {
  EXECUTION_HOST_JOIN_COLUMNS,
  PROVISIONING_HOST_JOIN_COLUMNS,
  resolveExecutionHostBindingId,
} from "../execution-hosts";

const log = createLogger("persistence:workspaces");

/**
 * Create a new workspace.
 */
export async function createWorkspace(workspace: Workspace): Promise<void> {
  log.debug("Creating workspace", { id: workspace.id, name: workspace.name, directory: workspace.directory });
  const db = getDatabase();
  const row = workspaceToRow(workspace);

  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  const values = Object.values(row) as (string | number | null)[];

  const sql = `INSERT INTO workspaces (${columns.join(", ")}) VALUES (${placeholders})`;
  const stmt = db.prepare(sql);
  stmt.run(...values);
  log.info("Workspace created", { id: workspace.id, name: workspace.name });
}

/**
 * Get a workspace by ID.
 */
export async function getWorkspace(id: string): Promise<Workspace | null> {
  log.debug("Getting workspace", { id });
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const stmt = db.prepare(`
    SELECT workspace.*, ${EXECUTION_HOST_JOIN_COLUMNS},
      ${PROVISIONING_HOST_JOIN_COLUMNS},
      workspace_target.host AS workspace_ssh_target_host,
      workspace_target.port AS workspace_ssh_target_port,
      workspace_target.username AS workspace_ssh_target_username,
      workspace_target.password_ciphertext IS NOT NULL AS workspace_ssh_target_password_configured,
      workspace_target.target_key AS workspace_ssh_target_key,
      workspace_target.revision AS workspace_ssh_target_revision
    FROM workspaces workspace
    LEFT JOIN execution_hosts execution_host
      ON execution_host.id = workspace.execution_host_id
      AND execution_host.user_id = workspace.user_id
    LEFT JOIN execution_hosts provisioning_host
      ON provisioning_host.id = workspace.provisioning_host_id
      AND provisioning_host.user_id = workspace.user_id
    LEFT JOIN workspace_execution_targets workspace_target
      ON workspace_target.workspace_id = workspace.id
      AND workspace_target.user_id = workspace.user_id
    WHERE workspace.id = ? AND workspace.user_id = ?
  `);
  const row = stmt.get(id, userId) as Record<string, unknown> | null;
  if (!row) {
    log.debug("Workspace not found", { id });
    return null;
  }
  const workspace = rowToWorkspace(row);
  log.debug("Workspace retrieved", { id, name: workspace.name });
  return workspace;
}

/**
 * Update a workspace.
 */
export async function updateWorkspace(
  id: string,
  updates: Partial<Pick<
    Workspace,
    "name" | "directory" | "serverSettings" | "executionTargetRevision" | "executionHostBinding" | "provisioningHostBinding" | "devcontainerSubpath" | "isPrivate" | "archived" | "allowClankyContext"
  >>
): Promise<Workspace | null> {
  log.debug("Updating workspace", {
    id,
    hasNameUpdate: updates.name !== undefined,
    hasDirectoryUpdate: updates.directory !== undefined,
    hasSettingsUpdate: updates.serverSettings !== undefined,
    hasExecutionTargetRevisionUpdate: updates.executionTargetRevision !== undefined,
    hasDevcontainerSubpathUpdate: updates.devcontainerSubpath !== undefined,
    hasPrivateUpdate: updates.isPrivate !== undefined,
    hasArchivedUpdate: updates.archived !== undefined,
    hasClankyContextUpdate: updates.allowClankyContext !== undefined,
  });
  const db = getDatabase();
  const userId = requirePersistenceUserId();

  const setClauses: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.name !== undefined) {
    setClauses.push("name = ?");
    values.push(updates.name);
  }

  if (updates.directory !== undefined) {
    setClauses.push("directory = ?");
    values.push(updates.directory);
  }

  if (updates.serverSettings !== undefined) {
    setClauses.push("server_settings = ?");
    values.push(JSON.stringify(updates.serverSettings));
  }

  if (updates.executionTargetRevision !== undefined) {
    setClauses.push("execution_target_revision = ?");
    values.push(Math.max(1, Math.floor(updates.executionTargetRevision)));
  }

  if (updates.executionHostBinding !== undefined) {
    setClauses.push("execution_host_id = ?");
    values.push(resolveExecutionHostBindingId(userId, updates.executionHostBinding));
    setClauses.push("execution_host_revision = ?");
    values.push(updates.executionHostBinding.revision);
  }

  if (updates.provisioningHostBinding !== undefined) {
    setClauses.push("provisioning_host_id = ?");
    values.push(updates.provisioningHostBinding
      ? resolveExecutionHostBindingId(userId, updates.provisioningHostBinding)
      : null);
    setClauses.push("provisioning_host_revision = ?");
    values.push(updates.provisioningHostBinding?.revision ?? null);
  }

  if (updates.devcontainerSubpath !== undefined) {
    setClauses.push("devcontainer_subpath = ?");
    values.push(updates.devcontainerSubpath || null);
  }

  if (updates.isPrivate !== undefined) {
    setClauses.push("is_private = ?");
    values.push(updates.isPrivate ? 1 : 0);
  }

  if (updates.archived !== undefined) {
    setClauses.push("archived = ?");
    values.push(updates.archived ? 1 : 0);
  }

  if (updates.allowClankyContext !== undefined) {
    setClauses.push("allow_clanky_context = ?");
    values.push(updates.allowClankyContext ? 1 : 0);
  }

  if (setClauses.length === 0) {
    log.debug("No updates provided, returning existing workspace", { id });
    return getWorkspace(id);
  }

  setClauses.push("updated_at = ?");
  values.push(new Date().toISOString());

  values.push(id, userId);

  const sql = `UPDATE workspaces SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`;
  const stmt = db.prepare(sql);
  stmt.run(...values);

  const updated = await getWorkspace(id);
  log.info("Workspace updated", { id });
  return updated;
}

export async function countWorkspaceTasks(id: string): Promise<number> {
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const taskCountStmt = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE workspace_id = ? AND user_id = ?");
  const taskCountRow = taskCountStmt.get(id, userId) as { count: number };
  return taskCountRow.count;
}

/**
 * Delete a workspace by ID.
 * Only succeeds if the workspace has no associated tasks.
 *
 * @returns true if deleted, false if not found or has tasks
 */
export async function deleteWorkspace(id: string): Promise<boolean> {
  log.debug("Deleting workspace", { id });
  const db = getDatabase();

  const workspace = await getWorkspace(id);
  if (!workspace) {
    log.debug("Workspace not found for deletion", { id });
    return false;
  }

  const taskCount = await countWorkspaceTasks(id);

  if (taskCount > 0) {
    log.warn("Cannot delete workspace with tasks", { id, taskCount });
    return false;
  }

  const workspaceUserId = requirePersistenceUserId();
  db.run("DELETE FROM workspaces WHERE id = ? AND user_id = ?", [id, workspaceUserId]);
  log.info("Workspace deleted", { id, name: workspace.name });
  return true;
}
