/**
 * Public protocol contracts for the transport-only Mesh relay.
 */

import {
  type MeshProtocolVersion,
  type MeshProtocolMetadata,
} from "./mesh-protocol";

// This admission token format is part of the deployed v5 relay contract. It
// is not a Mesh wire-generation selector.
export const MESH_RELAY_ENROLLMENT_ADMISSION_VERSION = 1 as const;
export const MESH_RELAY_MAX_AUTHORIZED_WORKERS = 1_000;
export const MESH_RELAY_MAX_AUTHORIZATION_STAGED_BYTES = 4 * 1_024 * 1_024;
export const MESH_RELAY_DESCRIPTOR_PATH = "/.well-known/clanky-mesh";
export const MESH_RELAY_CONTROL_PATH = "/api/mesh/relay/control";
export const MESH_RELAY_STREAM_PATH = "/api/mesh/relay/stream";
export const MESH_RELAY_CONTROL_CLOSE_REPLACED = 4409;

export type MeshRelayPeerRole = "controller" | "worker";
export type MeshRelayWorkerStatus = "pending" | "authorized";
export type MeshRelayStreamKind = "http" | "socket";

export interface MeshRelayPeerIdentity {
  nodeId: string;
  publicKey: string;
  fingerprint: string;
}

export interface MeshRelayEnrollmentAdmission {
  version: typeof MESH_RELAY_ENROLLMENT_ADMISSION_VERSION;
  controllerNodeId: string;
  controllerFingerprint: string;
  nonce: string;
  expiresAt: string;
  signature: string;
}

export interface MeshRelayWellKnownDescriptor extends MeshProtocolMetadata {
  role: "relay";
  protocolVersion: MeshProtocolVersion;
  publicKey: string;
  fingerprint: string;
  controllerFingerprint: string;
  controllerNodeId: string | null;
  controllerSupportedProtocolVersions?: MeshProtocolVersion[];
}

export interface MeshControllerWellKnownDescriptor extends MeshProtocolMetadata {
  role: "controller";
  protocolVersion: MeshProtocolVersion;
  nodeId: string;
  publicKey: string;
  fingerprint: string;
}

export type MeshWellKnownDescriptor =
  | MeshRelayWellKnownDescriptor
  | MeshControllerWellKnownDescriptor;

type V5Descriptor<T> = Omit<T, "protocolVersion" | "supportedProtocolVersions" | "preferredProtocolVersion" | "negotiatedProtocolVersion" | "controllerSupportedProtocolVersions"> & {
  protocolVersion: 5;
  supportedProtocolVersions: [5];
  preferredProtocolVersion: 5;
  negotiatedProtocolVersion: 5 | null;
};
export type MeshRelayWellKnownDescriptorV5 = V5Descriptor<MeshRelayWellKnownDescriptor>;
export type MeshControllerWellKnownDescriptorV5 = V5Descriptor<MeshControllerWellKnownDescriptor>;

export function isMeshRelayLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet)
      && Number(octet) >= 0
      && Number(octet) <= 255);
}

export function normalizeMeshRelayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Relay URL must be a valid absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Relay URL must use HTTP or HTTPS.");
  }
  if (
    url.protocol === "http:"
    && !isMeshRelayLoopbackHostname(url.hostname)
  ) {
    throw new Error("Remote relay URLs must use HTTPS.");
  }
  if (
    url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error(
      "Relay URL must be an absolute HTTP(S) origin without credentials, a path, a query, or a fragment.",
    );
  }
  return url.origin;
}

