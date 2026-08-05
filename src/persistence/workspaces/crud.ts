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
import { createLogger } from "@pablozaiden/webapp/server";
import {
  rowToWorkspace,
  type MeshWorkspacePayload,
  workspaceToRow,
  workspaceWithoutIdentityFile,
} from "./helpers";
import { requirePersistenceUserId } from "../ownership";
import { scheduleMeshCheckpoint } from "../mesh-sync";
import { unlink } from "fs/promises";
import { join } from "path";

const log = createLogger("persistence:workspaces");

function getManagedIdentityFilePath(workspaceId: string): string {
  return join(
    process.env["CLANKY_DATA_DIR"] ?? "./data",
    "mesh",
    "workspace-identity-files",
    `${workspaceId}.key`,
  );
}

export async function getWorkspaceMeshPayload(workspace: Workspace): Promise<MeshWorkspacePayload> {
  const identityFileConfigured = workspace.serverSettings.agent.transport === "ssh"
    && Boolean(workspace.serverSettings.agent.identityFile?.trim());
  return {
    workspace: workspaceWithoutIdentityFile(workspace),
    identityFile: { configured: identityFileConfigured },
  };
}

function applyIdentityFileToWorkspace(
  workspace: Workspace,
  identityFile: MeshWorkspacePayload["identityFile"],
  existing: Workspace | null,
): Workspace {
  if (workspace.serverSettings.agent.transport !== "ssh") {
    return workspace;
  }

  const currentIdentityFile = existing?.serverSettings.agent.transport === "ssh"
    ? existing.serverSettings.agent.identityFile
    : undefined;
  if (!identityFile.configured) {
    const { identityFile: _identityFile, ...agent } = workspace.serverSettings.agent;
    return {
      ...workspace,
      serverSettings: { agent },
    };
  }

  if (currentIdentityFile) {
    return {
      ...workspace,
      serverSettings: {
        agent: {
          ...workspace.serverSettings.agent,
          identityFile: currentIdentityFile,
        },
      },
    };
  }

  const { identityFile: _identityFile, ...agent } = workspace.serverSettings.agent;
  return {
    ...workspace,
    serverSettings: { agent },
  };
}

async function deleteManagedIdentityFile(workspaceId: string): Promise<void> {
  try {
    await unlink(getManagedIdentityFilePath(workspaceId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

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
  const meshPayload = await getWorkspaceMeshPayload(workspace);
  scheduleMeshCheckpoint({
    userId: String(row["user_id"]),
    aggregateType: "workspace",
    aggregateId: workspace.id,
    payload: meshPayload,
  });
  log.info("Workspace created", { id: workspace.id, name: workspace.name });
}

export async function saveWorkspaceFromMesh(payload: MeshWorkspacePayload): Promise<void> {
  const existing = await getWorkspace(payload.workspace.id);
  const workspace = applyIdentityFileToWorkspace(payload.workspace, payload.identityFile, existing);
  if (!payload.identityFile.configured) {
    await deleteManagedIdentityFile(workspace.id);
  }
  const db = getDatabase();
  const row = workspaceToRow(workspace);
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  const values = Object.values(row) as (string | number | null)[];
  const updateClause = columns
    .filter((column) => column !== "id" && column !== "user_id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  db.run(`
    INSERT INTO workspaces (${columns.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updateClause}
    WHERE workspaces.user_id = excluded.user_id
  `, values);
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
  updates: Partial<Pick<
    Workspace,
    "name" | "serverSettings" | "executionNodeId" | "devcontainerSubpath" | "isPrivate" | "archived" | "allowClankyContext"
  >>
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

  if (updates.executionNodeId !== undefined) {
    setClauses.push("execution_node_id = ?");
    values.push(updates.executionNodeId);
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
  if (updated) {
    const meshPayload = await getWorkspaceMeshPayload(updated);
    scheduleMeshCheckpoint({
      userId,
      aggregateType: "workspace",
      aggregateId: id,
      payload: meshPayload,
    });
  }
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
  await deleteManagedIdentityFile(id);
  const meshPayload = await getWorkspaceMeshPayload(workspace);
  scheduleMeshCheckpoint({
    userId: workspaceUserId,
    aggregateType: "workspace",
    aggregateId: id,
    payload: meshPayload,
    tombstone: true,
    eligible: true,
  });
  log.info("Workspace deleted", { id, name: workspace.name });
  return true;
}
