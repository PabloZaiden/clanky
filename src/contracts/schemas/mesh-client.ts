/**
 * Signed transport contracts for direct and relayed workspace clients.
 */
import { z } from "zod";
import { normalizeMeshRelayOrigin } from "@/shared/mesh-relay";
import { CollaborationNameSchema } from "./collaboration";
import { ControllerRelayUrlSchema, MeshRelayPeerIdentitySchema } from "./mesh-relay";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";

const IdentityString = z.string().min(1).max(200);
const PublicKey = z.string().min(1).max(16_384);
const Signature = z.string().min(1).max(16_384);

const InvitationFields = {
  version: z.literal(1),
  token: z.string().min(1).max(16_384),
  expiresAt: z.string().datetime(),
  controller: z.object({
    nodeId: IdentityString,
    publicKey: PublicKey,
    fingerprint: IdentityString,
    name: z.string().min(1).max(200),
  }).strict(),
  signature: Signature,
};
export const WorkspaceInvitationBootstrapSchema = z.union([z.object({
  ...InvitationFields,
  relay: z.object({
    url: z.string().superRefine((value, context) => {
      try {
        normalizeMeshRelayOrigin(value);
      } catch (error) {
        context.addIssue({ code: "custom", message: String(error) });
      }
    }),
    fingerprint: IdentityString,
  }).strict(),
  relayAdmission: z.string().min(1).max(16_384),
}).strict(), z.object({
  ...InvitationFields,
  controllerUrl: ControllerRelayUrlSchema,
}).strict()]);

export const WorkspaceClientRequestMetadataSchema = z.object({
  version: z.literal(1),
  nodeId: IdentityString,
  controllerNodeId: IdentityString,
  requestId: z.string().uuid(),
  issuedAt: z.number().int().nonnegative(),
  kind: z.enum(["enrollment", "operation", "realtime", "terminal", "preview"]),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
  path: z.string().min(1).max(8_192).refine((path) => {
    if (!path.startsWith("/api/") || path.includes("\\") || path.includes("#")) return false;
    const url = new URL(path, "https://mesh.invalid");
    return url.origin === "https://mesh.invalid" && !url.username && !url.password;
  }, "Workspace client requests require an application API path."),
  headers: z.record(
    z.string().min(1).max(200),
    z.string().max(16_384),
  ).refine((headers) => Object.keys(headers).length <= 32),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  workspaceId: IdentityString.optional(),
}).strict();

export type WorkspaceInvitationBootstrap = z.infer<typeof WorkspaceInvitationBootstrapSchema>;
type Unsigned<T> = T extends unknown ? Omit<T, "signature"> : never;
export type UnsignedWorkspaceInvitation = Unsigned<WorkspaceInvitationBootstrap>;
export type WorkspaceClientRequestMetadata = z.infer<typeof WorkspaceClientRequestMetadataSchema>;

export const ConnectWorkspaceControllerSchema = z.object({
  invitation: z.string().trim().min(1).max(64 * 1_024),
  name: CollaborationNameSchema.optional(),
}).strict();

const EnrollmentFields = {
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  guest: MeshRelayPeerIdentitySchema,
  name: CollaborationNameSchema.optional(),
};
export const WorkspaceClientEnrollmentSchema = z.union([
  z.object({ ...EnrollmentFields, relayUrl: ControllerRelayUrlSchema,
    relayFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  z.object({ ...EnrollmentFields, controllerUrl: ControllerRelayUrlSchema }).strict(),
]);
export type WorkspaceClientEnrollment = z.infer<typeof WorkspaceClientEnrollmentSchema>;

export const WORKSPACE_DIRECT_PATH = "/api/mesh/internal/client/direct";
export const WorkspaceDirectOpenSchema = z.object({
  type: z.literal("workspace.open"),
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  requestId: z.uuid(),
  streamId: z.uuid(),
  kind: z.enum(["http", "socket", "probe"]),
  identity: MeshRelayPeerIdentitySchema,
  headers: z.record(z.string().max(200), z.string().max(24 * 1_024))
    .refine((value) => Object.keys(value).length <= 4),
}).strict();
export type WorkspaceDirectOpen = z.infer<typeof WorkspaceDirectOpenSchema>;
export const WorkspaceDirectReadySchema = z.object({
  type: z.literal("stream.ready"),
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
  requestId: z.uuid(),
  streamId: z.uuid(),
  signature: Signature,
}).strict();
export function workspaceDirectReadyPayload(value: { requestId: string; streamId: string }): string {
  return JSON.stringify(["clanky-workspace-direct-ready-v1", MESH_PROTOCOL_VERSION, value.requestId, value.streamId]);
}

export const WorkspaceRealtimeFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("workspace.ready"),
    guestId: IdentityString,
    ownerUserId: IdentityString,
    workspaceIds: z.array(IdentityString),
  }),
  z.strictObject({
    type: z.literal("workspace.publication"),
    publication: z.strictObject({
      kind: z.enum(["state", "content"]),
      target: z.record(z.string().min(1).max(256), z.string().max(512)),
      event: z.unknown(),
    }),
  }),
  z.strictObject({
    type: z.literal("workspace.error"),
    code: z.string().min(1).max(200),
  }),
]);