export interface MeshRelayChallengeFrame {
  protocolVersion: MeshProtocolVersion;
  type: "challenge";
  challengeId: string;
  nonce: string;
  relayPublicKey: string;
  relayFingerprint: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export interface MeshRelayAuthFrame {
  protocolVersion: MeshProtocolVersion;
  type: "auth";
  role: MeshRelayPeerRole;
  nodeId: string;
  publicKey: string;
  fingerprint: string;
  challengeId: string;
  nonce: string;
  relayFingerprint: string;
  expiresAt: string;
  enrollmentAdmission?: string;
  signature: string;
}

export interface MeshRelayAuthOkFrame {
  protocolVersion: MeshProtocolVersion;
  type: "auth.ok";
  connectionId: string;
  role: MeshRelayPeerRole;
  nodeId: string;
  workerStatus?: MeshRelayWorkerStatus;
}

export interface MeshRelayAuthorizationBeginFrame {
  protocolVersion: MeshProtocolVersion;
  type: "authorization.begin";
  transactionId: string;
  workerCount: number;
  identityBytes: number;
}

export interface MeshRelayAuthorizationChunkFrame {
  protocolVersion: MeshProtocolVersion;
  type: "authorization.chunk";
  transactionId: string;
  workers: MeshRelayPeerIdentity[];
}

export interface MeshRelayAuthorizationCommitFrame {
  protocolVersion: MeshProtocolVersion;
  type: "authorization.commit";
  transactionId: string;
}

export interface MeshRelayAuthorizationAckFrame {
  protocolVersion: MeshProtocolVersion;
  type: "authorization.ack";
  transactionId: string;
  workerCount: number;
}

export interface MeshRelayStreamRequestFrame {
  protocolVersion: MeshProtocolVersion;
  type: "stream.request";
  requestId: string;
  targetNodeId: string;
  kind: MeshRelayStreamKind;
  method?: string;
  path: string;
  headers: Record<string, string>;
}

export interface MeshRelayStreamCancelFrame {
  protocolVersion: MeshProtocolVersion;
  type: "stream.cancel";
  requestId: string;
}

export interface MeshRelayStreamTicketFrame {
  protocolVersion: MeshProtocolVersion;
  type: "stream.ticket";
  requestId: string;
  streamId: string;
  ticket: string;
  credential: string;
  expiresAt: string;
}

export interface MeshRelayStreamOfferFrame {
  protocolVersion: MeshProtocolVersion;
  type: "stream.offer";
  requestId: string;
  streamId: string;
  ticket: string;
  credential: string;
  expiresAt: string;
  initiatorNodeId: string;
  kind: MeshRelayStreamKind;
  method?: string;
  path: string;
  headers: Record<string, string>;
}

export interface MeshRelayStreamReadyFrame {
  protocolVersion: MeshProtocolVersion;
  type: "stream.ready";
  requestId: string;
  streamId: string;
}

export interface MeshRelayStreamStatusFrame {
  protocolVersion: MeshProtocolVersion;
  type: "stream.status";
  streamId: string;
  status: number;
}

export interface MeshRelayControlErrorFrame {
  protocolVersion: MeshProtocolVersion;
  type: "stream.error";
  requestId: string;
  code: string;
  message: string;
  status: number;
}

export interface MeshRelayHeartbeatFrame {
  protocolVersion: MeshProtocolVersion;
  type: "heartbeat";
  sentAt: string;
}

export interface MeshRelayPongFrame {
  protocolVersion: MeshProtocolVersion;
  type: "pong";
  sentAt: string;
}

export type MeshRelayClientControlFrame =
  | MeshRelayAuthFrame
  | MeshRelayAuthorizationBeginFrame
  | MeshRelayAuthorizationChunkFrame
  | MeshRelayAuthorizationCommitFrame
  | MeshRelayStreamRequestFrame
  | MeshRelayStreamCancelFrame
  | MeshRelayStreamStatusFrame
  | MeshRelayPongFrame;

export type MeshRelayServerControlFrame =
  | MeshRelayChallengeFrame
  | MeshRelayAuthOkFrame
  | MeshRelayAuthorizationAckFrame
  | MeshRelayStreamTicketFrame
  | MeshRelayStreamOfferFrame
  | MeshRelayControlErrorFrame
  | MeshRelayHeartbeatFrame;
