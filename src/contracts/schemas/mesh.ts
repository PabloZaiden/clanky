/**
 * Request schemas for controller-worker mesh management.
 *
 * Controllers enroll workers via single-use tokens. Workers store independent
 * grants. No membership gossip, no roster propagation, no peer-to-peer
 * relationships.
 */

import { z } from "zod";
import {
  MESH_INSTANCE_NAME_MAX_LENGTH,
  MESH_TRANSPORTS,
} from "@/shared/mesh";
import { ExecutionHostCapabilitiesSchema } from "./execution-host";

export const MeshTransportSchema = z.enum(MESH_TRANSPORTS);
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

// --- Controller-side enrollment token ---

export const CreateMeshEnrollmentTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).default("Mesh enrollment"),
  ttlSeconds: z.number().int().min(60).max(86_400).default(900),
});

// --- Controller-side identity and configuration ---

export const UpdateMeshInstanceNameSchema = z.object({
  instanceName: MeshInstanceNameSchema,
});

export const UpdateMeshEndpointSchema = z.object({
  meshEndpoint: MeshEndpointSchema,
});

// --- Controller-side worker revocation ---

export const RevokeMeshWorkerRequestSchema = z.object({
  workerNodeId: z.string().trim().min(1),
});

export const EnrollMeshWorkerRequestSchema = z.object({
  controllerEndpoint: MeshEndpointSchema,
  enrollmentToken: z.string().trim().min(1),
  expectedControllerFingerprint: z.string().trim().min(1),
});

// --- Worker enrollment request (worker → controller) ---

export const MeshEnrollmentRequestSchema = z.object({
  protocolVersion: z.literal(1),
  workerNodeId: z.string().trim().min(1),
  workerInstanceName: MeshInstanceNameSchema.nullable().optional(),
  workerEndpoint: MeshEndpointSchema,
  workerTransport: MeshTransportSchema,
  workerPublicKey: z.string().min(1),
  workerFingerprint: z.string().trim().min(1),
  workerEncryptionPublicKey: z.string().min(1).optional(),
  workerDirectory: z.string().trim().min(1).max(16_384),
  workerCapabilities: ExecutionHostCapabilitiesSchema,
  workerAcceptRemoteExecution: z.boolean(),
  workerConfigRevision: z.number().int().min(1),
  enrollmentToken: z.string().trim().min(1),
  expectedControllerFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1),
});

export const MeshEnrollmentResponseSchema = z.object({
  protocolVersion: z.literal(1),
  workerNodeId: z.string().trim().min(1),
  controllerNodeId: z.string().trim().min(1),
  controllerInstanceName: MeshInstanceNameSchema.nullable(),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  controllerEncryptionPublicKey: z.string().min(1).optional(),
  signature: z.string().trim().min(1),
});

// --- Signed health check (controller → worker) ---

export const MeshHealthCheckSchema = z.object({
  protocolVersion: z.literal(1),
  senderNodeId: z.string().trim().min(1),
  senderPublicKey: z.string().min(1),
  senderFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  sentAt: z.string().datetime(),
  signature: z.string().trim().min(1),
});

export const MeshHealthCheckResponseSchema = z.object({
  protocolVersion: z.literal(1),
  workerNodeId: z.string().trim().min(1),
  controllerNodeId: z.string().trim().min(1),
  requestNonce: z.string().trim().min(1),
  workerDirectory: z.string().trim().min(1).max(16_384),
  workerCapabilities: ExecutionHostCapabilitiesSchema,
  workerAcceptRemoteExecution: z.boolean(),
  workerConfigRevision: z.number().int().min(1),
  signature: z.string().trim().min(1),
});

// --- Signed revocation notice (controller → worker) ---

export const MeshRevocationNoticeSchema = z.object({
  protocolVersion: z.literal(1),
  controllerNodeId: z.string().trim().min(1),
  workerNodeId: z.string().trim().min(1),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1),
});

export const MeshWorkerUpdateRequestSchema = z.object({
  protocolVersion: z.literal(1),
  action: z.enum(["start", "status"]),
  operationId: z.string().uuid(),
  controllerNodeId: z.string().trim().min(1),
  workerNodeId: z.string().trim().min(1),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  nonce: z.string().uuid(),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1),
});

export type CreateMeshEnrollmentTokenRequest = z.infer<typeof CreateMeshEnrollmentTokenRequestSchema>;
export type UpdateMeshInstanceNameRequest = z.infer<typeof UpdateMeshInstanceNameSchema>;
export type UpdateMeshEndpointRequest = z.infer<typeof UpdateMeshEndpointSchema>;
export type RevokeMeshWorkerRequest = z.infer<typeof RevokeMeshWorkerRequestSchema>;
export type EnrollMeshWorkerRequest = z.infer<typeof EnrollMeshWorkerRequestSchema>;
export type MeshEnrollmentRequest = z.infer<typeof MeshEnrollmentRequestSchema>;
export type MeshEnrollmentResponse = z.infer<typeof MeshEnrollmentResponseSchema>;
export type MeshHealthCheck = z.infer<typeof MeshHealthCheckSchema>;
export type MeshHealthCheckResponse = z.infer<typeof MeshHealthCheckResponseSchema>;
export type MeshRevocationNotice = z.infer<typeof MeshRevocationNoticeSchema>;
export type MeshWorkerUpdateRequest = z.infer<typeof MeshWorkerUpdateRequestSchema>;
