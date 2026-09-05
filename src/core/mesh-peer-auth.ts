/**
 * Grant-based peer authentication for the controller-worker mesh.
 *
 * On a worker: incoming requests are authenticated against active controller
 * grants. On a controller: outbound connections verify against stored worker
 * registrations. No links, no members, no roster.
 */

import type { MeshControllerGrant, MeshWorkerRegistration } from "@/shared/mesh";
import {
  getControllerGrant,
  getWorkerRegistration,
} from "../persistence/mesh";
import { getMeshNodeFingerprint } from "../persistence/mesh-node-identity";
import { DomainError } from "./domain-error";

export interface TrustedController {
  grant: MeshControllerGrant;
}

export interface TrustedWorker {
  registration: MeshWorkerRegistration;
}

export function assertMeshPeerIdentity(
  publicKey: string,
  fingerprint: string,
  context = "mesh peer",
): void {
  let derivedFingerprint: string;
  try {
    derivedFingerprint = getMeshNodeFingerprint(publicKey);
  } catch (error) {
    throw new DomainError("mesh_peer_identity_invalid", `The ${context} public key is invalid.`, {
      cause: error,
    });
  }
  if (derivedFingerprint !== fingerprint) {
    throw new DomainError(
      "mesh_peer_identity_mismatch",
      `The ${context} fingerprint does not match its public key.`,
    );
  }
}

/**
 * Verify an inbound request from a controller (worker side).
 * Checks that the caller has an active controller grant with matching identity.
 */
export async function requireTrustedController(options: {
  controllerNodeId: string;
  publicKey: string;
  fingerprint: string;
  encryptionPublicKey?: string;
  requireEncryptionKey?: boolean;
  context?: string;
}): Promise<TrustedController> {
  const context = options.context ?? "controller";
  assertMeshPeerIdentity(options.publicKey, options.fingerprint, context);

  const grant = await getControllerGrant(options.controllerNodeId);
  if (!grant || grant.grantStatus !== "active") {
    throw new DomainError(
      "mesh_peer_not_trusted",
      `The ${context} does not have an active grant on this worker.`,
    );
  }
  if (
    grant.controllerPublicKey !== options.publicKey
    || grant.controllerFingerprint !== options.fingerprint
  ) {
    throw new DomainError(
      "mesh_peer_not_trusted",
      `The ${context} identity does not match the stored grant.`,
    );
  }
  if (
    grant.controllerEncryptionPublicKey
    && options.requireEncryptionKey !== false
    && (!options.encryptionPublicKey || grant.controllerEncryptionPublicKey !== options.encryptionPublicKey)
  ) {
    throw new DomainError(
      "mesh_peer_not_trusted",
      `The ${context} encryption identity does not match the stored grant.`,
    );
  }

  return { grant };
}

/**
 * Verify a target worker registration (controller side).
 * Used before initiating outbound connections.
 */
export async function requireTrustedWorker(options: {
  workerNodeId: string;
  localUserId: string;
  context?: string;
}): Promise<TrustedWorker> {
  const context = options.context ?? "worker";

  const registration = await getWorkerRegistration(
    options.workerNodeId,
    options.localUserId,
  );
  if (!registration || registration.grantStatus !== "active") {
    throw new DomainError(
      "mesh_peer_not_trusted",
      `The ${context} does not have an active registration.`,
    );
  }

  return { registration };
}
