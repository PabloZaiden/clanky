/**
 * Controller-owned relay pairing and relay authorization persistence.
 */

import type { MeshRelayPeerIdentity } from "@/shared/mesh-relay";
import { normalizeMeshRelayOrigin } from "@/shared/mesh-relay";
import { getDatabase } from "./database";
import { InvalidMeshRelayRouteError } from "./errors";
import { getMeshNodeFingerprint } from "./mesh-node-identity";

export interface ControllerRelayPairing {
  relayUrl: string;
  relayPublicKey: string;
  relayFingerprint: string;
  controllerNodeId: string;
  controllerFingerprint: string;
  pairedAt: string;
  updatedAt: string;
}

export interface SaveControllerRelayPairingInput {
  relayUrl: string;
  relayPublicKey: string;
  relayFingerprint: string;
  controllerNodeId: string;
  controllerFingerprint: string;
}

interface ControllerRelayPairingRow {
  relay_url: string;
  relay_public_key: string;
  relay_fingerprint: string;
  controller_node_id: string;
  controller_fingerprint: string;
  paired_at: string;
  updated_at: string;
}

interface ActiveWorkerIdentityRow {
  worker_node_id: string;
  worker_public_key: string;
  worker_fingerprint: string;
  route_kind: string;
  relay_url: string | null;
  relay_fingerprint: string | null;
}

export interface ControllerRelayAuthorizationRoute {
  relayUrl: string;
  relayFingerprint: string;
}

export class InconsistentMeshWorkerIdentityError extends Error {
  readonly code = "mesh_worker_identity_inconsistent";

  constructor(readonly nodeId: string) {
    super(`Active Mesh worker registrations disagree for node "${nodeId}".`);
    this.name = "InconsistentMeshWorkerIdentityError";
  }
}

function mapPairing(row: ControllerRelayPairingRow): ControllerRelayPairing {
  return {
    relayUrl: row.relay_url,
    relayPublicKey: row.relay_public_key,
    relayFingerprint: row.relay_fingerprint,
    controllerNodeId: row.controller_node_id,
    controllerFingerprint: row.controller_fingerprint,
    pairedAt: row.paired_at,
    updatedAt: row.updated_at,
  };
}

export function getControllerRelayPairing(): ControllerRelayPairing | null {
  const row = getDatabase().query(`
    SELECT relay_url, relay_public_key, relay_fingerprint,
      controller_node_id, controller_fingerprint, paired_at, updated_at
    FROM mesh_controller_relay_pairing
    WHERE singleton = 1
  `).get() as ControllerRelayPairingRow | null;
  return row ? mapPairing(row) : null;
}

export function saveControllerRelayPairing(
  input: SaveControllerRelayPairingInput,
): ControllerRelayPairing {
  const database = getDatabase();
  const relayUrl = normalizeMeshRelayOrigin(input.relayUrl);
  const existing = getControllerRelayPairing();
  const now = new Date().toISOString();
  const pairedAt = existing
    && existing.relayUrl === relayUrl
    && existing.relayFingerprint === input.relayFingerprint
    ? existing.pairedAt
    : now;
  database.query(`
    INSERT INTO mesh_controller_relay_pairing (
      singleton, relay_url, relay_public_key, relay_fingerprint,
      controller_node_id, controller_fingerprint, paired_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      relay_url = excluded.relay_url,
      relay_public_key = excluded.relay_public_key,
      relay_fingerprint = excluded.relay_fingerprint,
      controller_node_id = excluded.controller_node_id,
      controller_fingerprint = excluded.controller_fingerprint,
      paired_at = excluded.paired_at,
      updated_at = excluded.updated_at
  `).run(
    relayUrl,
    input.relayPublicKey,
    input.relayFingerprint,
    input.controllerNodeId,
    input.controllerFingerprint,
    pairedAt,
    now,
  );
  return {
    ...input,
    relayUrl,
    pairedAt,
    updatedAt: now,
  };
}

export function restoreControllerRelayPairing(
  pairing: ControllerRelayPairing,
): void {
  getDatabase().query(`
    INSERT INTO mesh_controller_relay_pairing (
      singleton, relay_url, relay_public_key, relay_fingerprint,
      controller_node_id, controller_fingerprint, paired_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      relay_url = excluded.relay_url,
      relay_public_key = excluded.relay_public_key,
      relay_fingerprint = excluded.relay_fingerprint,
      controller_node_id = excluded.controller_node_id,
      controller_fingerprint = excluded.controller_fingerprint,
      paired_at = excluded.paired_at,
      updated_at = excluded.updated_at
  `).run(
    pairing.relayUrl,
    pairing.relayPublicKey,
    pairing.relayFingerprint,
    pairing.controllerNodeId,
    pairing.controllerFingerprint,
    pairing.pairedAt,
    pairing.updatedAt,
  );
}

