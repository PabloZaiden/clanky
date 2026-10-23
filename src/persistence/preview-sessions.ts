/**
 * Preview session persistence layer.
 */

import type { PreviewSession, PreviewSessionStatus } from "@/shared";
import type { ExecutionHostBinding } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "./database";
import {
  executionHostBindingFromRow,
  resolveExecutionHostBindingId,
} from "./execution-hosts";
import { filterWorkspacePersistenceRows, requireResourcePersistenceUserId, workspacePersistenceParameters } from "./ownership";
import { recordWorkspaceResourceCreation } from "./collaboration-creation";
import { z } from "zod";
import type { CodePreviewCleanup } from "@/shared/preview";

const log = createLogger("persistence:preview-sessions");
const CodeCleanupSchema = z.object({
  kind: z.literal("owned"),
  temporaryDirectory: z.string().min(1),
  directory: z.string().min(1),
  pathStyle: z.enum(["posix", "windows"]),
}).strict();

function parseCodeCleanup(raw: unknown, id: unknown): CodePreviewCleanup | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    return CodeCleanupSchema.parse(JSON.parse(String(raw)));
  } catch (error) {
    log.error("Invalid saved VS Code cleanup ownership; retaining its record", { id, error: String(error) });
    return { kind: "invalid" };
  }
}

function previewToRow(preview: PreviewSession): Record<string, number | string | null> {
  const userId = requireResourcePersistenceUserId("preview", preview.config.id, preview.config.workspaceId ?? null);
  const workspaceId = preview.config.workspaceId ?? null;
  if (preview.config.targetKind === "workspace" && workspaceId === null) {
    throw new Error("Workspace previews require a workspace association");
  }
  if (preview.config.targetKind === "server" && workspaceId !== null) {
    throw new Error("Server previews cannot have a workspace association");
  }
  return {
    id: preview.config.id,
    user_id: userId,
    target_kind: preview.config.targetKind,
    workspace_id: workspaceId,
    execution_host_id: resolveExecutionHostBindingId(
      userId,
      preview.config.executionHostBinding,
    ),
    execution_host_revision: preview.config.executionHostBinding.revision,
    remote_host: preview.config.remoteHost,
    remote_port: preview.config.remotePort,
    local_host: preview.config.localHost,
    local_port: preview.config.localPort,
    local_url: preview.config.localUrl,
    initial_path: preview.config.initialPath,
    cli_client_id: preview.config.cliClientId ?? null,
    cli_hostname: preview.config.cliHostname ?? null,
    ...(preview.config.codeCleanup?.kind === "invalid" ? {} : {
      code_cleanup_json: preview.config.codeCleanup ? JSON.stringify(preview.config.codeCleanup) : null,
    }),
    created_at: preview.config.createdAt,
    updated_at: preview.config.updatedAt,
    status: preview.state.status,
    connected_at: preview.state.connectedAt ?? null,
    closed_at: preview.state.closedAt ?? null,
    error_message: preview.state.error ?? null,
  };
}

function rowToPreview(row: Record<string, unknown>): PreviewSession {
  const targetKind = row["target_kind"];
  if (targetKind !== "workspace" && targetKind !== "server") {
    throw new Error("Preview session has an invalid target kind");
  }
  const workspaceId = (row["workspace_id"] as string | null) ?? undefined;
  if (targetKind === "workspace" && !workspaceId) {
    throw new Error("Workspace preview is missing its workspace association");
  }
  if (targetKind === "server" && workspaceId) {
    throw new Error("Server preview has an unexpected workspace association");
  }
  const executionHostBinding = executionHostBindingFromRow(row);
  if (!executionHostBinding) {
    throw new Error("Preview session is missing its execution-host binding");
  }
  return {
    config: {
      id: row["id"] as string,
      targetKind,
      workspaceId,
      executionHostBinding,
      remoteHost: row["remote_host"] as string,
      remotePort: row["remote_port"] as number,
      localHost: row["local_host"] as string,
      localPort: row["local_port"] as number,
      localUrl: row["local_url"] as string,
      initialPath: row["initial_path"] as string,
      cliClientId: (row["cli_client_id"] as string | null) ?? undefined,
      cliHostname: (row["cli_hostname"] as string | null) ?? undefined,
      codeCleanup: parseCodeCleanup(row["code_cleanup_json"], row["id"]),
      createdAt: row["created_at"] as string,
      updatedAt: row["updated_at"] as string,
    },
    state: {
      status: row["status"] as PreviewSessionStatus,
      connectedAt: (row["connected_at"] as string | null) ?? undefined,
      closedAt: (row["closed_at"] as string | null) ?? undefined,
      error: (row["error_message"] as string | null) ?? undefined,
    },
  };
}

