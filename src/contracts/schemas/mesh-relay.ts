import { z } from "zod";
import {
  MESH_RELAY_MAX_AUTHORIZATION_STAGED_BYTES,
  MESH_RELAY_MAX_AUTHORIZED_WORKERS,
  MESH_RELAY_ENROLLMENT_ADMISSION_VERSION,
  normalizeMeshRelayOrigin,
} from "@/shared/mesh-relay";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";

const RelayIdSchema = z.string().trim().min(1).max(200);
const RelayPublicKeySchema = z.string().min(1).max(16_384);
const RelayFingerprintSchema = z.string().trim().min(1).max(200);
const RelaySignatureSchema = z.string().trim().min(1).max(16_384);
const RelayTimestampSchema = z.string().datetime();
const MeshRelayProtocolVersionSchema = z.literal(MESH_PROTOCOL_VERSION);
const MeshSupportedProtocolVersionsSchema = z.array(
  z.literal(MESH_PROTOCOL_VERSION),
).length(1);
const RelayHeadersSchema = z.record(
  z.string().min(1).max(200),
  z.string().max(16_384),
).refine((headers) => Object.keys(headers).length <= 64, {
  message: "Relay stream headers exceed the maximum count.",
});

export const MeshRelayPeerIdentitySchema = z.object({
  nodeId: RelayIdSchema,
  publicKey: RelayPublicKeySchema,
  fingerprint: RelayFingerprintSchema,
}).strict();

export const MeshRelayWellKnownDescriptorV5Schema = z.object({
  role: z.literal("relay"),
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  publicKey: RelayPublicKeySchema,
  fingerprint: RelayFingerprintSchema,
  controllerFingerprint: RelayFingerprintSchema,
  controllerNodeId: RelayIdSchema.nullable(),
  binaryVersion: z.string().trim().min(1).max(200),
  supportedProtocolVersions: MeshSupportedProtocolVersionsSchema,
  preferredProtocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  negotiatedProtocolVersion: z.literal(MESH_PROTOCOL_VERSION).nullable(),
}).strict();

export const MeshControllerWellKnownDescriptorV5Schema = z.object({
  role: z.literal("controller"),
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  nodeId: RelayIdSchema,
  publicKey: RelayPublicKeySchema,
  fingerprint: RelayFingerprintSchema,
  binaryVersion: z.string().trim().min(1).max(200),
  supportedProtocolVersions: MeshSupportedProtocolVersionsSchema,
  preferredProtocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  negotiatedProtocolVersion: z.literal(MESH_PROTOCOL_VERSION).nullable(),
}).strict();

export const MeshRelayWellKnownDescriptorSchema =
  MeshRelayWellKnownDescriptorV5Schema;

export const MeshControllerWellKnownDescriptorSchema =
  MeshControllerWellKnownDescriptorV5Schema;

export const MeshWellKnownDescriptorSchema = z.union([
  MeshRelayWellKnownDescriptorV5Schema,
  MeshControllerWellKnownDescriptorV5Schema,
]);

export const ControllerRelayUrlSchema = z.string().trim().url().superRefine(
  (value, context) => {
    try {
      normalizeMeshRelayOrigin(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid relay URL",
      });
    }
  },
);

export const ControllerRelayNameSchema = z.string().trim().toLowerCase()
  .min(1).max(64)
  .regex(/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/, {
    message: "Relay name must use letters, numbers, hyphens, or underscores.",
  });

export const PairControllerRelayRequestSchema = z.object({
  name: ControllerRelayNameSchema,
  relayUrl: ControllerRelayUrlSchema,
}).strict();

export const SelectPrimaryControllerRelayRequestSchema = z.object({
  name: ControllerRelayNameSchema,
}).strict();

