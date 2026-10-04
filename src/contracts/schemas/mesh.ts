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
import { ControllerRelayNameSchema, ControllerRelayUrlSchema } from "./mesh-relay";

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
const MeshProtocolVersionsSchema = z.array(
  z.literal(5),
).length(1);
const MeshV6Metadata = {
  protocolVersion: z.literal(6),
  supportedProtocolVersions: z.array(z.union([z.literal(6), z.literal(5)])).min(1).max(2)
    .refine((versions) => versions.includes(6) && new Set(versions).size === versions.length),
  preferredProtocolVersion: z.literal(6),
};

export const MeshWorkerProtocolDescriptorSchema = z.object({
  protocolVersion: z.union([z.literal(6), z.literal(5)]),
  nodeId: z.string().min(1).max(200), fingerprint: z.string().min(1).max(200),
  requestNonce: z.string().min(1).max(200), binaryVersion: z.string().min(1).max(200),
  supportedProtocolVersions: z.array(z.union([z.literal(6), z.literal(5)])).min(1).max(2),
  preferredProtocolVersion: z.union([z.literal(6), z.literal(5)]),
  signature: z.string().min(1).max(16_384),
}).strict().refine((value) => value.preferredProtocolVersion === value.protocolVersion
  && (value.protocolVersion === 5
    ? value.supportedProtocolVersions.length === 1 && value.supportedProtocolVersions[0] === 5
    : value.supportedProtocolVersions.includes(6) && new Set(value.supportedProtocolVersions).size === value.supportedProtocolVersions.length));
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
  protocolVersion: z.literal(5),
  binaryVersion: z.string().trim().min(1).max(200),
  supportedProtocolVersions: MeshProtocolVersionsSchema,
  preferredProtocolVersion: z.literal(5),
  route: z.union([
    MeshEnrollmentV5DirectRouteSchema,
    MeshEnrollmentV5RelayRouteSchema,
  ]),
}).strict();

export const MeshEnrollmentRequestV6Schema = MeshEnrollmentRequestV5Schema.extend(MeshV6Metadata);
export const MeshEnrollmentRequestSchema = z.union([MeshEnrollmentRequestV6Schema, MeshEnrollmentRequestV5Schema]);

const MeshEnrollmentResponseCommonSchema = z.object({
  workerNodeId: z.string().trim().min(1),
  controllerNodeId: z.string().trim().min(1),
  controllerInstanceName: MeshInstanceNameSchema.nullable(),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  controllerEncryptionPublicKey: z.string().min(1),
  signature: z.string().trim().min(1),
});

export const MeshEnrollmentResponseV5Schema =
  MeshEnrollmentResponseCommonSchema.extend({
    protocolVersion: z.literal(5),
    binaryVersion: z.string().trim().min(1).max(200),
    supportedProtocolVersions: MeshProtocolVersionsSchema,
    preferredProtocolVersion: z.literal(5),
  }).strict();

export const MeshEnrollmentResponseV6Schema = MeshEnrollmentResponseV5Schema.extend(MeshV6Metadata);
export const MeshEnrollmentResponseSchema = z.union([MeshEnrollmentResponseV6Schema, MeshEnrollmentResponseV5Schema]);

// --- Signed health check (controller → worker) ---

export const MeshHealthCheckV5Schema = z.object({
  protocolVersion: z.literal(5),
  senderNodeId: z.string().trim().min(1),
  senderPublicKey: z.string().min(1),
  senderFingerprint: z.string().trim().min(1),
  binaryVersion: z.string().trim().min(1).max(200),
  supportedProtocolVersions: MeshProtocolVersionsSchema,
  preferredProtocolVersion: z.literal(5),
  nonce: z.string().trim().min(1),
  sentAt: z.string().datetime(),
  signature: z.string().trim().min(1),
}).strict();

export const MeshHealthCheckV6Schema = MeshHealthCheckV5Schema.extend(MeshV6Metadata);
export const MeshHealthCheckSchema = z.union([MeshHealthCheckV6Schema, MeshHealthCheckV5Schema]);

