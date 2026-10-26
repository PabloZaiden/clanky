/**
 * Runtime contracts for collaboration requests and persisted public metadata.
 */

import { z } from "zod";
import { COLLABORATION_RESOURCE_REFERENCE_MAX_LENGTH } from "@/shared/collaboration-reference";
import {
  COLLABORATION_INVITATION_DEFAULT_TTL_SECONDS,
  COLLABORATION_INVITATION_MAX_TTL_SECONDS,
  COLLABORATION_MAX_WORKSPACES,
  COLLABORATION_PROTOCOL_VERSION,
} from "@/shared/collaboration";
import {
  ControllerRelayNameSchema,
  ControllerRelayUrlSchema,
  MeshRelayPeerIdentitySchema,
} from "./mesh-relay";

export const CollaborationIdSchema = z.string().trim().min(1).max(200);
export const CollaborationResourceIdSchema = z.union([
  z.uuid(),
  z.string().max(COLLABORATION_RESOURCE_REFERENCE_MAX_LENGTH).regex(/^clanky\.remote\.v1\.[A-Za-z0-9_-]+$/),
]);
export const CollaborationNameSchema = z.string().trim().min(1).max(120)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "Name must not contain control characters.");
export const CollaborationWorkspaceIdsSchema = z.array(CollaborationIdSchema)
  .min(1).max(COLLABORATION_MAX_WORKSPACES)
  .refine((ids) => new Set(ids).size === ids.length, "Workspace IDs must be unique.");
const RelayRoute = {
  relayUrl: ControllerRelayUrlSchema,
  relayFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
};
const TimestampSchema = z.string().datetime();
export const CollaborationWorkspacePermissionSchema = z.enum(["read", "work"]);
export const CollaborationWorkspacePermissionsSchema = z.record(CollaborationIdSchema, CollaborationWorkspacePermissionSchema);
export const UpdateCollaborationWorkspacePermissionSchema = z.object({
  permission: CollaborationWorkspacePermissionSchema,
}).strict();

export const CreateCollaborationInvitationSchema = z.object({
  workspaceIds: CollaborationWorkspaceIdsSchema,
  workspacePermissions: CollaborationWorkspacePermissionsSchema.optional(),
  relayName: ControllerRelayNameSchema,
  name: CollaborationNameSchema.optional(),
  ttlSeconds: z.number().int().min(60)
    .max(COLLABORATION_INVITATION_MAX_TTL_SECONDS)
    .default(COLLABORATION_INVITATION_DEFAULT_TTL_SECONDS),
}).strict().refine((value) => Object.keys(value.workspacePermissions ?? {}).every((id) => value.workspaceIds.includes(id)),
  "Permissions must refer to selected workspaces.");

export const CollaborationInvitationSchema = z.object({
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
  controller: MeshRelayPeerIdentitySchema,
  id: CollaborationIdSchema,
  name: CollaborationNameSchema.nullable(),
  workspaceIds: z.array(CollaborationIdSchema).max(COLLABORATION_MAX_WORKSPACES),
  workspacePermissions: CollaborationWorkspacePermissionsSchema,
  ...RelayRoute,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  consumedAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
}).strict();

export const AcceptCollaborationInvitationSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  guest: MeshRelayPeerIdentitySchema,
  name: CollaborationNameSchema.optional(),
  ...RelayRoute,
}).strict();

export const CollaborationGuestGrantSchema = z.object({
  id: CollaborationIdSchema,
  ownerUserId: CollaborationIdSchema,
  ownerUsername: z.string().min(1).max(200),
  identity: MeshRelayPeerIdentitySchema,
  name: CollaborationNameSchema.nullable(),
  workspaceIds: z.array(CollaborationIdSchema).max(COLLABORATION_MAX_WORKSPACES),
  ...RelayRoute,
  createdAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
}).strict();

export const CreateCollaborationConnectionSchema = z.object({
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION).default(COLLABORATION_PROTOCOL_VERSION),
  name: CollaborationNameSchema.optional(),
  controller: MeshRelayPeerIdentitySchema,
  ...RelayRoute,
}).strict();

export const CollaborationConnectionSchema = z.object({
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
  id: CollaborationIdSchema,
  name: CollaborationNameSchema.nullable(),
  controller: MeshRelayPeerIdentitySchema,
  identity: MeshRelayPeerIdentitySchema,
  guestId: CollaborationIdSchema.nullable(),
  status: z.enum(["pending", "active", "revoked"]),
  ...RelayRoute,
  createdAt: TimestampSchema,
  pendingExpiresAt: TimestampSchema,
}).strict().refine((value) => value.status !== "active" || value.guestId !== null,
  "An active connection must have a guest grant.");

export const CollaborationActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: CollaborationIdSchema }).strict(),
  z.object({
    kind: z.literal("guest"),
    guestId: CollaborationIdSchema,
    nodeId: CollaborationIdSchema,
  }).strict(),
]);

export const CollaborationAuthorshipResourceKindSchema = z.enum(["chat", "task"]);

export const CollaborationAuthorshipSchema = z.object({
  resourceKind: CollaborationAuthorshipResourceKindSchema,
  resourceId: CollaborationIdSchema,
  ownerUserId: CollaborationIdSchema,
  workspaceId: CollaborationIdSchema,
  creator: z.object({
    kind: z.enum(["user", "guest"]),
    id: CollaborationIdSchema,
    name: z.string().min(1).max(200),
  }).strict(),
}).strict();

export const CollaborationInteractiveKindSchema = z.enum(["terminal", "preview"]);
export const ClaimCollaborationInteractiveResourceSchema = z.object({
  kind: CollaborationInteractiveKindSchema,
  id: CollaborationIdSchema,
  workspaceId: CollaborationIdSchema,
  membershipId: CollaborationIdSchema.nullable(),
}).strict();
export const CollaborationInteractiveResourceSchema = ClaimCollaborationInteractiveResourceSchema.extend({
  ownerUserId: CollaborationIdSchema,
}).strict();
export const AuthorizeCollaborationInteractiveResourceSchema =
  ClaimCollaborationInteractiveResourceSchema.omit({ membershipId: true });
export const ListCollaborationInteractiveResourcesSchema = z.object({
  workspaceId: CollaborationIdSchema,
  kind: CollaborationInteractiveKindSchema.optional(),
}).strict();
export const ListGuestCollaborationInteractiveResourcesSchema = z.object({
  guestId: CollaborationIdSchema,
  ownerUserId: CollaborationIdSchema,
  workspaceIds: z.array(CollaborationIdSchema).max(COLLABORATION_MAX_WORKSPACES).optional(),
}).strict();

export type CreateCollaborationInvitation = z.input<typeof CreateCollaborationInvitationSchema>;
export type AcceptCollaborationInvitation = z.input<typeof AcceptCollaborationInvitationSchema>;
export type CreateCollaborationConnection = z.input<typeof CreateCollaborationConnectionSchema>;
export type ClaimCollaborationInteractiveResource = z.input<typeof ClaimCollaborationInteractiveResourceSchema>;
export type AuthorizeCollaborationInteractiveResource = z.input<typeof AuthorizeCollaborationInteractiveResourceSchema>;
export type ListCollaborationInteractiveResources = z.input<typeof ListCollaborationInteractiveResourcesSchema>;
export type ListGuestCollaborationInteractiveResources = z.input<typeof ListGuestCollaborationInteractiveResourcesSchema>;
