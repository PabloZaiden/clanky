/**
 * CRUD operations for workspace persistence.
 *
 * Note: Most exported functions are marked `async` despite using synchronous
 * bun:sqlite APIs. This is intentional for interface consistency — callers
 * already `await` these functions, and the persistence layer may switch to
 * async storage in the future.
 */

import type { Workspace } from "../../types/workspace";
import { getServerFingerprint } from "../../types/settings";
import { getDatabase } from "../database";
import { createLogger } from "../../core/logger";
import { workspaceToRow, rowToWorkspace } from "./helpers";

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
  const stmt = db.prepare("SELECT * FROM workspaces WHERE id = ?");
  const row = stmt.get(id) as Record<string, unknown> | null;
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
  updates: Partial<Pick<Workspace, "name" | "serverSettings" | "devcontainerSubpath">>
): Promise<Workspace | null> {
  log.debug("Updating workspace", {
    id,
    hasNameUpdate: updates.name !== undefined,
    hasSettingsUpdate: updates.serverSettings !== undefined,
    hasDevcontainerSubpathUpdate: updates.devcontainerSubpath !== undefined,
  });
  const db = getDatabase();

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

  if (setClauses.length === 0) {
    log.debug("No updates provided, returning existing workspace", { id });
    return getWorkspace(id);
  }

  setClauses.push("updated_at = ?");
  values.push(new Date().toISOString());

  values.push(id);

  const sql = `UPDATE workspaces SET ${setClauses.join(", ")} WHERE id = ?`;
  const stmt = db.prepare(sql);
  stmt.run(...values);

  log.info("Workspace updated", { id });
  return getWorkspace(id);
}

/**
 * Delete a workspace by ID.
 * Only succeeds if the workspace has no associated loops.
 *
 * @returns true if deleted, false if not found or has loops
 */
export async function deleteWorkspace(id: string): Promise<{ success: boolean; reason?: string }> {
  log.debug("Deleting workspace", { id });
  const db = getDatabase();

  const workspace = await getWorkspace(id);
  if (!workspace) {
    log.debug("Workspace not found for deletion", { id });
    return { success: false, reason: "Workspace not found" };
  }

  const loopCountStmt = db.prepare("SELECT COUNT(*) as count FROM loops WHERE workspace_id = ?");
  const loopCountRow = loopCountStmt.get(id) as { count: number };

  if (loopCountRow.count > 0) {
    log.warn("Cannot delete workspace with loops", { id, loopCount: loopCountRow.count });
    return {
      success: false,
      reason: `Workspace has ${loopCountRow.count} loop(s). Delete all loops first.`,
    };
  }

  db.run("DELETE FROM workspaces WHERE id = ?", [id]);
  log.info("Workspace deleted", { id, name: workspace.name });
  return { success: true };
}
