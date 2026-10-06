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
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";
import {
  ExecutionHostCapabilitiesSchema,
  ExecutionHostPlatformSchema,
} from "./execution-host";
import { ControllerRelayNameSchema, ControllerRelayUrlSchema } from "./mesh-relay";
import {
  assertMeshProtocolMetadata,
  MeshProtocolGenerationSchema,
  MeshProtocolVersionsSchema,
} from "./mesh-protocol";

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
const MeshV6Metadata = {
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  supportedProtocolVersions: MeshProtocolVersionsSchema,
  preferredProtocolVersion: MeshProtocolGenerationSchema,
};

export const MeshWorkerProtocolDescriptorSchema = z.object({
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  nodeId: z.string().min(1).max(200), fingerprint: z.string().min(1).max(200),
  requestNonce: z.string().min(1).max(200), binaryVersion: z.string().min(1).max(200),
  supportedProtocolVersions: MeshProtocolVersionsSchema,
  preferredProtocolVersion: MeshProtocolGenerationSchema,
  signature: z.string().min(1).max(16_384),
}).strict().superRefine(assertMeshProtocolMetadata);
export type MeshWorkerProtocolDescriptor = z.infer<typeof MeshWorkerProtocolDescriptorSchema>;

// --- Controller-side enrollment token ---

export const CreateMeshEnrollmentTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).default("Mesh enrollment"),
  ttlSeconds: z.number().int().min(60).max(86_400).default(900),
  route: MeshEnrollmentRouteSchema.default("direct"),
  relayName: ControllerRelayNameSchema.optional(),
}).refine((input) => input.relayName === undefined || input.route === "relay", {
  path: ["relayName"],
  message: "A relay can only be selected for a relay enrollment.",
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
  workerEncryptionPublicKey: z.string().min(1),
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

const MeshEnrollmentDirectRouteSchema = z.object({
  kind: z.literal("direct"),
  endpoint: MeshEndpointSchema,
  transport: MeshTransportSchema,
  tlsCertificate: z.string().trim().min(1).nullable(),
  tlsFingerprint: z.string().trim().min(1).nullable(),
}).strict().superRefine((value, context) => {
  const endpointTransport = new URL(value.endpoint).protocol === "https:"
    ? "https"
    : "http";
  if (value.transport !== endpointTransport) {
    context.addIssue({
      code: "custom",
      path: ["transport"],
      message: "Worker transport must match the worker endpoint protocol.",
    });
  }
  if (
    value.transport === "https"
    && (value.tlsCertificate === null || value.tlsFingerprint === null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["tlsCertificate"],
      message: "HTTPS workers must provide a TLS certificate and fingerprint.",
    });
  }
  if (
    value.transport === "http"
    && (value.tlsCertificate !== null || value.tlsFingerprint !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["tlsCertificate"],
      message: "HTTP workers must not provide TLS trust material.",
    });
  }
});

const MeshEnrollmentRelayRouteSchema = z.object({
  kind: z.literal("relay"),
  relayUrl: ControllerRelayUrlSchema,
  relayFingerprint: z.string().trim().min(1),
}).strict();

export const MeshEnrollmentRequestV6Schema = MeshEnrollmentRequestCommonSchema.extend({
  ...MeshV6Metadata,
  binaryVersion: z.string().trim().min(1).max(200),
  route: z.union([
    MeshEnrollmentDirectRouteSchema,
    MeshEnrollmentRelayRouteSchema,
  ]),
}).strict().superRefine(assertMeshProtocolMetadata);
export const MeshEnrollmentRequestSchema = MeshEnrollmentRequestV6Schema;

const MeshEnrollmentResponseCommonSchema = z.object({
  workerNodeId: z.string().trim().min(1),
  controllerNodeId: z.string().trim().min(1),
  controllerInstanceName: MeshInstanceNameSchema.nullable(),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  controllerEncryptionPublicKey: z.string().min(1),
  signature: z.string().trim().min(1),
});

export const MeshEnrollmentResponseV6Schema =
  MeshEnrollmentResponseCommonSchema.extend({
    ...MeshV6Metadata,
    binaryVersion: z.string().trim().min(1).max(200),
  }).strict().superRefine(assertMeshProtocolMetadata);
export const MeshEnrollmentResponseSchema = MeshEnrollmentResponseV6Schema;

// --- Signed health check (controller → worker) ---

export const MeshHealthCheckV6Schema = z.object({
  ...MeshV6Metadata,
  senderNodeId: z.string().trim().min(1),
  senderPublicKey: z.string().min(1),
  senderFingerprint: z.string().trim().min(1),
  binaryVersion: z.string().trim().min(1).max(200),
  nonce: z.string().trim().min(1),
  sentAt: z.string().datetime(),
  signature: z.string().trim().min(1),
}).strict().superRefine(assertMeshProtocolMetadata);

export const MeshHealthCheckSchema = MeshHealthCheckV6Schema;

export const MeshHealthCheckResponseV6Schema = z.object({
  ...MeshV6Metadata,
  workerNodeId: z.string().trim().min(1),
  controllerNodeId: z.string().trim().min(1),
  requestNonce: z.string().trim().min(1),
  workerDirectory: z.string().trim().min(1).max(16_384),
  workerPlatform: ExecutionHostPlatformSchema.nullable().optional(),
  workerCapabilities: ExecutionHostCapabilitiesSchema,
  workerAcceptRemoteExecution: z.boolean(),
  workerConfigRevision: z.number().int().min(1),
  binaryVersion: z.string().trim().min(1).max(200),
  signature: z.string().trim().min(1),
}).strict().superRefine(assertMeshProtocolMetadata);

export const MeshHealthCheckResponseSchema = MeshHealthCheckResponseV6Schema;

// --- Signed revocation notice (controller → worker) ---

export const MeshRevocationNoticeSchema = z.object({
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  controllerNodeId: z.string().trim().min(1),
  workerNodeId: z.string().trim().min(1),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1),
}).strict();

// --- Signed worker kill request (controller → worker) ---

export const MeshWorkerKillRequestSchema = z.object({
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  controllerNodeId: z.string().trim().min(1),
  workerNodeId: z.string().trim().min(1),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1),
}).strict();

export type CreateMeshEnrollmentTokenRequest = z.infer<typeof CreateMeshEnrollmentTokenRequestSchema>;
export type CreateWorkspaceWorkerEnrollmentRequest = z.infer<
  typeof CreateWorkspaceWorkerEnrollmentRequestSchema
>;
export type UpdateMeshInstanceNameRequest = z.infer<typeof UpdateMeshInstanceNameSchema>;
export type UpdateMeshEndpointRequest = z.infer<typeof UpdateMeshEndpointSchema>;
export type RevokeMeshWorkerRequest = z.infer<typeof RevokeMeshWorkerRequestSchema>;
export type EnrollMeshWorkerRequest = z.infer<typeof EnrollMeshWorkerRequestSchema>;
export type MeshEnrollmentRoute = z.infer<typeof MeshEnrollmentRouteSchema>;
export type MeshEnrollmentRequest = z.infer<typeof MeshEnrollmentRequestV6Schema>;
export type MeshEnrollmentResponse = z.infer<typeof MeshEnrollmentResponseV6Schema>;
export type MeshHealthCheck = z.infer<typeof MeshHealthCheckV6Schema>;
export type MeshHealthCheckResponse = z.infer<typeof MeshHealthCheckResponseV6Schema>;
export type MeshRevocationNotice = z.infer<typeof MeshRevocationNoticeSchema>;
export type MeshWorkerKillRequest = z.infer<typeof MeshWorkerKillRequestSchema>;