const PREVIEW_SELECT = `
  SELECT
    preview.*,
    execution_host.kind AS execution_host_kind,
    execution_host.source_id AS execution_host_source_id,
    execution_host.target_key AS execution_host_target_key
  FROM preview_sessions preview
  JOIN execution_hosts execution_host
    ON execution_host.id = preview.execution_host_id
   AND execution_host.user_id = preview.user_id
`;

export async function savePreviewSession(preview: PreviewSession): Promise<void> {
  const db = getDatabase();
  const row = previewToRow(preview);
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  const updateClause = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");

  db.transaction(() => {
    const exists = db.query("SELECT 1 FROM preview_sessions WHERE id = ?").get(preview.config.id);
    db.run(
    `INSERT INTO preview_sessions (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updateClause}
     WHERE preview_sessions.user_id = excluded.user_id`,
    Object.values(row),
    );
    if (!exists) recordWorkspaceResourceCreation({ kind: "preview", id: preview.config.id,
      ownerUserId: String(row["user_id"]), workspaceId: preview.config.workspaceId });
  })();
  log.debug("Saved preview session", { id: preview.config.id, status: preview.state.status });
}

export async function getPreviewSession(id: string): Promise<PreviewSession | null> {
  const db = getDatabase();
  const row = db.query(`
    ${PREVIEW_SELECT}
    WHERE preview.id = ? AND preview.user_id = ?
  `).get(id, requireResourcePersistenceUserId("preview", id)) as Record<string, unknown> | null;
  return row ? rowToPreview(row) : null;
}

export async function deletePreviewSession(id: string): Promise<void> {
  const db = getDatabase();
  db.run(
    "DELETE FROM preview_sessions WHERE id = ? AND user_id = ?",
    [id, requireResourcePersistenceUserId("preview", id)],
  );
  log.debug("Deleted preview session", { id });
}

export async function listPreviewSessionsByWorkspaceAndStatuses(
  workspaceId: string,
  statuses: PreviewSessionStatus[],
): Promise<PreviewSession[]> {
  if (statuses.length === 0) {
    return [];
  }
  const placeholders = statuses.map(() => "?").join(", ");
  const db = getDatabase();
  const rows = db.query(`
    ${PREVIEW_SELECT}
    WHERE preview.workspace_id = ? AND preview.user_id = ?
      AND preview.status IN (${placeholders})
    ORDER BY preview.updated_at DESC
  `).all(workspaceId, requireResourcePersistenceUserId("preview", undefined, workspaceId), ...statuses) as Record<string, unknown>[];
  return filterWorkspacePersistenceRows(rows, "preview").map(rowToPreview);
}

export async function listPreviewSessionsByExecutionHostAndStatuses(
  binding: ExecutionHostBinding,
  statuses: PreviewSessionStatus[],
): Promise<PreviewSession[]> {
  if (statuses.length === 0) {
    return [];
  }
  const placeholders = statuses.map(() => "?").join(", ");
  const userId = requireResourcePersistenceUserId("preview", undefined, null);
  const executionHostId = resolveExecutionHostBindingId(userId, binding);
  const db = getDatabase();
  const rows = db.query(`
    ${PREVIEW_SELECT}
    WHERE preview.execution_host_id = ?
      AND preview.execution_host_revision = ?
      AND preview.user_id = ?
      AND preview.target_kind = 'server'
      AND preview.workspace_id IS NULL
      AND preview.status IN (${placeholders})
    ORDER BY preview.updated_at DESC
  `).all(
    executionHostId,
    binding.revision,
    userId,
    ...statuses,
  ) as Record<string, unknown>[];
  return rows.map(rowToPreview);
}

export async function listPreviewSessionsByStatuses(
  statuses: PreviewSessionStatus[],
): Promise<PreviewSession[]> {
  if (statuses.length === 0) {
    return [];
  }
  const placeholders = statuses.map(() => "?").join(", ");
  const db = getDatabase();
  const rows = db.query(`
    ${PREVIEW_SELECT}
    WHERE preview.user_id = ? AND (? IS NULL OR preview.workspace_id = ?) AND preview.status IN (${placeholders})
    ORDER BY preview.updated_at DESC
  `).all(requireResourcePersistenceUserId("preview"), ...workspacePersistenceParameters(), ...statuses) as Record<string, unknown>[];
  return filterWorkspacePersistenceRows(rows, "preview").map(rowToPreview);
}