export const ControllerRelayStatusItemSchema = z.object({
  name: ControllerRelayNameSchema,
  isPrimary: z.boolean(),
  // Status must remain readable when a persisted URL is now invalid.
  relayUrl: z.string().min(1),
  relayFingerprint: RelayFingerprintSchema,
  connected: z.boolean(),
  runtimeError: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).strict().nullable(),
  pairedAt: RelayTimestampSchema,
  updatedAt: RelayTimestampSchema,
  relayBinaryVersion: z.string().trim().min(1).nullable(),
  relaySupportedProtocolVersions: MeshSupportedProtocolVersionsSchema,
  relayPreferredProtocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  relayNegotiatedProtocolVersion: z.literal(MESH_PROTOCOL_VERSION).nullable(),
}).strict();

export const ControllerRelayPairingStatusSchema = z.object({
  controllerFingerprint: RelayFingerprintSchema,
  bootstrapEnvironment: z.string().min(1),
  primaryName: ControllerRelayNameSchema.nullable(),
  relays: z.array(ControllerRelayStatusItemSchema),
}).strict();

export const MeshRelayChallengeFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("challenge"),
  challengeId: RelayIdSchema,
  nonce: RelayIdSchema,
  relayPublicKey: RelayPublicKeySchema,
  relayFingerprint: RelayFingerprintSchema,
  issuedAt: RelayTimestampSchema,
  expiresAt: RelayTimestampSchema,
  signature: RelaySignatureSchema,
}).strict();

export const MeshRelayAuthFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("auth"),
  role: z.enum(["controller", "worker"]),
  nodeId: RelayIdSchema,
  publicKey: RelayPublicKeySchema,
  fingerprint: RelayFingerprintSchema,
  challengeId: RelayIdSchema,
  nonce: RelayIdSchema,
  relayFingerprint: RelayFingerprintSchema,
  expiresAt: RelayTimestampSchema,
  enrollmentAdmission: z.string().min(1).max(16_384).optional(),
  signature: RelaySignatureSchema,
}).strict();

export const MeshRelayEnrollmentAdmissionSchema = z.object({
  version: z.literal(MESH_RELAY_ENROLLMENT_ADMISSION_VERSION),
  controllerNodeId: RelayIdSchema,
  controllerFingerprint: RelayFingerprintSchema,
  nonce: RelayIdSchema,
  expiresAt: RelayTimestampSchema,
  signature: RelaySignatureSchema,
}).strict();

export const MeshRelayAuthorizationBeginFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("authorization.begin"),
  transactionId: RelayIdSchema,
  workerCount: z.number().int().min(0).max(MESH_RELAY_MAX_AUTHORIZED_WORKERS),
  identityBytes: z.number().int().min(0).max(
    MESH_RELAY_MAX_AUTHORIZATION_STAGED_BYTES,
  ),
}).strict();

export const MeshRelayAuthorizationChunkFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("authorization.chunk"),
  transactionId: RelayIdSchema,
  workers: z.array(MeshRelayPeerIdentitySchema)
    .min(1)
    .max(MESH_RELAY_MAX_AUTHORIZED_WORKERS),
}).strict();

export const MeshRelayAuthorizationCommitFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("authorization.commit"),
  transactionId: RelayIdSchema,
}).strict();

export const MeshRelayStreamRequestFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("stream.request"),
  requestId: RelayIdSchema,
  targetNodeId: RelayIdSchema,
  kind: z.enum(["http", "socket"]),
  method: z.string().trim().min(1).max(16).optional(),
  path: z.string().min(1).max(16_384),
  headers: RelayHeadersSchema,
}).strict();

export const MeshRelayStreamCancelFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("stream.cancel"),
  requestId: RelayIdSchema,
}).strict();

export const MeshRelayPongFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("pong"),
  sentAt: RelayTimestampSchema,
}).strict();

export const MeshRelayAuthOkFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("auth.ok"),
  connectionId: RelayIdSchema,
  role: z.enum(["controller", "worker"]),
  nodeId: RelayIdSchema,
  workerStatus: z.enum(["pending", "authorized"]).optional(),
}).strict();

export const MeshRelayAuthorizationAckFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("authorization.ack"),
  transactionId: RelayIdSchema,
  workerCount: z.number().int().min(0).max(MESH_RELAY_MAX_AUTHORIZED_WORKERS),
}).strict();

export const MeshRelayStreamTicketFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("stream.ticket"),
  requestId: RelayIdSchema,
  streamId: RelayIdSchema,
  ticket: RelayIdSchema,
  credential: RelayIdSchema,
  expiresAt: RelayTimestampSchema,
}).strict();

export const MeshRelayStreamOfferFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("stream.offer"),
  requestId: RelayIdSchema,
  streamId: RelayIdSchema,
  ticket: RelayIdSchema,
  credential: RelayIdSchema,
  expiresAt: RelayTimestampSchema,
  initiatorNodeId: RelayIdSchema,
  kind: z.enum(["http", "socket"]),
  method: z.string().trim().min(1).max(16).optional(),
  path: z.string().min(1).max(16_384),
  headers: RelayHeadersSchema,
}).strict();

export const MeshRelayControlErrorFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("stream.error"),
  requestId: RelayIdSchema,
  code: RelayIdSchema,
  message: z.string().min(1).max(4_096),
  status: z.number().int().min(400).max(599),
}).strict();

export const MeshRelayHeartbeatFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("heartbeat"),
  sentAt: RelayTimestampSchema,
}).strict();

export const MeshRelayStreamReadyFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("stream.ready"),
  requestId: RelayIdSchema,
  streamId: RelayIdSchema,
}).strict();

export const MeshRelayStreamStatusFrameSchema = z.object({
  protocolVersion: MeshRelayProtocolVersionSchema,
  type: z.literal("stream.status"),
  streamId: RelayIdSchema,
  status: z.number().int().min(100).max(599),
}).strict();

export const MeshRelayClientControlFrameSchema = z.discriminatedUnion("type", [
  MeshRelayAuthFrameSchema,
  MeshRelayAuthorizationBeginFrameSchema,
  MeshRelayAuthorizationChunkFrameSchema,
  MeshRelayAuthorizationCommitFrameSchema,
  MeshRelayStreamRequestFrameSchema,
  MeshRelayStreamCancelFrameSchema,
  MeshRelayStreamStatusFrameSchema,
  MeshRelayPongFrameSchema,
]);

export const MeshRelayServerControlFrameSchema = z.discriminatedUnion("type", [
  MeshRelayChallengeFrameSchema,
  MeshRelayAuthOkFrameSchema,
  MeshRelayAuthorizationAckFrameSchema,
  MeshRelayStreamTicketFrameSchema,
  MeshRelayStreamOfferFrameSchema,
  MeshRelayControlErrorFrameSchema,
  MeshRelayHeartbeatFrameSchema,
]);

export type MeshRelayAuthFrame = z.infer<typeof MeshRelayAuthFrameSchema>;
export type MeshRelayAuthorizationBeginFrame = z.infer<
  typeof MeshRelayAuthorizationBeginFrameSchema
>;
export type MeshRelayAuthorizationChunkFrame = z.infer<
  typeof MeshRelayAuthorizationChunkFrameSchema
>;
export type MeshRelayAuthorizationCommitFrame = z.infer<
  typeof MeshRelayAuthorizationCommitFrameSchema
>;
export type MeshRelayStreamRequestFrame = z.infer<
  typeof MeshRelayStreamRequestFrameSchema
>;
export type MeshRelayClientControlFrame = z.infer<
  typeof MeshRelayClientControlFrameSchema
>;
export type MeshRelayServerControlFrame = z.infer<
  typeof MeshRelayServerControlFrameSchema
>;
export type ControllerRelayPairingStatus = z.infer<
  typeof ControllerRelayPairingStatusSchema
>;
export type ControllerRelayStatusItem = z.infer<
  typeof ControllerRelayStatusItemSchema
>;
