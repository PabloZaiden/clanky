/**
 * Request schemas for linked-instance mesh management.
 */

import { z } from "zod";
import {
  ExecutionHostPreferredModelSchema,
  ExecutionNodeConfigurationSchema,
} from "./execution-host";
import {
  MESH_INSTANCE_NAME_MAX_LENGTH,
  MESH_PAIRING_DIRECTIONS,
  MESH_TRANSPORTS,
} from "@/shared/mesh";

export const MeshTransportSchema = z.enum(MESH_TRANSPORTS);
export const MeshPairingDirectionSchema = z.enum(MESH_PAIRING_DIRECTIONS);
export const MeshInstanceNameSchema = z.string()
  .trim()
  .min(1)
  .max(MESH_INSTANCE_NAME_MAX_LENGTH)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
    message: "instance name must not contain control characters",
  });

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
  enrollmentToken: z.string().trim().min(1).optional(),
  expectedFingerprint: z.string().trim().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.enrollmentToken && !value.expectedFingerprint) {
    ctx.addIssue({
      code: "custom",
      path: ["expectedFingerprint"],
      message: "Expected controller fingerprint is required for token enrollment.",
    });
  }
});

export const CreateMeshEnrollmentTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).default("Mesh enrollment"),
  ttlSeconds: z.number().int().min(60).max(86_400).default(900),
});

export const UpdateMeshInstanceNameSchema = z.object({
  instanceName: MeshInstanceNameSchema,
});

export const UpdateMeshEndpointSchema = z.object({
  meshEndpoint: MeshEndpointSchema,
});

export const UpdateMeshExecutionConfigurationSchema = z.object({
  acceptRemoteExecution: z.boolean(),
  repositoriesBasePath: z.string().trim().nullable(),
  preferredModel: ExecutionHostPreferredModelSchema.nullable().optional(),
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

export const RevokeMeshMemberRequestSchema = z.object({
  nodeId: z.string().trim().min(1),
});

const MeshPairingEnvelopeBaseSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().trim().min(1),
  linkId: z.string().trim().min(1).nullable().optional(),
  targetLocalUserId: z.string().trim().min(1).nullable().optional(),
  requestedNodeId: z.string().trim().min(1),
  requestedInstanceName: MeshInstanceNameSchema.nullable().optional(),
  requestedExecution: ExecutionNodeConfigurationSchema.optional(),
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
  approvedByInstanceName: MeshInstanceNameSchema.nullable().optional(),
  approvedByExecution: ExecutionNodeConfigurationSchema.optional(),
  approvedByLocalUserId: z.string().trim().min(1),
  endpoint: MeshEndpointSchema,
  transport: MeshTransportSchema,
  publicKey: z.string().min(1),
  fingerprint: z.string().trim().min(1),
  encryptionPublicKey: z.string().min(1).optional(),
  members: z.array(z.object({
    nodeId: z.string().trim().min(1),
    instanceName: MeshInstanceNameSchema.nullable().optional(),
    localUserId: z.string().trim().min(1),
    endpoint: MeshEndpointSchema.nullable(),
    transport: MeshTransportSchema,
    status: z.enum(["pending", "active", "offline", "revoked", "rejoining"]),
    membershipGeneration: z.number().int().positive(),
    publicKey: z.string().min(1),
    fingerprint: z.string().trim().min(1),
    encryptionPublicKey: z.string().min(1).optional(),
    execution: ExecutionNodeConfigurationSchema.optional(),
  })).max(100).optional(),
  signature: z.string().trim().min(1),
});

const MeshMemberSchema = z.object({
  nodeId: z.string().trim().min(1),
  instanceName: MeshInstanceNameSchema.nullable().optional(),
  localUserId: z.string().trim().min(1),
  endpoint: MeshEndpointSchema.nullable(),
  transport: MeshTransportSchema,
  status: z.enum(["pending", "active", "offline", "revoked", "rejoining"]),
  membershipGeneration: z.number().int().positive(),
  publicKey: z.string().min(1),
  fingerprint: z.string().trim().min(1),
  encryptionPublicKey: z.string().min(1).optional(),
  execution: ExecutionNodeConfigurationSchema.optional(),
});

export const MeshMembershipUpdateSchema = z.object({
  protocolVersion: z.literal(1),
  linkId: z.string().trim().min(1),
  senderNodeId: z.string().trim().min(1),
  senderPublicKey: z.string().min(1),
  senderFingerprint: z.string().trim().min(1),
  senderEncryptionPublicKey: z.string().min(1).optional(),
  nonce: z.string().trim().min(1),
  members: z.array(MeshMemberSchema).min(1).max(100),
  signature: z.string().trim().min(1),
});

export const MeshHealthCheckSchema = z.object({
  protocolVersion: z.literal(1),
  linkId: z.string().trim().min(1),
  senderNodeId: z.string().trim().min(1),
  senderPublicKey: z.string().min(1),
  senderFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  sentAt: z.string().datetime(),
  signature: z.string().trim().min(1),
});

export const MeshExecutionConfigurationUpdateSchema = z.object({
  protocolVersion: z.literal(1),
  linkId: z.string().trim().min(1),
  senderNodeId: z.string().trim().min(1),
  senderPublicKey: z.string().min(1),
  senderFingerprint: z.string().trim().min(1),
  targetNodeId: z.string().trim().min(1),
  expectedRevision: z.number().int().min(1),
  repositoriesBasePath: z.string().trim().min(1).nullable(),
  preferredModel: ExecutionHostPreferredModelSchema.nullable(),
  nonce: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1),
}).strict();

export type StartMeshPairingRequest = z.infer<typeof StartMeshPairingRequestSchema>;
export type UpdateMeshInstanceNameRequest = z.infer<typeof UpdateMeshInstanceNameSchema>;
export type UpdateMeshEndpointRequest = z.infer<typeof UpdateMeshEndpointSchema>;
export type UpdateMeshExecutionConfigurationRequest = z.infer<
  typeof UpdateMeshExecutionConfigurationSchema
>;
export type ApproveMeshPairingRequest = z.infer<typeof ApproveMeshPairingRequestSchema>;
export type RejectMeshPairingRequest = z.infer<typeof RejectMeshPairingRequestSchema>;
export type CompleteMeshPairingRequest = z.infer<typeof CompleteMeshPairingRequestSchema>;
export type RevokeMeshMemberRequest = z.infer<typeof RevokeMeshMemberRequestSchema>;
export type MeshPeerPairingRequest = z.infer<typeof MeshPeerPairingRequestSchema>;
export type MeshPeerPairingApproval = z.infer<typeof MeshPeerPairingApprovalSchema>;
export type MeshMembershipUpdate = z.infer<typeof MeshMembershipUpdateSchema>;
export type MeshHealthCheck = z.infer<typeof MeshHealthCheckSchema>;
export type MeshExecutionConfigurationUpdate = z.infer<
  typeof MeshExecutionConfigurationUpdateSchema
>;
