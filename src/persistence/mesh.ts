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
  MeshPeerRoute,
  MeshTransport,
  MeshWorkerRegistration,
} from "@/shared/mesh";
import {
  type ExecutionHostBinding,
  type ExecutionHostCapabilities,
  type ExecutionHostRef,
} from "@/shared/execution-host";
import {
  deleteExecutionHost,
  ensureExecutionHost,
  getExecutionHostByRef,
  revokeExecutionHost,
} from "./execution-hosts";
import {
  buildMeshEnrollmentTargetKey,
  buildMeshTargetKey,
  buildMeshWorkspaceTargetKey,
} from "./workspace-target-key";
import { getDatabase } from "./database";
import { InvalidMeshRelayRouteError } from "./errors";
import { assertActiveControllerWorkerIdentity } from "./controller-relay-pairing";

const log = createLogger("persistence:mesh");
const MAX_MESH_WORKER_KILL_NONCES = 256;

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
  workerTlsCertificate: string | null;
  workerTlsFingerprint: string | null;
  route?: MeshPeerRoute;
  workerDirectory: string | null;
  workerCapabilities: ExecutionHostCapabilities | null;
  workerAcceptRemoteExecution: boolean;
  workerConfigRevision: number;
  registrationScope?: "global" | "workspace";
  workspaceWorkerEnrollmentId?: string;
  workspaceId?: string;
}

export function getWorkerRegistrationExecutionHostRef(
  registration: Pick<
    MeshWorkerRegistration,
    "workerNodeId" | "registrationScope" | "workspaceWorkerEnrollmentId" | "workspaceId"
  >,
): ExecutionHostRef {
  if (registration.registrationScope === "workspace") {
    if (registration.workspaceId) {
      return {
        kind: "mesh",
        scope: "workspace",
        workspaceId: registration.workspaceId,
        nodeId: registration.workerNodeId,
      };
    }
    if (registration.workspaceWorkerEnrollmentId) {
      return {
        kind: "mesh",
        scope: "enrollment",
        enrollmentId: registration.workspaceWorkerEnrollmentId,
        nodeId: registration.workerNodeId,
      };
    }
  }
  return { kind: "mesh", nodeId: registration.workerNodeId };
}

function getWorkerRegistrationTargetKey(
  input: Pick<
    SaveWorkerRegistrationInput,
    "workerNodeId" | "registrationScope" | "workspaceWorkerEnrollmentId" | "workspaceId"
  >,
): string {
  if (input.registrationScope === "workspace") {
    if (input.workspaceId) {
      return buildMeshWorkspaceTargetKey(input.workspaceId, input.workerNodeId);
    }
    if (input.workspaceWorkerEnrollmentId) {
      return buildMeshEnrollmentTargetKey(
        input.workspaceWorkerEnrollmentId,
        input.workerNodeId,
      );
    }
  }
  return buildMeshTargetKey(input.workerNodeId);
}