export function deleteControllerRelayPairing(): void {
  getDatabase().query(
    "DELETE FROM mesh_controller_relay_pairing WHERE singleton = 1",
  ).run();
}

/**
 * Enforce the controller-wide worker identity invariant before a registration
 * is written. Exact duplicates across owners are valid; reusing a node id,
 * public key, or fingerprint for different identity material is not.
 */
export function assertActiveControllerWorkerIdentity(
  identity: MeshRelayPeerIdentity,
): void {
  const rows = getDatabase().query(`
    SELECT worker_node_id, worker_public_key, worker_fingerprint,
      route_kind, relay_url, relay_fingerprint
    FROM mesh_worker_registrations
    WHERE grant_status = 'active'
      AND (
        worker_node_id = ?
        OR worker_public_key = ?
        OR worker_fingerprint = ?
      )
  `).all(
    identity.nodeId,
    identity.publicKey,
    identity.fingerprint,
  ) as ActiveWorkerIdentityRow[];
  if (rows.some((row) => (
    row.worker_node_id !== identity.nodeId
    || row.worker_public_key !== identity.publicKey
    || row.worker_fingerprint !== identity.fingerprint
  ))) {
    throw new InconsistentMeshWorkerIdentityError(identity.nodeId);
  }
}

/**
 * Return active workers routed through the controller's paired relay. Global
 * identity invariants are checked across every active registration before
 * non-matching direct or relay routes are omitted.
 */
export function listActiveControllerWorkerIdentities(
  route: ControllerRelayAuthorizationRoute,
): MeshRelayPeerIdentity[] {
  const rows = getDatabase().query(`
    SELECT worker_node_id, worker_public_key, worker_fingerprint,
      route_kind, relay_url, relay_fingerprint
    FROM mesh_worker_registrations
    WHERE grant_status = 'active'
    ORDER BY worker_node_id, worker_fingerprint, worker_public_key
  `).all() as ActiveWorkerIdentityRow[];
  const byNodeId = new Map<string, MeshRelayPeerIdentity>();
  const byFingerprint = new Map<string, MeshRelayPeerIdentity>();
  const matching = new Map<string, MeshRelayPeerIdentity>();
  for (const row of rows) {
    if (
      row.route_kind === "relay"
      && (!row.relay_url || !row.relay_fingerprint)
    ) {
      throw new InvalidMeshRelayRouteError("worker", row.worker_node_id);
    }
    const identity: MeshRelayPeerIdentity = {
      nodeId: row.worker_node_id,
      publicKey: row.worker_public_key,
      fingerprint: row.worker_fingerprint,
    };
    const exactKey = JSON.stringify([
      identity.nodeId,
      identity.publicKey,
      identity.fingerprint,
    ]);
    const existing = byNodeId.get(identity.nodeId);
    if (
      existing
      && (
        existing.publicKey !== identity.publicKey
        || existing.fingerprint !== identity.fingerprint
      )
    ) {
      throw new InconsistentMeshWorkerIdentityError(identity.nodeId);
    }
    const fingerprintOwner = byFingerprint.get(identity.fingerprint);
    if (
      fingerprintOwner
      && (
        fingerprintOwner.nodeId !== identity.nodeId
        || fingerprintOwner.publicKey !== identity.publicKey
      )
    ) {
      throw new InconsistentMeshWorkerIdentityError(identity.nodeId);
    }
    let derivedFingerprint: string;
    try {
      derivedFingerprint = getMeshNodeFingerprint(identity.publicKey);
    } catch {
      throw new InconsistentMeshWorkerIdentityError(identity.nodeId);
    }
    if (derivedFingerprint !== identity.fingerprint) {
      throw new InconsistentMeshWorkerIdentityError(identity.nodeId);
    }
    byNodeId.set(identity.nodeId, identity);
    byFingerprint.set(identity.fingerprint, identity);
    if (
      row.route_kind === "relay"
      && row.relay_url === route.relayUrl
      && row.relay_fingerprint === route.relayFingerprint
    ) {
      matching.set(exactKey, identity);
    }
  }
  return [...matching.values()];
}
