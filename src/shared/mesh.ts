/**
 * Shared contracts for the linked-instance mesh.
 *
 * A local user, a linked mesh, and a node are separate identities. These
 * types intentionally contain no private keys or browser authentication data.
 */

export const MESH_TRANSPORTS = ["https", "http"] as const;
export type MeshTransport = typeof MESH_TRANSPORTS[number];
export const MESH_INSTANCE_NAME_MAX_LENGTH = 64;

export const MESH_LINK_STATUSES = ["active", "conflict", "revoked"] as const;
export type MeshLinkStatus = typeof MESH_LINK_STATUSES[number];

export const MESH_MEMBER_STATUSES = [
  "pending",
  "active",
  "offline",
  "revoked",
  "rejoining",
] as const;
export type MeshMemberStatus = typeof MESH_MEMBER_STATUSES[number];

export const MESH_PAIRING_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
] as const;
export type MeshPairingStatus = typeof MESH_PAIRING_STATUSES[number];

export const MESH_PAIRING_DIRECTIONS = ["incoming", "outgoing"] as const;
export type MeshPairingDirection = typeof MESH_PAIRING_DIRECTIONS[number];

export const MESH_PAIRING_APPROVAL_STATUSES = ["pending", "accepted", "rejected"] as const;
export type MeshPairingApprovalStatus = typeof MESH_PAIRING_APPROVAL_STATUSES[number];

export const MESH_SYNC_AGGREGATE_TYPES = [
  "mesh_membership",
  "workspace",
  "ssh_server",
  "ssh_server_session",
  "ssh_session",
  "task",
  "chat",
  "agent",
  "agent_run",
  "review_comment",
] as const;
export type MeshSyncAggregateType = typeof MESH_SYNC_AGGREGATE_TYPES[number];

export const MESH_SYNC_OUTBOX_STATUSES = ["pending", "inflight", "failed"] as const;
export type MeshSyncOutboxStatus = typeof MESH_SYNC_OUTBOX_STATUSES[number];

export const MESH_SYNC_CONFLICT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type MeshSyncConflictStatus = typeof MESH_SYNC_CONFLICT_STATUSES[number];

export const MESH_CONFLICT_RESOLUTIONS = ["local", "remote", "dismiss"] as const;
export type MeshConflictResolution = typeof MESH_CONFLICT_RESOLUTIONS[number];

export interface MeshNodeIdentity {
  nodeId: string;
  instanceName: string | null;
  publicKey: string;
  fingerprint: string;
  encryptionPublicKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MeshNodeRecord extends MeshNodeIdentity {
  endpoint: string | null;
  transport: MeshTransport;
  status: MeshMemberStatus;
  lastSeenAt: string | null;
}

export interface MeshLinkRecord {
  linkId: string;
  localUserId: string;
  activeNodeId: string | null;
  takeoverGeneration: number;
  activeClaimedAt: string | null;
  activeClaimOrigin: string | null;
  status: MeshLinkStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MeshLinkMemberRecord {
  linkId: string;
  nodeId: string;
  instanceName?: string | null;
  localUserId: string;
  endpoint: string | null;
  transport: MeshTransport;
  status: MeshMemberStatus;
  membershipGeneration: number;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeshPairingRequestRecord {
  id: string;
  direction: MeshPairingDirection;
  linkId: string | null;
  targetLocalUserId: string | null;
  requestedNodeId: string;
  requestedInstanceName?: string | null;
  requestedLocalUserId: string;
  requestedUsername: string | null;
  endpoint: string;
  transport: MeshTransport;
  publicKey: string;
  fingerprint: string;
  encryptionPublicKey?: string;
  nonce: string;
  signature: string;
  status: MeshPairingStatus;
  expiresAt: string;
  approvedAt: string | null;
  approvedByUserId: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  remoteApproval?: MeshPairingApprovalRecord;
}

export interface MeshPairingApprovalRecord {
  requestId: string;
  linkId: string;
  approvedByNodeId: string;
  approvedByInstanceName?: string | null;
  approvedByLocalUserId: string;
  activeNodeId: string | null;
  takeoverGeneration: number;
  endpoint: string;
  transport: MeshTransport;
  publicKey: string;
  fingerprint: string;
  encryptionPublicKey?: string;
  signature: string;
  status: MeshPairingApprovalStatus;
  members: MeshPairingMemberRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface MeshPairingMemberRecord {
  nodeId: string;
  instanceName?: string | null;
  localUserId: string;
  endpoint: string | null;
  transport: MeshTransport;
  status: MeshMemberStatus;
  membershipGeneration: number;
  publicKey: string;
  fingerprint: string;
  encryptionPublicKey?: string;
}

export interface MeshLinkStatusRecord extends MeshLinkRecord {
  members: MeshLinkMemberRecord[];
  pendingPairingRequests: MeshPairingRequestRecord[];
}

export interface MeshStatusRecord {
  node: MeshNodeIdentity;
  links: MeshLinkStatusRecord[];
  pendingPairingRequests: MeshPairingRequestRecord[];
}

export interface MeshTakeoverRecord {
  linkId: string;
  nodeId: string;
  generation: number;
  claimedAt: string;
  claimOrigin: string;
  signature: string | null;
}

export interface MeshTakeoverClaimRecord extends MeshTakeoverRecord {
  publicKey: string;
  fingerprint: string;
}

export interface MeshSyncCheckpointRecord {
  checkpointId: string;
  linkId: string;
  aggregateType: MeshSyncAggregateType;
  aggregateId: string;
  originNodeId: string;
  baseRevision: number;
  targetRevision: number;
  basePayload: unknown;
  payload: unknown;
  tombstone: boolean;
  createdAt: string;
}

export interface MeshSyncOutboxRecord {
  peerNodeId: string;
  checkpointId: string;
  linkId: string;
  aggregateType: MeshSyncAggregateType;
  aggregateId: string;
  originNodeId: string;
  targetRevision: number;
  status: MeshSyncOutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeshSyncConflictRecord {
  conflictId: string;
  linkId: string;
  aggregateType: MeshSyncAggregateType;
  aggregateId: string;
  originNodeId: string;
  remoteRevision: number;
  basePayload: unknown;
  localPayload: unknown;
  remotePayload: unknown;
  status: MeshSyncConflictStatus;
  createdAt: string;
  updatedAt: string;
}