export async function saveWorkerRegistration(
  input: SaveWorkerRegistrationInput,
): Promise<MeshWorkerRegistration> {
  const db = getDatabase();
  const now = new Date().toISOString();
  const route: MeshPeerRoute = input.route ?? {
    kind: "direct",
    endpoint: input.workerEndpoint,
    transport: input.workerTransport,
    tlsTrust: input.workerTransport === "https" ? "pinned" : "none",
    tlsCertificate: input.workerTlsCertificate,
    tlsFingerprint: input.workerTlsFingerprint,
  };
  assertActiveControllerWorkerIdentity({
    nodeId: input.workerNodeId,
    publicKey: input.workerPublicKey,
    fingerprint: input.workerFingerprint,
  });

  db.run(
    `INSERT INTO mesh_worker_registrations (
      worker_node_id, local_user_id, worker_instance_name,
      worker_endpoint, worker_transport,
      worker_public_key, worker_fingerprint, worker_encryption_public_key,
      worker_tls_certificate, worker_tls_fingerprint,
      route_kind, relay_url, relay_fingerprint,
      worker_directory, worker_capabilities_json,
      worker_accept_remote_execution,       worker_config_revision, registration_scope,
      workspace_worker_enrollment_id, workspace_id,
      grant_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(local_user_id, worker_node_id) DO UPDATE SET
      worker_instance_name = excluded.worker_instance_name,
      worker_endpoint = excluded.worker_endpoint,
      worker_transport = excluded.worker_transport,
      worker_public_key = excluded.worker_public_key,
      worker_fingerprint = excluded.worker_fingerprint,
      worker_encryption_public_key = excluded.worker_encryption_public_key,
      worker_tls_certificate = excluded.worker_tls_certificate,
      worker_tls_fingerprint = excluded.worker_tls_fingerprint,
      route_kind = excluded.route_kind,
      relay_url = excluded.relay_url,
      relay_fingerprint = excluded.relay_fingerprint,
      worker_directory = excluded.worker_directory,
      worker_capabilities_json = excluded.worker_capabilities_json,
      worker_accept_remote_execution = excluded.worker_accept_remote_execution,
      worker_config_revision = excluded.worker_config_revision,
      registration_scope = excluded.registration_scope,
      workspace_worker_enrollment_id = excluded.workspace_worker_enrollment_id,
      workspace_id = excluded.workspace_id,
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
      input.workerTlsCertificate,
      input.workerTlsFingerprint,
      route.kind,
      route.kind === "relay" ? route.relayUrl : null,
      route.kind === "relay" ? route.relayFingerprint : null,
      input.workerDirectory,
      input.workerCapabilities ? JSON.stringify(input.workerCapabilities) : null,
      input.workerAcceptRemoteExecution ? 1 : 0,
      input.workerConfigRevision,
      input.registrationScope ?? "global",
      input.workspaceWorkerEnrollmentId ?? null,
      input.workspaceId ?? null,
      now,
      now,
    ],
  );

  // Ensure the worker's canonical host exists, but keep dedicated hosts
  // scoped to their enrollment or workspace instead of global discovery.
  ensureExecutionHost(
    input.localUserId,
    getWorkerRegistrationExecutionHostRef({
      workerNodeId: input.workerNodeId,
      registrationScope: input.registrationScope ?? "global",
      workspaceWorkerEnrollmentId: input.workspaceWorkerEnrollmentId ?? null,
      workspaceId: input.workspaceId ?? null,
    }),
    getWorkerRegistrationTargetKey({
      workerNodeId: input.workerNodeId,
      registrationScope: input.registrationScope ?? "global",
      workspaceWorkerEnrollmentId: input.workspaceWorkerEnrollmentId,
      workspaceId: input.workspaceId,
    }),
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

export function getWorkerRegistration(
  workerNodeId: string,
  localUserId: string,
): MeshWorkerRegistration | null {
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
  return mapValidWorkerRegistrationRows(rows);
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
  return mapValidWorkerRegistrationRows(rows);
}

export async function listGloballyDiscoverableWorkerRegistrations(
  localUserId: string,
): Promise<MeshWorkerRegistration[]> {
  const db = getDatabase();
  const rows = db
    .query(
      "SELECT * FROM mesh_worker_registrations WHERE local_user_id = ? AND grant_status = 'active' AND registration_scope = 'global' ORDER BY created_at ASC",
    )
    .all(localUserId) as WorkerRegistrationRow[];
  return mapValidWorkerRegistrationRows(rows);
}

export async function revokeWorkerRegistration(
  workerNodeId: string,
  localUserId: string,
): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    const row = db
      .query("SELECT * FROM mesh_worker_registrations WHERE worker_node_id = ? AND local_user_id = ?")
      .get(workerNodeId, localUserId) as WorkerRegistrationRow | null;
    if (!row) {
      throw new Error(`Worker registration not found: ${workerNodeId}`);
    }
    const host = getExecutionHostByRef(
      localUserId,
      getWorkerRegistrationExecutionHostRef({
        workerNodeId: row.worker_node_id,
        registrationScope: row.registration_scope === "workspace"
          ? "workspace"
          : "global",
        workspaceWorkerEnrollmentId: row.workspace_worker_enrollment_id,
        workspaceId: row.workspace_id,
      }),
    );
    const result = db.run(
      "UPDATE mesh_worker_registrations SET grant_status = 'revoked', updated_at = ? WHERE worker_node_id = ? AND local_user_id = ?",
      [now, workerNodeId, localUserId],
    );
    if (result.changes === 0) {
      throw new Error(`Worker registration not found: ${workerNodeId}`);
    }

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
  const row = db
    .query(
      "SELECT * FROM mesh_worker_registrations WHERE worker_node_id = ? AND local_user_id = ? AND grant_status = 'revoked'",
    )
    .get(workerNodeId, localUserId) as WorkerRegistrationRow | null;
  if (!row) {
    log.debug("Revoked worker registration was already removed", { workerNodeId });
    return;
  }
  const host = getExecutionHostByRef(
    localUserId,
    getWorkerRegistrationExecutionHostRef({
      workerNodeId: row.worker_node_id,
      registrationScope: row.registration_scope === "workspace"
        ? "workspace"
        : "global",
      workspaceWorkerEnrollmentId: row.workspace_worker_enrollment_id,
      workspaceId: row.workspace_id,
    }),
  );
  const result = db.run(
    "DELETE FROM mesh_worker_registrations WHERE worker_node_id = ? AND local_user_id = ? AND grant_status = 'revoked'",
    [workerNodeId, localUserId],
  );
  if (result.changes > 0 && row.registration_scope === "workspace" && host) {
    deleteExecutionHost(localUserId, host.id);
  }
  log.info("Deleted revoked worker registration", { workerNodeId });
}

export function getWorkerRegistrationByEnrollment(
  enrollmentId: string,
  localUserId: string,
): MeshWorkerRegistration | null {
  const row = getDatabase()
    .query(
      "SELECT * FROM mesh_worker_registrations WHERE workspace_worker_enrollment_id = ? AND local_user_id = ?",
    )
    .get(enrollmentId, localUserId) as WorkerRegistrationRow | null;
  return row ? mapWorkerRegistrationRow(row) : null;
}

export function getWorkerRegistrationByWorkspace(
  workspaceId: string,
  localUserId: string,
): MeshWorkerRegistration | null {
  const row = getDatabase()
    .query(
      "SELECT * FROM mesh_worker_registrations WHERE workspace_id = ? AND local_user_id = ?",
    )
    .get(workspaceId, localUserId) as WorkerRegistrationRow | null;
  return row ? mapWorkerRegistrationRow(row) : null;
}

export function updateWorkerRegistrationEndpoint(input: {
  workerNodeId: string;
  localUserId: string;
  workerEndpoint: string;
}): MeshWorkerRegistration {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE mesh_worker_registrations
     SET worker_endpoint = ?, updated_at = ?
     WHERE worker_node_id = ? AND local_user_id = ?
       AND registration_scope = 'workspace' AND grant_status = 'active'`,
    [
      input.workerEndpoint,
      now,
      input.workerNodeId,
      input.localUserId,
    ],
  );
  if (result.changes === 0) {
    throw new Error(`Active workspace worker registration not found: ${input.workerNodeId}`);
  }
  const registration = getWorkerRegistration(input.workerNodeId, input.localUserId);
  if (!registration) {
    throw new Error(`Worker registration not found after endpoint update: ${input.workerNodeId}`);
  }
  return registration;
}

