/**
 * Shared contracts for the linked-instance mesh.
 *
 * A local user, a linked mesh, and a node are separate identities. These
 * types intentionally contain no private keys or browser authentication data.
 */

export const MESH_TRANSPORTS = ["https", "http"] as const;
export type MeshTransport = typeof MESH_TRANSPORTS[number];
export const MESH_INSTANCE_NAME_MAX_LENGTH = 64;

export const MESH_LINK_STATUSES = ["active", "revoked"] as const;
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
