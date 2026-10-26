/**
 * Workspace collaboration identities and grants, separate from data ownership.
 */

import type { MeshRelayPeerIdentity, MeshRelayConnectorStatus } from "./mesh-relay";

export const COLLABORATION_MAX_WORKSPACES = 100;
export const COLLABORATION_MAX_INVITATIONS = 100;
export const COLLABORATION_MAX_GUESTS = 1_000;
export const COLLABORATION_MAX_CONNECTIONS = 100;
export const COLLABORATION_INVITATION_DEFAULT_TTL_SECONDS = 900;
export const COLLABORATION_INVITATION_MAX_TTL_SECONDS = 86_400;
export const COLLABORATION_PROTOCOL_VERSION = 1 as const;
export type CollaborationWorkspacePermission = "read" | "work";
export type CollaborationWorkspacePermissions = Record<string, CollaborationWorkspacePermission>;

export interface CollaborationRelayRoute {
  relayUrl: string;
  relayFingerprint: string;
  controllerUrl?: never;
}

export interface CollaborationDirectRoute {
  controllerUrl: string;
  relayUrl?: never;
  relayFingerprint?: never;
}

export type CollaborationRoute = CollaborationRelayRoute | CollaborationDirectRoute;

export function collaborationRoute(value: CollaborationRoute): CollaborationRoute {
  return value.controllerUrl !== undefined
    ? { controllerUrl: value.controllerUrl }
    : { relayUrl: value.relayUrl, relayFingerprint: value.relayFingerprint };
}

export function sameCollaborationRoute(a: CollaborationRoute, b: CollaborationRoute): boolean {
  return a.controllerUrl === b.controllerUrl
    && a.relayUrl === b.relayUrl && a.relayFingerprint === b.relayFingerprint;
}

export type CollaborationInvitation = CollaborationRoute & {
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION;
  controller: MeshRelayPeerIdentity;
  id: string;
  name: string | null;
  allWorkspacesAdmin: boolean;
  workspaceIds: string[];
  workspacePermissions: CollaborationWorkspacePermissions;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
}

export type CreatedCollaborationInvitation = CollaborationRoute & {
  token: string;
  invitation: CollaborationInvitation;
  controller: MeshRelayPeerIdentity;
}

export type CollaborationGuestGrant = CollaborationRoute & {
  id: string;
  ownerUserId: string;
  ownerUsername: string;
  identity: MeshRelayPeerIdentity;
  name: string | null;
  workspaceIds: string[];
  createdAt: string;
  revokedAt: string | null;
}

/** Controller-owned permissions, not part of the v1 pairing wire contract. */
export type CollaborationGuestAccess = CollaborationGuestGrant & {
  allWorkspacesAdmin: boolean;
  workspacePermissions: CollaborationWorkspacePermissions;
}

export interface CollaborationControllerAccess {
  id: string;
  name: string;
  allWorkspacesAdmin: boolean;
  capabilities: readonly WorkspaceAccessCapability[];
}

export type CollaborationActor =
  | { kind: "user"; userId: string }
  | { kind: "guest"; guestId: string; nodeId: string };

export type WorkspaceAccessCapability = "read" | "work" | "admin";

export interface WorkspaceAccessAuthority {
  actor: CollaborationActor;
  ownerUserId: string;
  workspaceId: string;
  guestId: string | null;
  capabilities: readonly WorkspaceAccessCapability[];
}

export interface CollaborationRevocation {
  guestId: string;
  nodeId: string;
  ownerUserId: string;
  workspaceIds: string[];
  wholeGuest: boolean;
}

export type CollaborationConnection = CollaborationRoute & {
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION;
  id: string;
  name: string | null;
  controller: MeshRelayPeerIdentity;
  identity: MeshRelayPeerIdentity;
  guestId: string | null;
  status: "pending" | "active" | "revoked";
  createdAt: string;
  pendingExpiresAt: string;
}

export interface CollaborationConnectionChange {
  localUserId: string;
  connectionId: string;
  status: "active" | "revoked" | "deleted";
}

export interface WorkspaceConnectionStatus {
  connection: CollaborationConnection;
  transport: MeshRelayConnectorStatus;
  realtime: "connecting" | "connected" | "disconnected";
  errorCode: string | null;
  operationErrorCode: string | null;
}

export interface CollaborationCreator {
  kind: "user" | "guest";
  id: string;
  name: string;
}

export interface CollaborationAuthorship {
  resourceKind: "chat" | "task";
  resourceId: string;
  ownerUserId: string;
  workspaceId: string;
  creator: CollaborationCreator;
}

export interface CollaborationInteractiveResource {
  kind: "terminal" | "preview";
  id: string;
  ownerUserId: string;
  workspaceId: string;
  /** Stable guest/grant ID; null identifies the local data owner. */
  membershipId: string | null;
}
