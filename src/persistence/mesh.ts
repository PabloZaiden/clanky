/**
 * Persistence for the controller-worker mesh.
 *
 * Controllers store worker registrations. Workers store controller grants.
 * No links, no members, no peer-to-peer gossip. Trust is per durable
 * controller-worker grant.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type {
  MeshControllerGrant,
  MeshGrantStatus,
  MeshTransport,
  MeshWorkerRegistration,
} from "@/shared/mesh";
import type { ExecutionHostCapabilities } from "@/shared/execution-host";
import {
  ensureExecutionHost,
  getExecutionHostByRef,
  revokeExecutionHost,
} from "./execution-hosts";
import { buildMeshTargetKey } from "./workspace-target-key";
import { getDatabase } from "./database";

const log = createLogger("persistence:mesh");

// ---------------------------------------------------------------------------
// Worker registrations (controller side)
// ---------------------------------------------------------------------------

export interface SaveWorkerRegistrationInput {
  workerNodeId: string;
  localUserId: string;
  workerInstanceName: string | null;
  workerEndpoint: string;
  workerTransport: MeshTransport;
  workerPublicKey: string;
  workerFingerprint: string;
  workerEncryptionPublicKey: string | null;
  workerDirectory: string | null;
  workerCapabilities: ExecutionHostCapabilities | null;
  workerAcceptRemoteExecution: boolean;
  workerConfigRevision: number;
}

export async function saveWorkerRegistration(
  input: SaveWorkerRegistrationInput,
): Promise<MeshWorkerRegistration> {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO mesh_worker_registrations (
      worker_node_id, local_user_id, worker_instance_name,
      worker_endpoint, worker_transport,
      worker_public_key, worker_fingerprint, worker_encryption_public_key,
      worker_directory, worker_capabilities_json,
      worker_accept_remote_execution, worker_config_revision,
      grant_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(local_user_id, worker_node_id) DO UPDATE SET
      worker_instance_name = excluded.worker_instance_name,
      worker_endpoint = excluded.worker_endpoint,
      worker_transport = excluded.worker_transport,
      worker_public_key = excluded.worker_public_key,
      worker_fingerprint = excluded.worker_fingerprint,
      worker_encryption_public_key = excluded.worker_encryption_public_key,
      worker_directory = excluded.worker_directory,
      worker_capabilities_json = excluded.worker_capabilities_json,
      worker_accept_remote_execution = excluded.worker_accept_remote_execution,
      worker_config_revision = excluded.worker_config_revision,
      grant_status = 'active',
      updated_at = excluded.updated_at`,
    [
      input.workerNodeId,
      input.localUserId,
      input.workerInstanceName,
      input.workerEndpoint,
      input.workerTransport,
      input.workerPublicKey,
      input.workerFingerprint,
      input.workerEncryptionPublicKey,
      input.workerDirectory,
      input.workerCapabilities ? JSON.stringify(input.workerCapabilities) : null,
      input.workerAcceptRemoteExecution ? 1 : 0,
      input.workerConfigRevision,
      now,
      now,
    ],
  );

  // Ensure execution host record exists for the worker
  ensureExecutionHost(
    input.localUserId,
    { kind: "mesh", nodeId: input.workerNodeId },
    buildMeshTargetKey(input.workerNodeId),
  );

  const reg = await getWorkerRegistration(input.workerNodeId, input.localUserId);
  if (!reg) {
    throw new Error("Failed to save worker registration");
  }

  log.info("Saved worker registration", {
    workerNodeId: input.workerNodeId,
    instanceName: input.workerInstanceName,
  });

  return reg;
}

export async function getWorkerRegistration(
  workerNodeId: string,
  localUserId: string,
): Promise<MeshWorkerRegistration | null> {
  const db = getDatabase();
  const row = db
    .query("SELECT * FROM mesh_worker_registrations WHERE worker_node_id = ? AND local_user_id = ?")
    .get(workerNodeId, localUserId) as WorkerRegistrationRow | null;
  return row ? mapWorkerRegistrationRow(row) : null;
}

export async function listWorkerRegistrations(
  localUserId: string,
): Promise<MeshWorkerRegistration[]> {
  const db = getDatabase();
  const rows = db
    .query(
      "SELECT * FROM mesh_worker_registrations WHERE local_user_id = ? ORDER BY created_at ASC",
    )
    .all(localUserId) as WorkerRegistrationRow[];
  return rows.map(mapWorkerRegistrationRow);
}

export async function listActiveWorkerRegistrations(
  localUserId: string,
): Promise<MeshWorkerRegistration[]> {
  const db = getDatabase();
  const rows = db
    .query(
      "SELECT * FROM mesh_worker_registrations WHERE local_user_id = ? AND grant_status = 'active' ORDER BY created_at ASC",
    )
    .all(localUserId) as WorkerRegistrationRow[];
  return rows.map(mapWorkerRegistrationRow);
}

export async function revokeWorkerRegistration(
  workerNodeId: string,
  localUserId: string,
): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    const result = db.run(
      "UPDATE mesh_worker_registrations SET grant_status = 'revoked', updated_at = ? WHERE worker_node_id = ? AND local_user_id = ?",
      [now, workerNodeId, localUserId],
    );
    if (result.changes === 0) {
      throw new Error(`Worker registration not found: ${workerNodeId}`);
    }

    // Revoke the associated execution host
    const host = getExecutionHostByRef(
      localUserId,
      { kind: "mesh", nodeId: workerNodeId },
    );
    if (host) {
      revokeExecutionHost(localUserId, host.id);
    }
  });

  txn();
  log.info("Revoked worker registration", { workerNodeId });
}

export async function deleteRevokedWorkerRegistration(
  workerNodeId: string,
  localUserId: string,
): Promise<void> {
  const db = getDatabase();
  const result = db.run(
    "DELETE FROM mesh_worker_registrations WHERE worker_node_id = ? AND local_user_id = ? AND grant_status = 'revoked'",
    [workerNodeId, localUserId],
  );
  if (result.changes === 0) {
    throw new Error(`Revoked worker registration not found: ${workerNodeId}`);
  }
  log.info("Deleted revoked worker registration", { workerNodeId });
}

export async function updateWorkerHealthSnapshot(input: {
  workerNodeId: string;
  localUserId: string;
  directory: string;
  capabilities: ExecutionHostCapabilities;
  acceptRemoteExecution: boolean;
  configRevision: number;
}): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    `UPDATE mesh_worker_registrations SET
      worker_directory = ?,
      worker_capabilities_json = ?,
      worker_accept_remote_execution = ?,
      worker_config_revision = ?,
      last_seen_at = ?,
      updated_at = ?
    WHERE worker_node_id = ? AND local_user_id = ?`,
    [
      input.directory,
      JSON.stringify(input.capabilities),
      input.acceptRemoteExecution ? 1 : 0,
      input.configRevision,
      now,
      now,
      input.workerNodeId,
      input.localUserId,
    ],
  );
}

// ---------------------------------------------------------------------------
// Controller grants (worker side)
// ---------------------------------------------------------------------------

export interface SaveControllerGrantInput {
  controllerNodeId: string;
  controllerInstanceName: string | null;
  controllerPublicKey: string;
  controllerFingerprint: string;
  controllerEncryptionPublicKey: string | null;
}

export async function saveControllerGrant(
  input: SaveControllerGrantInput,
): Promise<MeshControllerGrant> {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO mesh_controller_grants (
      controller_node_id, controller_instance_name,
      controller_public_key, controller_fingerprint,
      controller_encryption_public_key,
      grant_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(controller_node_id) DO UPDATE SET
      controller_instance_name = excluded.controller_instance_name,
      controller_public_key = excluded.controller_public_key,
      controller_fingerprint = excluded.controller_fingerprint,
      controller_encryption_public_key = excluded.controller_encryption_public_key,
      grant_status = 'active',
      updated_at = excluded.updated_at`,
    [
      input.controllerNodeId,
      input.controllerInstanceName,
      input.controllerPublicKey,
      input.controllerFingerprint,
      input.controllerEncryptionPublicKey,
      now,
      now,
    ],
  );

  const grant = await getControllerGrant(input.controllerNodeId);
  if (!grant) {
    throw new Error("Failed to save controller grant");
  }

  log.info("Saved controller grant", {
    controllerNodeId: input.controllerNodeId,
    instanceName: input.controllerInstanceName,
  });

  return grant;
}

export async function getControllerGrant(
  controllerNodeId: string,
): Promise<MeshControllerGrant | null> {
  const db = getDatabase();
  const row = db
    .query(
      "SELECT * FROM mesh_controller_grants WHERE controller_node_id = ?",
    )
    .get(controllerNodeId) as ControllerGrantRow | null;
  return row ? mapControllerGrantRow(row) : null;
}

export async function listControllerGrants(): Promise<MeshControllerGrant[]> {
  const db = getDatabase();
  const rows = db
    .query(
      "SELECT * FROM mesh_controller_grants ORDER BY created_at ASC",
    )
    .all() as ControllerGrantRow[];
  return rows.map(mapControllerGrantRow);
}

export async function listActiveControllerGrants(): Promise<
  MeshControllerGrant[]
> {
  const db = getDatabase();
  const rows = db
    .query(
      "SELECT * FROM mesh_controller_grants WHERE grant_status = 'active' ORDER BY created_at ASC",
    )
    .all() as ControllerGrantRow[];
  return rows.map(mapControllerGrantRow);
}

export async function revokeControllerGrant(
  controllerNodeId: string,
): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.run(
    "UPDATE mesh_controller_grants SET grant_status = 'revoked', updated_at = ? WHERE controller_node_id = ?",
    [now, controllerNodeId],
  );
  if (result.changes === 0) {
    throw new Error(`Controller grant not found: ${controllerNodeId}`);
  }
  log.info("Revoked controller grant", { controllerNodeId });
}

export async function deleteRevokedControllerGrant(
  controllerNodeId: string,
): Promise<void> {
  const db = getDatabase();
  const result = db.run(
    "DELETE FROM mesh_controller_grants WHERE controller_node_id = ? AND grant_status = 'revoked'",
    [controllerNodeId],
  );
  if (result.changes === 0) {
    throw new Error(
      `Revoked controller grant not found: ${controllerNodeId}`,
    );
  }
  log.info("Deleted revoked controller grant", { controllerNodeId });
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface WorkerRegistrationRow {
  worker_node_id: string;
  local_user_id: string;
  worker_instance_name: string | null;
  worker_endpoint: string;
  worker_transport: string;
  worker_public_key: string;
  worker_fingerprint: string;
  worker_encryption_public_key: string | null;
  worker_directory: string | null;
  worker_capabilities_json: string | null;
  worker_accept_remote_execution: number;
  worker_config_revision: number;
  grant_status: string;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapWorkerRegistrationRow(
  row: WorkerRegistrationRow,
): MeshWorkerRegistration {
  let capabilities: ExecutionHostCapabilities | null = null;
  if (row.worker_capabilities_json) {
    try {
      capabilities = JSON.parse(row.worker_capabilities_json);
    } catch {
      log.warn("Invalid worker capabilities JSON", {
        workerNodeId: row.worker_node_id,
      });
    }
  }

  return {
    workerNodeId: row.worker_node_id,
    localUserId: row.local_user_id,
    workerInstanceName: row.worker_instance_name,
    workerEndpoint: row.worker_endpoint,
    workerTransport: row.worker_transport as MeshTransport,
    workerPublicKey: row.worker_public_key,
    workerFingerprint: row.worker_fingerprint,
    workerEncryptionPublicKey: row.worker_encryption_public_key,
    workerDirectory: row.worker_directory,
    workerCapabilities: capabilities,
    workerAcceptRemoteExecution: row.worker_accept_remote_execution === 1,
    workerConfigRevision: row.worker_config_revision,
    grantStatus: row.grant_status as MeshGrantStatus,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ControllerGrantRow {
  controller_node_id: string;
  controller_instance_name: string | null;
  controller_public_key: string;
  controller_fingerprint: string;
  controller_encryption_public_key: string | null;
  grant_status: string;
  created_at: string;
  updated_at: string;
}

function mapControllerGrantRow(
  row: ControllerGrantRow,
): MeshControllerGrant {
  return {
    controllerNodeId: row.controller_node_id,
    controllerInstanceName: row.controller_instance_name,
    controllerPublicKey: row.controller_public_key,
    controllerFingerprint: row.controller_fingerprint,
    controllerEncryptionPublicKey: row.controller_encryption_public_key,
    grantStatus: row.grant_status as MeshGrantStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