export function moveDedicatedWorkerToWorkspace(input: {
  workerNodeId: string;
  localUserId: string;
  enrollmentId: string;
  workspaceId: string;
}): ExecutionHostBinding {
  const db = getDatabase();
  const registration = getWorkerRegistration(
    input.workerNodeId,
    input.localUserId,
  );
  if (!registration
    || registration.registrationScope !== "workspace"
    || registration.workspaceWorkerEnrollmentId !== input.enrollmentId
    || registration.grantStatus !== "active") {
    throw new Error(`Dedicated worker registration not found: ${input.workerNodeId}`);
  }

  const enrollmentRef = getWorkerRegistrationExecutionHostRef(registration);
  const workspaceRef: ExecutionHostRef = {
    kind: "mesh",
    scope: "workspace",
    workspaceId: input.workspaceId,
    nodeId: input.workerNodeId,
  };
  const workspaceHost = ensureExecutionHost(
    input.localUserId,
    workspaceRef,
    buildMeshWorkspaceTargetKey(input.workspaceId, input.workerNodeId),
  );
  const oldHost = getExecutionHostByRef(input.localUserId, enrollmentRef);
  const txn = db.transaction(() => {
    db.run(
      `UPDATE mesh_worker_registrations
       SET workspace_id = ?, updated_at = ?
       WHERE worker_node_id = ? AND local_user_id = ?`,
      [
        input.workspaceId,
        new Date().toISOString(),
        input.workerNodeId,
        input.localUserId,
      ],
    );
    if (oldHost && oldHost.id !== workspaceHost.id) {
      revokeExecutionHost(input.localUserId, oldHost.id);
    }
  });
  txn();
  return {
    host: workspaceHost.ref,
    targetKey: workspaceHost.targetKey,
    revision: workspaceHost.revision,
  };
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
  controllerRoute?: MeshPeerRoute | null;
}

