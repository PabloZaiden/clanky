/**
 * Persistence for temporary, workspace-exclusive Mesh worker reservations.
 */

import { getDatabase } from "./database";
import {
  createMeshEnrollmentToken,
  deleteMeshEnrollmentToken,
  type MeshEnrollmentTokenSummary,
} from "./mesh-enrollment-tokens";

export const WORKSPACE_WORKER_ENROLLMENT_STATUSES = [
  "pending",
  "connected",
  "claimed",
  "attached",
  "cancelled",
  "expired",
  "failed",
] as const;
export type WorkspaceWorkerEnrollmentStatus =
  (typeof WORKSPACE_WORKER_ENROLLMENT_STATUSES)[number];

export interface WorkspaceWorkerEnrollment {
  id: string;
  userId: string;
  tokenId: string;
  name: string;
  status: WorkspaceWorkerEnrollmentStatus;
  workerNodeId: string | null;
  workspaceId: string | null;
  claimedBy: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  expiresAt: string;
  connectedAt: string | null;
  attachedAt: string | null;
  updatedAt: string;
}

export interface CreatedWorkspaceWorkerEnrollment {
  enrollment: WorkspaceWorkerEnrollment;
  token: string;
  tokenSummary: MeshEnrollmentTokenSummary;
}

interface WorkspaceWorkerEnrollmentRow {
  id: string;
  user_id: string;
  token_id: string;
  name: string;
  status: string;
  worker_node_id: string | null;
  workspace_id: string | null;
  claimed_by: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  expires_at: string;
  connected_at: string | null;
  attached_at: string | null;
  updated_at: string;
}

function mapRow(row: WorkspaceWorkerEnrollmentRow): WorkspaceWorkerEnrollment {
  return {
    id: row.id,
    userId: row.user_id,
    tokenId: row.token_id,
    name: row.name,
    status: row.status as WorkspaceWorkerEnrollmentStatus,
    workerNodeId: row.worker_node_id,
    workspaceId: row.workspace_id,
    claimedBy: row.claimed_by,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    connectedAt: row.connected_at,
    attachedAt: row.attached_at,
    updatedAt: row.updated_at,
  };
}

function getByWhere(
  where: string,
  values: string[],
): WorkspaceWorkerEnrollment | null {
  const row = getDatabase().query(`
    SELECT id, user_id, token_id, name, status, worker_node_id,
           workspace_id, claimed_by, error_code, error_message,
           created_at, expires_at, connected_at, attached_at, updated_at
    FROM workspace_worker_enrollments
    WHERE ${where}
    LIMIT 1
  `).get(...values) as WorkspaceWorkerEnrollmentRow | null;
  return row ? mapRow(row) : null;
}

