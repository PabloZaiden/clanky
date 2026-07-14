/**
 * Query operations for workspace persistence.
 *
 * Note: Most exported functions are marked `async` despite using synchronous
 * bun:sqlite APIs. This is intentional for interface consistency — callers
 * already `await` these functions, and the persistence layer may switch to
 * async storage in the future.
 */

import type { Workspace } from "@/shared/workspace";
import { getDatabase } from "../database";
import { createLogger } from "../../core/logger";
import { rowToWorkspace } from "./helpers";
import { requirePersistenceUserId } from "../ownership";

const log = createLogger("persistence:workspaces");

/**
 * List all workspaces sorted by name alphabetically.
 */
export async function listWorkspaces(): Promise<Workspace[]> {
  log.debug("Listing all workspaces");
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const stmt = db.prepare(`
    SELECT * FROM workspaces
    WHERE user_id = ?
    ORDER BY name COLLATE NOCASE ASC
  `);
  const rows = stmt.all(userId) as Array<Record<string, unknown>>;
  const workspaces = rows.map(rowToWorkspace);
  log.debug("Workspaces listed", { count: workspaces.length });
  return workspaces;
}

/**
 * Get the count of tasks for a workspace.
 */
export async function getWorkspaceTaskCount(workspaceId: string): Promise<number> {
  log.debug("Getting workspace task count", { workspaceId });
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const stmt = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE workspace_id = ? AND user_id = ?");
  const row = stmt.get(workspaceId, userId) as { count: number };
  log.debug("Workspace task count retrieved", { workspaceId, count: row.count });
  return row.count;
}

/**
 * Touch a workspace to update its updated_at timestamp.
 * Called when a task is created in this workspace.
 */
export async function touchWorkspace(id: string): Promise<void> {
  log.debug("Touching workspace", { id });
  const db = getDatabase();
  db.run("UPDATE workspaces SET updated_at = ? WHERE id = ? AND user_id = ?", [
    new Date().toISOString(),
    id,
    requirePersistenceUserId(),
  ]);
}
