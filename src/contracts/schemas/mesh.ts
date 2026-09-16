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
import {
  ExecutionHostCapabilitiesSchema,
  ExecutionHostPlatformSchema,
} from "./execution-host";
import { ControllerRelayUrlSchema } from "./mesh-relay";

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
export const MeshOriginSchema = MeshEndpointSchema.superRefine((value, context) => {
  const url = new URL(value);
  if (
    url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    context.addIssue({
      code: "custom",
      message: "mesh target must be an absolute HTTP(S) origin",
    });
  }
});
export const MeshEnrollmentRouteSchema = z.enum(["direct", "relay"]);

// --- Controller-side enrollment token ---

export const CreateMeshEnrollmentTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).default("Mesh enrollment"),
  ttlSeconds: z.number().int().min(60).max(86_400).default(900),
  route: MeshEnrollmentRouteSchema.default("direct"),
});

export const CreateWorkspaceWorkerEnrollmentRequestSchema =
  CreateMeshEnrollmentTokenRequestSchema;

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
  target: MeshOriginSchema,
  enrollmentToken: z.string().trim().min(1),
  expectedControllerFingerprint: z.string().trim().min(1),
});

// --- Worker enrollment request (worker → controller) ---

const MeshEnrollmentRequestCommonSchema = z.object({
  workerNodeId: z.string().trim().min(1),
  workerInstanceName: MeshInstanceNameSchema.nullable().optional(),
  workerPublicKey: z.string().min(1),
  workerFingerprint: z.string().trim().min(1),
  workerEncryptionPublicKey: z.string().min(1).optional(),
  workerDirectory: z.string().trim().min(1).max(16_384),
  workerPlatform: ExecutionHostPlatformSchema.nullable().optional(),
  workerCapabilities: ExecutionHostCapabilitiesSchema,
  workerAcceptRemoteExecution: z.boolean(),
  workerConfigRevision: z.number().int().min(1),
  enrollmentToken: z.string().trim().min(1),
  expectedControllerFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1),
});

export const MeshEnrollmentRequestV1Schema = MeshEnrollmentRequestCommonSchema.extend({
  protocolVersion: z.literal(1),
  workerEndpoint: MeshEndpointSchema,
  workerTransport: MeshTransportSchema,
  workerTlsCertificate: z.string().trim().min(1).nullable(),
  workerTlsFingerprint: z.string().trim().min(1).nullable(),
}).superRefine((value, context) => {
  const endpointTransport = new URL(value.workerEndpoint).protocol === "https:"
    ? "https"
    : "http";
  if (value.workerTransport !== endpointTransport) {
    context.addIssue({
      code: "custom",
      path: ["workerTransport"],
      message: "Worker transport must match the worker endpoint protocol.",
    });
  }
  const hasCertificate = value.workerTlsCertificate !== null;
  const hasFingerprint = value.workerTlsFingerprint !== null;
  if (value.workerTransport === "https" && (!hasCertificate || !hasFingerprint)) {
    context.addIssue({
      code: "custom",
      path: ["workerTlsCertificate"],
      message: "HTTPS workers must provide a TLS certificate and fingerprint.",
    });
  }
  if (value.workerTransport === "http" && (hasCertificate || hasFingerprint)) {
    context.addIssue({
      code: "custom",
      path: ["workerTlsCertificate"],
      message: "HTTP workers must not provide TLS trust material.",
    });
  }
});

export const MeshEnrollmentRequestV2Schema = MeshEnrollmentRequestCommonSchema.extend({
  protocolVersion: z.literal(2),
  route: z.object({
    kind: z.literal("relay"),
    relayUrl: ControllerRelayUrlSchema,
    relayFingerprint: z.string().trim().min(1),
  }).strict(),
}).strict();

export const MeshEnrollmentRequestSchema = z.union([
  MeshEnrollmentRequestV1Schema,
  MeshEnrollmentRequestV2Schema,
]);

const MeshEnrollmentResponseCommonSchema = z.object({
  workerNodeId: z.string().trim().min(1),
  controllerNodeId: z.string().trim().min(1),
  controllerInstanceName: MeshInstanceNameSchema.nullable(),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  controllerEncryptionPublicKey: z.string().min(1).optional(),
  signature: z.string().trim().min(1),
});

export const MeshEnrollmentResponseV1Schema =
  MeshEnrollmentResponseCommonSchema.extend({
    protocolVersion: z.literal(1),
  }).strict();

export const MeshEnrollmentResponseV2Schema =
  MeshEnrollmentResponseCommonSchema.extend({
    protocolVersion: z.literal(2),
  }).strict();

export const MeshEnrollmentResponseSchema = z.discriminatedUnion(
  "protocolVersion",
  [
    MeshEnrollmentResponseV1Schema,
    MeshEnrollmentResponseV2Schema,
  ],
);

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
  workerPlatform: ExecutionHostPlatformSchema.nullable().optional(),
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

// --- Signed worker kill request (controller → worker) ---

export const MeshWorkerKillRequestSchema = z.object({
  protocolVersion: z.literal(1),
  controllerNodeId: z.string().trim().min(1),
  workerNodeId: z.string().trim().min(1),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1),
});

export type CreateMeshEnrollmentTokenRequest = z.infer<typeof CreateMeshEnrollmentTokenRequestSchema>;
export type CreateWorkspaceWorkerEnrollmentRequest = z.infer<
  typeof CreateWorkspaceWorkerEnrollmentRequestSchema
>;
export type UpdateMeshInstanceNameRequest = z.infer<typeof UpdateMeshInstanceNameSchema>;
export type UpdateMeshEndpointRequest = z.infer<typeof UpdateMeshEndpointSchema>;
export type RevokeMeshWorkerRequest = z.infer<typeof RevokeMeshWorkerRequestSchema>;
export type EnrollMeshWorkerRequest = z.infer<typeof EnrollMeshWorkerRequestSchema>;
export type MeshEnrollmentRoute = z.infer<typeof MeshEnrollmentRouteSchema>;
export type MeshEnrollmentRequestV1 = z.infer<typeof MeshEnrollmentRequestV1Schema>;
export type MeshEnrollmentRequestV2 = z.infer<typeof MeshEnrollmentRequestV2Schema>;
export type MeshEnrollmentRequest = z.infer<typeof MeshEnrollmentRequestSchema>;
export type MeshEnrollmentResponseV1 = z.infer<typeof MeshEnrollmentResponseV1Schema>;
export type MeshEnrollmentResponseV2 = z.infer<typeof MeshEnrollmentResponseV2Schema>;
export type MeshEnrollmentResponse = z.infer<typeof MeshEnrollmentResponseSchema>;
export type MeshHealthCheck = z.infer<typeof MeshHealthCheckSchema>;
export type MeshHealthCheckResponse = z.infer<typeof MeshHealthCheckResponseSchema>;
export type MeshRevocationNotice = z.infer<typeof MeshRevocationNoticeSchema>;
export type MeshWorkerKillRequest = z.infer<typeof MeshWorkerKillRequestSchema>;
