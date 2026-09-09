/**
 * Shared contracts for the controller-worker mesh.
 *
 * Controllers are full UI-capable Clanky installations that enroll and
 * manage workers. Workers are headless execution channels that accept
 * signed operations from their enrolled controllers. A worker may hold
 * independent grants from multiple controllers; controllers never learn
 * about each other and never join as peers.
 *
 * These types intentionally contain no private keys or browser
 * authentication data.
 */

import type {
  ExecutionHostCapabilities,
  ExecutionNodeConfiguration,
} from "./execution-host";

export const MESH_TRANSPORTS = ["https", "http"] as const;
export type MeshTransport = (typeof MESH_TRANSPORTS)[number];
export const MESH_INSTANCE_NAME_MAX_LENGTH = 64;
export const MESH_WORKER_KILL_REQUEST_TTL_MS = 60_000;

export const MESH_GRANT_STATUSES = ["active", "revoked"] as const;
export type MeshGrantStatus = (typeof MESH_GRANT_STATUSES)[number];
export const MESH_WORKER_REGISTRATION_SCOPES = ["global", "workspace"] as const;
export type MeshWorkerRegistrationScope = (typeof MESH_WORKER_REGISTRATION_SCOPES)[number];

/** Public identity of a mesh node (controller or worker). */
export interface MeshNodeIdentity {
  nodeId: string;
  instanceName: string | null;
  meshEndpoint: string | null;
  publicKey: string;
  fingerprint: string;
  encryptionPublicKey?: string;
  execution: ExecutionNodeConfiguration;
  createdAt: string;
  updatedAt: string;
}

/**
 * Worker execution configuration. This is worker-owned and not remotely
 * configurable by any controller.
 */
export interface MeshWorkerExecutionConfig {
  directory: string;
  acceptRemoteExecution: boolean;
  capabilities: ExecutionHostCapabilities;
  revision: number;
}

/**
 * A controller's registration of an enrolled worker.
 * Stored on the controller side.
 */
export interface MeshWorkerRegistration {
  workerNodeId: string;
  workerInstanceName: string | null;
  workerEndpoint: string;
  workerTransport: MeshTransport;
  workerPublicKey: string;
  workerFingerprint: string;
  workerEncryptionPublicKey: string | null;
  workerTlsCertificate: string | null;
  workerTlsFingerprint: string | null;
  workerDirectory: string | null;
  workerCapabilities: ExecutionHostCapabilities | null;
  workerAcceptRemoteExecution: boolean;
  workerConfigRevision: number;
  registrationScope?: MeshWorkerRegistrationScope;
  workspaceWorkerEnrollmentId?: string | null;
  workspaceId?: string | null;
  grantStatus: MeshGrantStatus;
  localUserId: string;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A worker's independent grant from a single controller.
 * Stored on the worker side. Multiple controllers may independently
 * enroll the same worker; each grant is isolated.
 */
export interface MeshControllerGrant {
  controllerNodeId: string;
  controllerInstanceName: string | null;
  controllerPublicKey: string;
  controllerFingerprint: string;
  controllerEncryptionPublicKey: string | null;
  grantStatus: MeshGrantStatus;
  createdAt: string;
  updatedAt: string;
}

/** Aggregated mesh status for controllers. */
export interface MeshControllerStatus {
  node: MeshNodeIdentity;
  workers: MeshWorkerRegistration[];
}

/** Aggregated mesh status for workers. */
export interface MeshWorkerStatus {
  node: MeshNodeIdentity;
  execution: MeshWorkerExecutionConfig;
  controllerCount: number;
}

export type MeshStatusRecord = MeshControllerStatus | MeshWorkerStatus;

export function isMeshWorkerStatus(
  status: MeshStatusRecord,
): status is MeshWorkerStatus {
  return "controllerCount" in status;
}
