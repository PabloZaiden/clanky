import { getDatabase } from "./database";

interface EnrollmentTokenRow {
  id: string;
  user_id: string;
  name: string;
  controller_node_id: string;
  controller_fingerprint: string;
  purpose: string;
  workspace_worker_enrollment_id: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface MeshEnrollmentTokenSummary {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  controllerNodeId: string;
  controllerFingerprint: string;
  purpose: "global" | "workspace-worker";
  workspaceWorkerEnrollmentId: string | null;
}

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function summarize(row: EnrollmentTokenRow): MeshEnrollmentTokenSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    controllerNodeId: row.controller_node_id,
    controllerFingerprint: row.controller_fingerprint,
    purpose: row.purpose as "global" | "workspace-worker",
    workspaceWorkerEnrollmentId: row.workspace_worker_enrollment_id,
  };
}

export function createMeshEnrollmentToken(
  userId: string,
  name: string,
  ttlSeconds: number,
  controller: {
    nodeId: string;
    fingerprint: string;
  },
  options: {
    purpose?: "global" | "workspace-worker";
    workspaceWorkerEnrollmentId?: string;
  } = {},
): { token: string; enrollment: MeshEnrollmentTokenSummary } {
  const db = getDatabase();
  const id = crypto.randomUUID();
  const token = `clanky_mesh_${crypto.getRandomValues(new Uint8Array(32)).toHex()}`;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  db.run(
    `INSERT INTO mesh_enrollment_tokens
      (id, user_id, token_hash, name, controller_node_id,
       controller_fingerprint, purpose, workspace_worker_enrollment_id,
       created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      userId,
      hashToken(token),
      name,
      controller.nodeId,
      controller.fingerprint,
      options.purpose ?? "global",
      options.workspaceWorkerEnrollmentId ?? null,
      createdAt,
      expiresAt,
    ],
  );
  return {
    token,
    enrollment: {
      id,
      name,
      controllerNodeId: controller.nodeId,
      controllerFingerprint: controller.fingerprint,
      createdAt,
      expiresAt,
      consumedAt: null,
      purpose: options.purpose ?? "global",
      workspaceWorkerEnrollmentId: options.workspaceWorkerEnrollmentId ?? null,
    },
  };
}

export function listMeshEnrollmentTokens(userId: string): MeshEnrollmentTokenSummary[] {
  return getDatabase()
    .query<EnrollmentTokenRow, [string]>(
      `SELECT id, user_id, name, controller_node_id,
              controller_fingerprint, purpose, workspace_worker_enrollment_id,
              created_at, expires_at, consumed_at
       FROM mesh_enrollment_tokens
       WHERE user_id = ?
       ORDER BY created_at DESC`,
    )
    .all(userId)
    .map(summarize);
}

export function consumeMeshEnrollmentToken(
  token: string,
  expectedController: {
    nodeId: string;
    fingerprint: string;
  },
): {
  userId: string;
  controllerNodeId: string;
  controllerFingerprint: string;
  purpose: "global" | "workspace-worker";
  workspaceWorkerEnrollmentId: string | null;
} | null {
  const db = getDatabase();
  const consumedAt = new Date().toISOString();
  const row = db.query<{
    user_id: string;
    controller_node_id: string;
    controller_fingerprint: string;
    purpose: string;
    workspace_worker_enrollment_id: string | null;
  }, [string, string, string, string, string]>(
    `UPDATE mesh_enrollment_tokens
     SET consumed_at = ?
     WHERE token_hash = ?
       AND consumed_at IS NULL
       AND controller_node_id = ?
       AND controller_fingerprint = ?
       AND expires_at > ?
     RETURNING user_id, controller_node_id, controller_fingerprint,
               purpose, workspace_worker_enrollment_id`,
  ).get(
    consumedAt,
    hashToken(token),
    expectedController.nodeId,
    expectedController.fingerprint,
    consumedAt,
  );
  return row
    ? {
        userId: row.user_id,
        controllerNodeId: row.controller_node_id,
        controllerFingerprint: row.controller_fingerprint,
        purpose: row.purpose as "global" | "workspace-worker",
        workspaceWorkerEnrollmentId: row.workspace_worker_enrollment_id,
      }
    : null;
}

export function deleteMeshEnrollmentToken(id: string, userId: string): boolean {
  return getDatabase().query(
    "DELETE FROM mesh_enrollment_tokens WHERE id = ? AND user_id = ?",
  ).run(id, userId).changes > 0;
}
