/**
 * Public protocol contracts for the transport-only Mesh relay.
 */

export const MESH_RELAY_PROTOCOL_VERSION = 2 as const;
export const MESH_RELAY_ENROLLMENT_PROTOCOL_VERSION = 2 as const;
export const MESH_CONTROLLER_ENROLLMENT_PROTOCOL_VERSION = 1 as const;
export const MESH_RELAY_ENROLLMENT_ADMISSION_VERSION = 1 as const;
export const MESH_RELAY_MAX_AUTHORIZED_WORKERS = 1_000;
export const MESH_RELAY_MAX_AUTHORIZATION_STAGED_BYTES = 4 * 1_024 * 1_024;
export const MESH_RELAY_DESCRIPTOR_PATH = "/.well-known/clanky-mesh";
export const MESH_RELAY_CONTROL_PATH = "/api/mesh/relay/control";
export const MESH_RELAY_STREAM_PATH = "/api/mesh/relay/stream";

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

export interface MeshRelayWellKnownDescriptor {
  role: "relay";
  relayProtocol: typeof MESH_RELAY_PROTOCOL_VERSION;
  enrollmentProtocol: typeof MESH_RELAY_ENROLLMENT_PROTOCOL_VERSION;
  publicKey: string;
  fingerprint: string;
  controllerFingerprint: string;
  controllerNodeId: string | null;
}

export interface MeshControllerWellKnownDescriptor {
  role: "controller";
  enrollmentProtocol: typeof MESH_CONTROLLER_ENROLLMENT_PROTOCOL_VERSION;
  nodeId: string;
  publicKey: string;
  fingerprint: string;
}

export type MeshWellKnownDescriptor =
  | MeshRelayWellKnownDescriptor
  | MeshControllerWellKnownDescriptor;

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
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
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
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
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
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
  type: "auth.ok";
  connectionId: string;
  role: MeshRelayPeerRole;
  nodeId: string;
  workerStatus?: MeshRelayWorkerStatus;
}

export interface MeshRelayAuthorizationBeginFrame {
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
  type: "authorization.begin";
  transactionId: string;
  workerCount: number;
  identityBytes: number;
}

export interface MeshRelayAuthorizationChunkFrame {
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
  type: "authorization.chunk";
  transactionId: string;
  workers: MeshRelayPeerIdentity[];
}

export interface MeshRelayAuthorizationCommitFrame {
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
  type: "authorization.commit";
  transactionId: string;
}

export interface MeshRelayAuthorizationAckFrame {
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
  type: "authorization.ack";
  transactionId: string;
  workerCount: number;
}

export interface MeshRelayStreamRequestFrame {
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
  type: "stream.request";
  requestId: string;
  targetNodeId: string;
  kind: MeshRelayStreamKind;
  method?: string;
  path: string;
  headers: Record<string, string>;
}

export interface MeshRelayStreamCancelFrame {
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
  type: "stream.cancel";
  requestId: string;
}

export interface MeshRelayStreamTicketFrame {
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
  type: "stream.ticket";
  requestId: string;
  streamId: string;
  ticket: string;
  credential: string;
  expiresAt: string;
}

export interface MeshRelayStreamOfferFrame {
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
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
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
  type: "stream.ready";
  requestId: string;
  streamId: string;
}

export interface MeshRelayStreamStatusFrame {
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
  type: "stream.status";
  streamId: string;
  status: number;
}

export interface MeshRelayControlErrorFrame {
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
  type: "stream.error";
  requestId: string;
  code: string;
  message: string;
  status: number;
}

export interface MeshRelayHeartbeatFrame {
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
  type: "heartbeat";
  sentAt: string;
}

export interface MeshRelayPongFrame {
  protocolVersion: typeof MESH_RELAY_PROTOCOL_VERSION;
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
