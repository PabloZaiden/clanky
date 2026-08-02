/**
 * Request schemas for linked-instance mesh management.
 */

import { z } from "zod";
import {
  MESH_PAIRING_DIRECTIONS,
  MESH_CONFLICT_RESOLUTIONS,
  MESH_SYNC_AGGREGATE_TYPES,
  MESH_TRANSPORTS,
} from "@/shared/mesh";

export const MeshTransportSchema = z.enum(MESH_TRANSPORTS);
export const MeshPairingDirectionSchema = z.enum(MESH_PAIRING_DIRECTIONS);
export const MeshSyncAggregateTypeSchema = z.enum(MESH_SYNC_AGGREGATE_TYPES);
export const MeshConflictResolutionSchema = z.enum(MESH_CONFLICT_RESOLUTIONS);

export const MeshEndpointSchema = z.string().trim().url().superRefine((value, context) => {
  const protocol = new URL(value).protocol;
  if (protocol !== "https:" && protocol !== "http:") {
    context.addIssue({
      code: "custom",
      message: "mesh endpoint must use http or https",
    });
  }
});

export const StartMeshPairingRequestSchema = z.object({
  targetEndpoint: MeshEndpointSchema,
  targetLocalUserId: z.string().trim().min(1).optional(),
});

export const ApproveMeshPairingRequestSchema = z.object({
  linkId: z.string().trim().min(1).optional(),
});

export const RejectMeshPairingRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

export const CompleteMeshPairingRequestSchema = z.object({
  fingerprint: z.string().trim().min(1),
});

export const ResolveMeshSyncConflictSchema = z.object({
  resolution: MeshConflictResolutionSchema,
});

export const MeshTakeoverRequestSchema = z.object({
  expectedGeneration: z.number().int().nonnegative().optional(),
});

export const RevokeMeshMemberRequestSchema = z.object({
  nodeId: z.string().trim().min(1),
});

const MeshPairingEnvelopeBaseSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().trim().min(1),
  linkId: z.string().trim().min(1).nullable().optional(),
  targetLocalUserId: z.string().trim().min(1).nullable().optional(),
  requestedNodeId: z.string().trim().min(1),
  requestedLocalUserId: z.string().trim().min(1),
  requestedUsername: z.string().trim().min(1).nullable().optional(),
  endpoint: MeshEndpointSchema,
  transport: MeshTransportSchema,
  publicKey: z.string().min(1),
  fingerprint: z.string().trim().min(1),
  encryptionPublicKey: z.string().min(1).optional(),
  nonce: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
});

export const MeshPeerPairingRequestSchema = MeshPairingEnvelopeBaseSchema.extend({
  signature: z.string().trim().min(1),
});

export const MeshPeerPairingApprovalSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().trim().min(1),
  linkId: z.string().trim().min(1),
  approvedByNodeId: z.string().trim().min(1),
  approvedByLocalUserId: z.string().trim().min(1),
  activeNodeId: z.string().trim().min(1).nullable(),
  takeoverGeneration: z.number().int().nonnegative(),
  endpoint: MeshEndpointSchema,
  transport: MeshTransportSchema,
  publicKey: z.string().min(1),
  fingerprint: z.string().trim().min(1),
  encryptionPublicKey: z.string().min(1).optional(),
  members: z.array(z.object({
    nodeId: z.string().trim().min(1),
    localUserId: z.string().trim().min(1),
    endpoint: MeshEndpointSchema.nullable(),
    transport: MeshTransportSchema,
    status: z.enum(["pending", "active", "offline", "revoked", "rejoining"]),
    membershipGeneration: z.number().int().positive(),
    publicKey: z.string().min(1),
    fingerprint: z.string().trim().min(1),
    encryptionPublicKey: z.string().min(1).optional(),
  })).max(100).optional(),
  signature: z.string().trim().min(1),
});

