/**
 * Signed transport contracts for relay-backed workspace clients.
 */
import { z } from "zod";
import { normalizeMeshRelayOrigin } from "@/shared/mesh-relay";
import { AcceptCollaborationInvitationSchema, CollaborationNameSchema } from "./collaboration";

const IdentityString = z.string().min(1).max(200);
const PublicKey = z.string().min(1).max(16_384);
const Signature = z.string().min(1).max(16_384);

export const WorkspaceInvitationBootstrapSchema = z.object({
  version: z.literal(1),
  token: z.string().min(1).max(16_384),
  expiresAt: z.string().datetime(),
  controller: z.object({
    nodeId: IdentityString,
    publicKey: PublicKey,
    fingerprint: IdentityString,
    name: z.string().min(1).max(200),
  }).strict(),
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
  signature: Signature,
}).strict();

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
export type WorkspaceClientRequestMetadata = z.infer<typeof WorkspaceClientRequestMetadataSchema>;

export const ConnectWorkspaceControllerSchema = z.object({
  invitation: z.string().trim().min(1).max(64 * 1_024),
  name: CollaborationNameSchema.optional(),
}).strict();

export const WorkspaceClientEnrollmentSchema = AcceptCollaborationInvitationSchema.extend({
  token: AcceptCollaborationInvitationSchema.shape.token.optional(),
});

export const WorkspaceRealtimeFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("workspace.ready"),
    guestId: IdentityString,
    ownerUserId: IdentityString,
    workspaceIds: z.array(IdentityString).max(100),
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
