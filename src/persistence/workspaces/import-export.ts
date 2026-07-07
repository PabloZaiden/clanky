/**
 * Import/export operations for workspace persistence.
 *
 * Note: Most exported functions are marked `async` despite using synchronous
 * bun:sqlite APIs. This is intentional for interface consistency — callers
 * already `await` these functions, and the persistence layer may switch to
 * async storage in the future.
 */

import type { WorkspaceImportResult } from "../../types/workspace";
import type { WorkspaceConfig, WorkspaceExportData } from "../../types/schemas";
import { getDatabase } from "../database";
import { createLogger } from "../../core/logger";
import { rowToWorkspace } from "./helpers";
import { createWorkspace } from "./crud";
import { requirePersistenceUserId } from "../ownership";

const log = createLogger("persistence:workspaces");

/**
 * Export all workspaces as a portable config format.
 * Strips internal fields (id, timestamps) and returns only portable config.
 */
export async function exportWorkspaces(): Promise<WorkspaceExportData> {
  log.debug("Exporting all workspaces");
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM workspaces WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC");
  const rows = stmt.all(requirePersistenceUserId()) as Array<Record<string, unknown>>;

  const workspaces: WorkspaceConfig[] = rows.map((row) => {
    const workspace = rowToWorkspace(row);
    return {
      name: workspace.name,
      directory: workspace.directory,
      serverSettings: workspace.serverSettings,
    };
  });

  log.info("Workspaces exported", { count: workspaces.length });
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    workspaces,
  };
}

/**
 * Import workspaces from a portable config format.
 * Always creates new workspaces — workspaces are identified by their unique
 * ID, not by directory, so imports never skip based on directory matches.
 */
export async function importWorkspaces(data: WorkspaceExportData): Promise<WorkspaceImportResult> {
  log.debug("Importing workspaces", { count: data.workspaces.length });

  const result: WorkspaceImportResult = {
    created: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  for (const config of data.workspaces) {
    const name = config.name.trim();
    const directory = config.directory.trim();

    const now = new Date().toISOString();
    const workspace = {
      id: crypto.randomUUID(),
      name,
      directory,
      serverSettings: config.serverSettings,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };

    await createWorkspace(workspace);
    result.created++;
    result.details.push({
      name,
      directory,
      status: "created",
    });
  }

  log.info("Workspaces imported", { created: result.created, skipped: result.skipped });
  return result;
}