export const MeshTakeoverEnvelopeSchema = z.object({
  protocolVersion: z.literal(1),
  linkId: z.string().trim().min(1),
  senderNodeId: z.string().trim().min(1),
  senderPublicKey: z.string().min(1),
  senderFingerprint: z.string().trim().min(1),
  generation: z.number().int().positive(),
  claimedAt: z.string().datetime(),
  claimOrigin: z.string().trim().min(1),
  signature: z.string().trim().min(1),
});

const MeshSyncCheckpointSchema = z.object({
  checkpointId: z.string().trim().min(1),
  linkId: z.string().trim().min(1),
  aggregateType: MeshSyncAggregateTypeSchema,
  aggregateId: z.string().trim().min(1),
  originNodeId: z.string().trim().min(1),
  baseRevision: z.number().int().nonnegative(),
  targetRevision: z.number().int().positive(),
  basePayload: z.unknown().nullable(),
  payload: z.unknown().nullable(),
  tombstone: z.boolean(),
  createdAt: z.string().datetime(),
});

const MeshMemberSnapshotSchema = z.object({
  nodeId: z.string().trim().min(1),
  localUserId: z.string().trim().min(1),
  endpoint: MeshEndpointSchema.nullable(),
  transport: MeshTransportSchema,
  status: z.enum(["pending", "active", "offline", "revoked", "rejoining"]),
  membershipGeneration: z.number().int().positive(),
  publicKey: z.string().min(1),
  fingerprint: z.string().trim().min(1),
  encryptionPublicKey: z.string().min(1).optional(),
});

const MeshSyncIdentitySchema = z.object({
  protocolVersion: z.literal(1),
  linkId: z.string().trim().min(1),
  senderNodeId: z.string().trim().min(1),
  senderPublicKey: z.string().min(1),
  senderFingerprint: z.string().trim().min(1),
  senderEncryptionPublicKey: z.string().min(1).optional(),
  nonce: z.string().trim().min(1),
});

export const MeshSyncPushSchema = MeshSyncIdentitySchema.extend({
  checkpoints: z.array(MeshSyncCheckpointSchema).min(1).max(100),
  members: z.array(MeshMemberSnapshotSchema).max(100).optional(),
  takeover: MeshTakeoverEnvelopeSchema.optional(),
  signature: z.string().trim().min(1),
});

export const MeshSyncAckSchema = MeshSyncIdentitySchema.extend({
  acknowledgements: z.array(z.object({
    checkpointId: z.string().trim().min(1),
    aggregateType: MeshSyncAggregateTypeSchema,
    aggregateId: z.string().trim().min(1),
    originNodeId: z.string().trim().min(1),
    appliedRevision: z.number().int().nonnegative(),
  })).max(100),
  signature: z.string().trim().min(1),
});

export type StartMeshPairingRequest = z.infer<typeof StartMeshPairingRequestSchema>;
export type ApproveMeshPairingRequest = z.infer<typeof ApproveMeshPairingRequestSchema>;
export type RejectMeshPairingRequest = z.infer<typeof RejectMeshPairingRequestSchema>;
export type CompleteMeshPairingRequest = z.infer<typeof CompleteMeshPairingRequestSchema>;
export type ResolveMeshSyncConflictRequest = z.infer<typeof ResolveMeshSyncConflictSchema>;
export type MeshTakeoverRequest = z.infer<typeof MeshTakeoverRequestSchema>;
export type RevokeMeshMemberRequest = z.infer<typeof RevokeMeshMemberRequestSchema>;
export type MeshTakeoverEnvelope = z.infer<typeof MeshTakeoverEnvelopeSchema>;
export type MeshPeerPairingRequest = z.infer<typeof MeshPeerPairingRequestSchema>;
export type MeshPeerPairingApproval = z.infer<typeof MeshPeerPairingApprovalSchema>;
export type MeshSyncPush = z.infer<typeof MeshSyncPushSchema>;
export type MeshSyncAck = z.infer<typeof MeshSyncAckSchema>;
