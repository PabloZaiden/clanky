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
  MESH_LEGACY_PROTOCOL_VERSION,
  MESH_PROTOCOL_VERSION,
  MESH_SUPPORTED_PROTOCOL_VERSIONS,
} from "@/shared/mesh-protocol";
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

const MeshEnrollmentV5DirectRouteSchema = z.object({
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

const MeshEnrollmentV5RelayRouteSchema = z.object({
  kind: z.literal("relay"),
  relayUrl: ControllerRelayUrlSchema,
  relayFingerprint: z.string().trim().min(1),
}).strict();

export const MeshEnrollmentRequestV5Schema = MeshEnrollmentRequestCommonSchema.extend({
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  binaryVersion: z.string().trim().min(1).max(200),
  supportedProtocolVersions: z.array(
    z.union([
      z.literal(MESH_LEGACY_PROTOCOL_VERSION),
      z.literal(MESH_PROTOCOL_VERSION),
    ]),
  ).min(1).max(MESH_SUPPORTED_PROTOCOL_VERSIONS.length),
  preferredProtocolVersion: z.union([
    z.literal(MESH_LEGACY_PROTOCOL_VERSION),
    z.literal(MESH_PROTOCOL_VERSION),
  ]),
  route: z.union([
    MeshEnrollmentV5DirectRouteSchema,
    MeshEnrollmentV5RelayRouteSchema,
  ]),
}).strict();

export const MeshEnrollmentRequestSchema = z.union([
  MeshEnrollmentRequestV1Schema,
  MeshEnrollmentRequestV2Schema,
  MeshEnrollmentRequestV5Schema,
]);

const MeshEnrollmentResponseCommonSchema = z.object({
  workerNodeId: z.string().trim().min(1),
  controllerNodeId: z.string().trim().min(1),
  controllerInstanceName: MeshInstanceNameSchema.nullable(),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  controllerEncryptionPublicKey: z.string().min(1),
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

export const MeshEnrollmentResponseV5Schema =
  MeshEnrollmentResponseCommonSchema.extend({
    protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
    binaryVersion: z.string().trim().min(1).max(200),
    supportedProtocolVersions: z.array(
      z.union([
        z.literal(MESH_LEGACY_PROTOCOL_VERSION),
        z.literal(MESH_PROTOCOL_VERSION),
      ]),
    ).min(1).max(MESH_SUPPORTED_PROTOCOL_VERSIONS.length),
    preferredProtocolVersion: z.union([
      z.literal(MESH_LEGACY_PROTOCOL_VERSION),
      z.literal(MESH_PROTOCOL_VERSION),
    ]),
  }).strict();

export const MeshEnrollmentResponseSchema = z.discriminatedUnion(
  "protocolVersion",
  [
    MeshEnrollmentResponseV1Schema,
    MeshEnrollmentResponseV2Schema,
    MeshEnrollmentResponseV5Schema,
  ],
);

// --- Signed health check (controller → worker) ---

export const MeshHealthCheckV1Schema = z.object({
  protocolVersion: z.literal(MESH_LEGACY_PROTOCOL_VERSION),
  senderNodeId: z.string().trim().min(1),
  senderPublicKey: z.string().min(1),
  senderFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  sentAt: z.string().datetime(),
  signature: z.string().trim().min(1),
});

export const MeshHealthCheckV5Schema = z.object({
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  senderNodeId: z.string().trim().min(1),
  senderPublicKey: z.string().min(1),
  senderFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  sentAt: z.string().datetime(),
  signature: z.string().trim().min(1),
}).strict();

export const MeshHealthCheckSchema = z.discriminatedUnion("protocolVersion", [
  MeshHealthCheckV1Schema,
  MeshHealthCheckV5Schema,
]);

export const MeshHealthCheckResponseV1Schema = z.object({
  protocolVersion: z.literal(MESH_LEGACY_PROTOCOL_VERSION),
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

export const MeshHealthCheckResponseV5Schema = z.object({
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  workerNodeId: z.string().trim().min(1),
  controllerNodeId: z.string().trim().min(1),
  requestNonce: z.string().trim().min(1),
  workerDirectory: z.string().trim().min(1).max(16_384),
  workerPlatform: ExecutionHostPlatformSchema.nullable().optional(),
  workerCapabilities: ExecutionHostCapabilitiesSchema,
  workerAcceptRemoteExecution: z.boolean(),
  workerConfigRevision: z.number().int().min(1),
  binaryVersion: z.string().trim().min(1).max(200),
  supportedProtocolVersions: z.array(
    z.union([
      z.literal(MESH_LEGACY_PROTOCOL_VERSION),
      z.literal(MESH_PROTOCOL_VERSION),
    ]),
  ).min(1).max(MESH_SUPPORTED_PROTOCOL_VERSIONS.length),
  preferredProtocolVersion: z.union([
    z.literal(MESH_LEGACY_PROTOCOL_VERSION),
    z.literal(MESH_PROTOCOL_VERSION),
  ]),
  signature: z.string().trim().min(1),
}).strict();

export const MeshHealthCheckResponseSchema = z.discriminatedUnion(
  "protocolVersion",
  [MeshHealthCheckResponseV1Schema, MeshHealthCheckResponseV5Schema],
);

// --- Signed revocation notice (controller → worker) ---

export const MeshRevocationNoticeV1Schema = z.object({
  protocolVersion: z.literal(MESH_LEGACY_PROTOCOL_VERSION),
  controllerNodeId: z.string().trim().min(1),
  workerNodeId: z.string().trim().min(1),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1),
});

export const MeshRevocationNoticeV5Schema = MeshRevocationNoticeV1Schema.extend({
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
});

export const MeshRevocationNoticeSchema = z.discriminatedUnion(
  "protocolVersion",
  [MeshRevocationNoticeV1Schema, MeshRevocationNoticeV5Schema],
);

// --- Signed worker kill request (controller → worker) ---

export const MeshWorkerKillRequestV1Schema = z.object({
  protocolVersion: z.literal(MESH_LEGACY_PROTOCOL_VERSION),
  controllerNodeId: z.string().trim().min(1),
  workerNodeId: z.string().trim().min(1),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1),
});

export const MeshWorkerKillRequestV5Schema = MeshWorkerKillRequestV1Schema.extend({
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
});

export const MeshWorkerKillRequestSchema = z.discriminatedUnion(
  "protocolVersion",
  [MeshWorkerKillRequestV1Schema, MeshWorkerKillRequestV5Schema],
);

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
export type MeshEnrollmentRequestV5 = z.infer<typeof MeshEnrollmentRequestV5Schema>;
export type MeshEnrollmentRequest = z.infer<typeof MeshEnrollmentRequestSchema>;
export type MeshEnrollmentResponseV1 = z.infer<typeof MeshEnrollmentResponseV1Schema>;
export type MeshEnrollmentResponseV2 = z.infer<typeof MeshEnrollmentResponseV2Schema>;
export type MeshEnrollmentResponseV5 = z.infer<typeof MeshEnrollmentResponseV5Schema>;
export type MeshEnrollmentResponse = z.infer<typeof MeshEnrollmentResponseSchema>;
export type MeshHealthCheck = z.infer<typeof MeshHealthCheckSchema>;
export type MeshHealthCheckV1 = z.infer<typeof MeshHealthCheckV1Schema>;
export type MeshHealthCheckV5 = z.infer<typeof MeshHealthCheckV5Schema>;
export type MeshHealthCheckResponse = z.infer<typeof MeshHealthCheckResponseSchema>;
export type MeshHealthCheckResponseV1 = z.infer<
  typeof MeshHealthCheckResponseV1Schema
>;
export type MeshHealthCheckResponseV5 = z.infer<
  typeof MeshHealthCheckResponseV5Schema
>;
export type MeshRevocationNotice = z.infer<typeof MeshRevocationNoticeSchema>;
export type MeshWorkerKillRequest = z.infer<typeof MeshWorkerKillRequestSchema>;
