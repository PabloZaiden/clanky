import { getDatabase } from "./database";

interface EnrollmentTokenRow {
  id: string;
  user_id: string;
  name: string;
  controller_node_id: string;
  controller_fingerprint: string;
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
): { token: string; enrollment: MeshEnrollmentTokenSummary } {
  const db = getDatabase();
  const id = crypto.randomUUID();
  const token = `clanky_mesh_${crypto.getRandomValues(new Uint8Array(32)).toHex()}`;
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  db.run(
    `INSERT INTO mesh_enrollment_tokens
      (id, user_id, token_hash, name, controller_node_id,
       controller_fingerprint, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      userId,
      hashToken(token),
      name,
      controller.nodeId,
      controller.fingerprint,
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
    },
  };
}

export function listMeshEnrollmentTokens(userId: string): MeshEnrollmentTokenSummary[] {
  return getDatabase()
    .query<EnrollmentTokenRow, [string]>(
      `SELECT id, user_id, name, controller_node_id,
              controller_fingerprint, created_at, expires_at, consumed_at
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
} | null {
  const db = getDatabase();
  const consumedAt = new Date().toISOString();
  const row = db.query<{
    user_id: string;
    controller_node_id: string;
    controller_fingerprint: string;
  }, [string, string, string, string, string]>(
    `UPDATE mesh_enrollment_tokens
     SET consumed_at = ?
     WHERE token_hash = ?
       AND consumed_at IS NULL
       AND controller_node_id = ?
       AND controller_fingerprint = ?
       AND expires_at > ?
     RETURNING user_id, controller_node_id, controller_fingerprint`,
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
      }
    : null;
}