export const MeshHealthCheckResponseV5Schema = z.object({
  protocolVersion: z.literal(5),
  workerNodeId: z.string().trim().min(1),
  controllerNodeId: z.string().trim().min(1),
  requestNonce: z.string().trim().min(1),
  workerDirectory: z.string().trim().min(1).max(16_384),
  workerPlatform: ExecutionHostPlatformSchema.nullable().optional(),
  workerCapabilities: ExecutionHostCapabilitiesSchema,
  workerAcceptRemoteExecution: z.boolean(),
  workerConfigRevision: z.number().int().min(1),
  binaryVersion: z.string().trim().min(1).max(200),
  supportedProtocolVersions: MeshProtocolVersionsSchema,
  preferredProtocolVersion: z.literal(5),
  signature: z.string().trim().min(1),
}).strict();

export const MeshHealthCheckResponseV6Schema = MeshHealthCheckResponseV5Schema.extend(MeshV6Metadata);
export const MeshHealthCheckResponseSchema = z.union([MeshHealthCheckResponseV6Schema, MeshHealthCheckResponseV5Schema]);

// --- Signed revocation notice (controller → worker) ---

export const MeshRevocationNoticeV5Schema = z.object({
  protocolVersion: z.literal(5),
  controllerNodeId: z.string().trim().min(1),
  workerNodeId: z.string().trim().min(1),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1),
});

export const MeshRevocationNoticeSchema = z.union([
  MeshRevocationNoticeV5Schema.extend({ protocolVersion: z.literal(6) }),
  MeshRevocationNoticeV5Schema,
]);

// --- Signed worker kill request (controller → worker) ---

export const MeshWorkerKillRequestV5Schema = z.object({
  protocolVersion: z.literal(5),
  controllerNodeId: z.string().trim().min(1),
  workerNodeId: z.string().trim().min(1),
  controllerPublicKey: z.string().min(1),
  controllerFingerprint: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1),
});

export const MeshWorkerKillRequestSchema = z.union([
  MeshWorkerKillRequestV5Schema.extend({ protocolVersion: z.literal(6) }),
  MeshWorkerKillRequestV5Schema,
]);

export type CreateMeshEnrollmentTokenRequest = z.infer<typeof CreateMeshEnrollmentTokenRequestSchema>;
export type CreateWorkspaceWorkerEnrollmentRequest = z.infer<
  typeof CreateWorkspaceWorkerEnrollmentRequestSchema
>;
export type UpdateMeshInstanceNameRequest = z.infer<typeof UpdateMeshInstanceNameSchema>;
export type UpdateMeshEndpointRequest = z.infer<typeof UpdateMeshEndpointSchema>;
export type RevokeMeshWorkerRequest = z.infer<typeof RevokeMeshWorkerRequestSchema>;
export type EnrollMeshWorkerRequest = z.infer<typeof EnrollMeshWorkerRequestSchema>;
export type MeshEnrollmentRoute = z.infer<typeof MeshEnrollmentRouteSchema>;
export type MeshEnrollmentRequestV5 = z.infer<typeof MeshEnrollmentRequestV5Schema>;
export type MeshEnrollmentRequest = Omit<z.infer<typeof MeshEnrollmentRequestV6Schema>, "protocolVersion" | "preferredProtocolVersion"> & { protocolVersion: 5 | 6; preferredProtocolVersion: 5 | 6 };
export type MeshEnrollmentResponseV5 = z.infer<typeof MeshEnrollmentResponseV5Schema>;
export type MeshEnrollmentResponse = Omit<z.infer<typeof MeshEnrollmentResponseV6Schema>, "protocolVersion" | "preferredProtocolVersion"> & { protocolVersion: 5 | 6; preferredProtocolVersion: 5 | 6 };
export type MeshHealthCheck = Omit<z.infer<typeof MeshHealthCheckV6Schema>, "protocolVersion" | "preferredProtocolVersion"> & { protocolVersion: 5 | 6; preferredProtocolVersion: 5 | 6 };
export type MeshHealthCheckV5 = z.infer<typeof MeshHealthCheckV5Schema>;
export type MeshHealthCheckResponse = Omit<z.infer<typeof MeshHealthCheckResponseV6Schema>, "protocolVersion" | "preferredProtocolVersion"> & { protocolVersion: 5 | 6; preferredProtocolVersion: 5 | 6 };
export type MeshHealthCheckResponseV5 = z.infer<
  typeof MeshHealthCheckResponseV5Schema
>;
export type MeshRevocationNotice = z.infer<typeof MeshRevocationNoticeSchema>;
export type MeshWorkerKillRequest = z.infer<typeof MeshWorkerKillRequestSchema>;
