/**
 * CRUD operations for workspace persistence.
 *
 * Note: Most exported functions are marked `async` despite using synchronous
 * bun:sqlite APIs. This is intentional for interface consistency — callers
 * already `await` these functions, and the persistence layer may switch to
 * async storage in the future.
 */

import type { Workspace } from "@/shared/workspace";
import { getServerFingerprint } from "@/shared/settings";
import { getDatabase } from "../database";
import { createLogger } from "../../core/logger";
import { workspaceToRow, rowToWorkspace } from "./helpers";
import { requirePersistenceUserId } from "../ownership";

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
  const stmt = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?");
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
  updates: Partial<Pick<Workspace, "name" | "serverSettings" | "devcontainerSubpath" | "isPrivate" | "archived" | "allowClankyContext">>
): Promise<Workspace | null> {
  log.debug("Updating workspace", {
    id,
    hasNameUpdate: updates.name !== undefined,
    hasSettingsUpdate: updates.serverSettings !== undefined,
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

  if (updates.serverSettings !== undefined) {
    setClauses.push("server_settings = ?");
    values.push(JSON.stringify(updates.serverSettings));
    setClauses.push("server_fingerprint = ?");
    values.push(getServerFingerprint(updates.serverSettings));
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

  log.info("Workspace updated", { id });
  return getWorkspace(id);
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

  db.run("DELETE FROM workspaces WHERE id = ? AND user_id = ?", [id, requirePersistenceUserId()]);
  log.info("Workspace deleted", { id, name: workspace.name });
  return true;
}