export function createWorkspaceWorkerEnrollment(input: {
  userId: string;
  name: string;
  ttlSeconds: number;
  controller: {
    nodeId: string;
    fingerprint: string;
  };
}): CreatedWorkspaceWorkerEnrollment {
  const id = crypto.randomUUID();
  const created = createMeshEnrollmentToken(
    input.userId,
    input.name,
    input.ttlSeconds,
    input.controller,
    {
      purpose: "workspace-worker",
      workspaceWorkerEnrollmentId: id,
    },
  );
  const now = new Date().toISOString();
  const db = getDatabase();
  try {
    db.query(`
      INSERT INTO workspace_worker_enrollments (
        id, user_id, token_id, name, status, created_at, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      id,
      input.userId,
      created.enrollment.id,
      input.name,
      now,
      created.enrollment.expiresAt,
      now,
    );
  } catch (error) {
    deleteMeshEnrollmentToken(created.enrollment.id, input.userId);
    throw error;
  }

  const enrollment = getByWhere("id = ? AND user_id = ?", [id, input.userId]);
  if (!enrollment) {
    throw new Error("Failed to save workspace worker enrollment");
  }
  return {
    enrollment,
    token: created.token,
    tokenSummary: created.enrollment,
  };
}

export function getWorkspaceWorkerEnrollment(
  userId: string,
  enrollmentId: string,
): WorkspaceWorkerEnrollment | null {
  return getByWhere("id = ? AND user_id = ?", [enrollmentId, userId]);
}

export function getWorkspaceWorkerEnrollmentByWorkspace(
  userId: string,
  workspaceId: string,
): WorkspaceWorkerEnrollment | null {
  return getByWhere("workspace_id = ? AND user_id = ?", [workspaceId, userId]);
}

export function listWorkspaceWorkerEnrollments(
  userId: string,
): WorkspaceWorkerEnrollment[] {
  const rows = getDatabase().query(`
    SELECT id, user_id, token_id, name, status, worker_node_id,
           workspace_id, claimed_by, error_code, error_message,
           created_at, expires_at, connected_at, attached_at, updated_at
    FROM workspace_worker_enrollments
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId) as WorkspaceWorkerEnrollmentRow[];
  return rows.map(mapRow);
}

export function markWorkspaceWorkerConnected(input: {
  userId: string;
  enrollmentId: string;
  workerNodeId: string;
}): WorkspaceWorkerEnrollment {
  const now = new Date().toISOString();
  const result = getDatabase().query(`
    UPDATE workspace_worker_enrollments
    SET status = 'connected', worker_node_id = ?, connected_at = ?,
        error_code = NULL, error_message = NULL, updated_at = ?
    WHERE id = ? AND user_id = ? AND status IN ('pending', 'connected')
      AND expires_at > ?
  `).run(
    input.workerNodeId,
    now,
    now,
    input.enrollmentId,
    input.userId,
    now,
  );
  if (result.changes === 0) {
    throw new Error(`Workspace worker enrollment is not available: ${input.enrollmentId}`);
  }
  const enrollment = getWorkspaceWorkerEnrollment(input.userId, input.enrollmentId);
  if (!enrollment) {
    throw new Error(`Workspace worker enrollment not found: ${input.enrollmentId}`);
  }
  deleteMeshEnrollmentToken(enrollment.tokenId, input.userId);
  return enrollment;
}

export function claimWorkspaceWorkerEnrollment(input: {
  userId: string;
  enrollmentId: string;
  claimedBy: string;
  workspaceId?: string;
  previousClaimedBy?: string;
}): WorkspaceWorkerEnrollment {
  const now = new Date().toISOString();
  const db = getDatabase();
  const result = db.query(`
    UPDATE workspace_worker_enrollments
    SET status = 'claimed', claimed_by = ?,
        workspace_id = COALESCE(?, workspace_id), updated_at = ?
    WHERE id = ? AND user_id = ? AND expires_at > ?
      AND (
        status = 'connected'
        OR (
          status = 'claimed'
          AND claimed_by = ?
        )
      )
  `).run(
    input.claimedBy,
    input.workspaceId ?? null,
    now,
    input.enrollmentId,
    input.userId,
    now,
    input.previousClaimedBy ?? input.claimedBy,
  );
  if (result.changes === 0) {
    throw new Error(`Workspace worker enrollment cannot be claimed: ${input.enrollmentId}`);
  }
  const enrollment = getWorkspaceWorkerEnrollment(input.userId, input.enrollmentId);
  if (!enrollment) {
    throw new Error(`Workspace worker enrollment not found: ${input.enrollmentId}`);
  }
  deleteMeshEnrollmentToken(enrollment.tokenId, input.userId);
  return enrollment;
}

export function attachWorkspaceWorkerEnrollment(input: {
  userId: string;
  enrollmentId: string;
  workspaceId: string;
  claimedBy: string;
}): WorkspaceWorkerEnrollment {
  const now = new Date().toISOString();
  const result = getDatabase().query(`
    UPDATE workspace_worker_enrollments
    SET status = 'attached', workspace_id = ?, attached_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'claimed'
      AND claimed_by = ? AND (workspace_id IS NULL OR workspace_id = ?)
  `).run(
    input.workspaceId,
    now,
    now,
    input.enrollmentId,
    input.userId,
    input.claimedBy,
    input.workspaceId,
  );
  if (result.changes === 0) {
    throw new Error(`Workspace worker enrollment cannot be attached: ${input.enrollmentId}`);
  }
  const enrollment = getWorkspaceWorkerEnrollment(input.userId, input.enrollmentId);
  if (!enrollment) {
    throw new Error(`Workspace worker enrollment not found: ${input.enrollmentId}`);
  }
  deleteMeshEnrollmentToken(enrollment.tokenId, input.userId);
  return enrollment;
}

export function failWorkspaceWorkerEnrollment(input: {
  userId: string;
  enrollmentId: string;
  status?: "cancelled" | "expired" | "failed";
  errorCode?: string;
  errorMessage?: string;
  allowAttached?: boolean;
}): WorkspaceWorkerEnrollment | null {
  const nextStatus = input.status ?? "failed";
  const now = new Date().toISOString();
  getDatabase().query(`
    UPDATE workspace_worker_enrollments
    SET status = ?, error_code = ?, error_message = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
      AND status NOT IN ('cancelled', 'expired', 'failed')
      AND (? = 1 OR status != 'attached')
  `).run(
    nextStatus,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    now,
    input.enrollmentId,
    input.userId,
    input.allowAttached === true ? 1 : 0,
  );
  const enrollment = getWorkspaceWorkerEnrollment(input.userId, input.enrollmentId);
  if (enrollment && ["cancelled", "expired", "failed"].includes(enrollment.status)) {
    deleteMeshEnrollmentToken(enrollment.tokenId, input.userId);
  }
  return enrollment;
}