export class InconsistentMeshControllerRelayGrantError extends Error {
  constructor(readonly controllerNodeId: string) {
    super("A worker may have only one active relay controller association.");
    this.name = "InconsistentMeshControllerRelayGrantError";
  }
}

export async function saveControllerGrant(
  input: SaveControllerGrantInput,
): Promise<MeshControllerGrant> {
  const db = getDatabase();
  const now = new Date().toISOString();

  const save = db.transaction(() => {
    if (input.controllerRoute?.kind === "relay") {
      const conflicting = db.query(`
        SELECT controller_node_id
        FROM mesh_controller_grants
        WHERE grant_status = 'active'
          AND route_kind = 'relay'
          AND controller_node_id <> ?
        LIMIT 1
      `).get(input.controllerNodeId) as { controller_node_id: string } | null;
      if (conflicting) {
        throw new InconsistentMeshControllerRelayGrantError(
          conflicting.controller_node_id,
        );
      }
    }
    db.run(
      `INSERT INTO mesh_controller_grants (
      controller_node_id, controller_instance_name,
      controller_public_key, controller_fingerprint,
      controller_encryption_public_key,
      controller_endpoint, route_kind, relay_url, relay_fingerprint,
      grant_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(controller_node_id) DO UPDATE SET
      controller_instance_name = excluded.controller_instance_name,
      controller_public_key = excluded.controller_public_key,
      controller_fingerprint = excluded.controller_fingerprint,
      controller_encryption_public_key = excluded.controller_encryption_public_key,
      controller_endpoint = excluded.controller_endpoint,
      route_kind = excluded.route_kind,
      relay_url = excluded.relay_url,
      relay_fingerprint = excluded.relay_fingerprint,
      grant_status = 'active',
      updated_at = excluded.updated_at`,
      [
        input.controllerNodeId,
        input.controllerInstanceName,
        input.controllerPublicKey,
        input.controllerFingerprint,
        input.controllerEncryptionPublicKey,
        input.controllerRoute?.kind === "direct"
          ? input.controllerRoute.endpoint
          : null,
        input.controllerRoute?.kind ?? "direct",
        input.controllerRoute?.kind === "relay"
          ? input.controllerRoute.relayUrl
          : null,
        input.controllerRoute?.kind === "relay"
          ? input.controllerRoute.relayFingerprint
          : null,
        now,
        now,
      ],
    );
  });
  save();

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

/**
 * Atomically claim a worker-kill nonce until its signed request expires.
 *
 * The ledger is persisted on workers so a supervisor restart cannot make a
 * captured, still-valid kill envelope usable a second time.
 */
export type MeshWorkerKillNonceClaim = "claimed" | "replay" | "capacity";

export function claimMeshWorkerKillNonce(
  nonce: string,
  expiresAt: string,
): MeshWorkerKillNonceClaim {
  const db = getDatabase();
  const now = new Date().toISOString();
  const claim = db.transaction(() => {
    db.run(
      "DELETE FROM mesh_worker_kill_nonces WHERE expires_at <= ?",
      [now],
    );
    if (db.query("SELECT 1 FROM mesh_worker_kill_nonces WHERE nonce = ?").get(nonce)) {
      return "replay" as const;
    }
    const count = db
      .query("SELECT COUNT(*) AS count FROM mesh_worker_kill_nonces")
      .get() as { count: number };
    if (count.count >= MAX_MESH_WORKER_KILL_NONCES) {
      return "capacity" as const;
    }
    const result = db.run(
      `INSERT INTO mesh_worker_kill_nonces (nonce, expires_at)
       VALUES (?, ?)
       ON CONFLICT(nonce) DO NOTHING`,
      [nonce, expiresAt],
    );
    return result.changes === 1 ? "claimed" as const : "replay" as const;
  });
  return claim();
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
  worker_tls_certificate: string | null;
  worker_tls_fingerprint: string | null;
  route_kind: string;
  relay_url: string | null;
  relay_fingerprint: string | null;
  worker_directory: string | null;
  worker_capabilities_json: string | null;
  worker_accept_remote_execution: number;
  worker_config_revision: number;
  registration_scope: string;
  workspace_worker_enrollment_id: string | null;
  workspace_id: string | null;
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
  let route: MeshPeerRoute;
  if (row.route_kind === "relay") {
    if (!row.relay_url || !row.relay_fingerprint) {
      throw new InvalidMeshRelayRouteError("worker", row.worker_node_id);
    }
    route = {
      kind: "relay",
      targetNodeId: row.worker_node_id,
      relayUrl: row.relay_url,
      relayFingerprint: row.relay_fingerprint,
    };
  } else {
    route = {
      kind: "direct",
      endpoint: row.worker_endpoint,
      transport: row.worker_transport as MeshTransport,
      tlsTrust: row.worker_transport === "https" ? "pinned" : "none",
      tlsCertificate: row.worker_tls_certificate,
      tlsFingerprint: row.worker_tls_fingerprint,
    };
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
    workerTlsCertificate: row.worker_tls_certificate,
    workerTlsFingerprint: row.worker_tls_fingerprint,
    route,
    workerDirectory: row.worker_directory,
    workerCapabilities: capabilities,
    workerAcceptRemoteExecution: row.worker_accept_remote_execution === 1,
    workerConfigRevision: row.worker_config_revision,
    registrationScope: row.registration_scope === "workspace" ? "workspace" : "global",
    workspaceWorkerEnrollmentId: row.workspace_worker_enrollment_id,
    workspaceId: row.workspace_id,
    grantStatus: row.grant_status as MeshGrantStatus,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapValidWorkerRegistrationRows(
  rows: WorkerRegistrationRow[],
): MeshWorkerRegistration[] {
  const registrations: MeshWorkerRegistration[] = [];
  for (const row of rows) {
    try {
      registrations.push(mapWorkerRegistrationRow(row));
    } catch (error) {
      if (!(error instanceof InvalidMeshRelayRouteError)) {
        throw error;
      }
      log.error("Skipping worker registration with an invalid relay route", {
        workerNodeId: row.worker_node_id,
        localUserId: row.local_user_id,
      });
    }
  }
  return registrations;
}

interface ControllerGrantRow {
  controller_node_id: string;
  controller_instance_name: string | null;
  controller_public_key: string;
  controller_fingerprint: string;
  controller_encryption_public_key: string | null;
  controller_endpoint: string | null;
  route_kind: string;
  relay_url: string | null;
  relay_fingerprint: string | null;
  grant_status: string;
  created_at: string;
  updated_at: string;
}

function mapControllerGrantRow(
  row: ControllerGrantRow,
): MeshControllerGrant {
  let controllerRoute: MeshPeerRoute | null;
  if (row.route_kind === "relay") {
    if (!row.relay_url || !row.relay_fingerprint) {
      throw new InvalidMeshRelayRouteError("controller", row.controller_node_id);
    }
    controllerRoute = {
      kind: "relay",
      targetNodeId: row.controller_node_id,
      relayUrl: row.relay_url,
      relayFingerprint: row.relay_fingerprint,
    };
  } else {
    controllerRoute = row.controller_endpoint
      ? {
        kind: "direct",
        endpoint: row.controller_endpoint,
        transport: row.controller_endpoint.startsWith("https:")
          ? "https"
          : "http",
        tlsTrust: row.controller_endpoint.startsWith("https:")
          ? "system"
          : "none",
        tlsCertificate: null,
        tlsFingerprint: null,
      }
      : null;
  }
  return {
    controllerNodeId: row.controller_node_id,
    controllerInstanceName: row.controller_instance_name,
    controllerPublicKey: row.controller_public_key,
    controllerFingerprint: row.controller_fingerprint,
    controllerEncryptionPublicKey: row.controller_encryption_public_key,
    controllerRoute,
    grantStatus: row.grant_status as MeshGrantStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
