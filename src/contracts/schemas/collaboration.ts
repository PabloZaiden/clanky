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
  .max(COLLABORATION_MAX_WORKSPACES)
  .refine((ids) => new Set(ids).size === ids.length, "Workspace IDs must be unique.");
const RelayRoute = {
  relayUrl: ControllerRelayUrlSchema,
  relayFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
};
export const CollaborationRouteSchema = z.union([
  z.object({ controllerUrl: ControllerRelayUrlSchema }).strict(),
  z.object(RelayRoute).strict(),
]);
const DirectRoute = { controllerUrl: ControllerRelayUrlSchema };
const TimestampSchema = z.string().datetime();
export const CollaborationWorkspacePermissionSchema = z.enum(["read", "work"]);
export const CollaborationWorkspacePermissionsSchema = z.record(CollaborationIdSchema, CollaborationWorkspacePermissionSchema);
export const UpdateCollaborationWorkspacePermissionSchema = z.object({
  permission: CollaborationWorkspacePermissionSchema,
}).strict();

export const CreateCollaborationInvitationSchema = z.object({
  allWorkspacesAdmin: z.boolean().default(false),
  workspaceIds: CollaborationWorkspaceIdsSchema.default([]),
  workspacePermissions: CollaborationWorkspacePermissionsSchema.optional(),
  transport: z.enum(["direct", "relay"]).default("relay"),
  relayName: ControllerRelayNameSchema.optional(),
  name: CollaborationNameSchema.optional(),
  ttlSeconds: z.number().int().min(60)
    .max(COLLABORATION_INVITATION_MAX_TTL_SECONDS)
    .default(COLLABORATION_INVITATION_DEFAULT_TTL_SECONDS),
}).strict().refine((value) => value.transport === "direct" ? value.relayName === undefined : value.relayName !== undefined,
  "Select a paired relay for Relay invitations; Direct invitations do not use a relay.")
  .refine((value) => Object.keys(value.workspacePermissions ?? {}).every((id) => value.workspaceIds.includes(id)),
  "Permissions must refer to selected workspaces.")
  .refine((value) => value.allWorkspacesAdmin
    ? value.workspaceIds.length === 0 && Object.keys(value.workspacePermissions ?? {}).length === 0
    : value.workspaceIds.length > 0,
  "Select workspaces or grant Work access to all workspaces, not both.");

const InvitationFields = {
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
  controller: MeshRelayPeerIdentitySchema,
  id: CollaborationIdSchema,
  name: CollaborationNameSchema.nullable(),
  allWorkspacesAdmin: z.boolean(),
  workspaceIds: z.array(CollaborationIdSchema).max(COLLABORATION_MAX_WORKSPACES),
  workspacePermissions: CollaborationWorkspacePermissionsSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  consumedAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
};
export const CollaborationInvitationSchema = z.union([
  z.object({ ...InvitationFields, ...RelayRoute }).strict(),
  z.object({ ...InvitationFields, ...DirectRoute }).strict(),
]);

const AcceptanceFields = {
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  guest: MeshRelayPeerIdentitySchema,
  name: CollaborationNameSchema.optional(),
};
export const AcceptCollaborationInvitationSchema = z.union([
  z.object({ ...AcceptanceFields, ...RelayRoute }).strict(),
  z.object({ ...AcceptanceFields, ...DirectRoute }).strict(),
]);

const GuestFields = {
  id: CollaborationIdSchema,
  ownerUserId: CollaborationIdSchema,
  ownerUsername: z.string().min(1).max(200),
  identity: MeshRelayPeerIdentitySchema,
  name: CollaborationNameSchema.nullable(),
  workspaceIds: z.array(CollaborationIdSchema),
  createdAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
};
export const CollaborationGuestGrantSchema = z.union([
  z.object({ ...GuestFields, ...RelayRoute }).strict(),
  z.object({ ...GuestFields, ...DirectRoute }).strict(),
]);

const ConnectionInputFields = {
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION).default(COLLABORATION_PROTOCOL_VERSION),
  name: CollaborationNameSchema.optional(),
  controller: MeshRelayPeerIdentitySchema,
};
export const CreateCollaborationConnectionSchema = z.union([
  z.object({ ...ConnectionInputFields, ...RelayRoute }).strict(),
  z.object({ ...ConnectionInputFields, ...DirectRoute }).strict(),
]);

const ConnectionFields = {
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
  id: CollaborationIdSchema,
  name: CollaborationNameSchema.nullable(),
  controller: MeshRelayPeerIdentitySchema,
  identity: MeshRelayPeerIdentitySchema,
  guestId: CollaborationIdSchema.nullable(),
  status: z.enum(["pending", "active", "revoked"]),
  createdAt: TimestampSchema,
  pendingExpiresAt: TimestampSchema,
};
export const CollaborationConnectionSchema = z.union([
  z.object({ ...ConnectionFields, ...RelayRoute }).strict(),
  z.object({ ...ConnectionFields, ...DirectRoute }).strict(),
]).refine((value) => value.status !== "active" || value.guestId !== null,
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
  workspaceIds: z.array(CollaborationIdSchema).optional(),
}).strict();

export type CreateCollaborationInvitation = z.input<typeof CreateCollaborationInvitationSchema>;
export type AcceptCollaborationInvitation = z.input<typeof AcceptCollaborationInvitationSchema>;
export type CreateCollaborationConnection = z.input<typeof CreateCollaborationConnectionSchema>;
export type ClaimCollaborationInteractiveResource = z.input<typeof ClaimCollaborationInteractiveResourceSchema>;
export type AuthorizeCollaborationInteractiveResource = z.input<typeof AuthorizeCollaborationInteractiveResourceSchema>;
export type ListCollaborationInteractiveResources = z.input<typeof ListCollaborationInteractiveResourcesSchema>;
export type ListGuestCollaborationInteractiveResources = z.input<typeof ListGuestCollaborationInteractiveResourcesSchema>;
