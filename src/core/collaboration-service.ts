/**
 * Controller invitations, guest grants, scoped access, and local pairing APIs.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  CollaborationGuestGrant,
  CollaborationGuestAccess,
  CollaborationWorkspacePermission,
  CollaborationInvitation,
  CollaborationRelayRoute,
  CollaborationRevocation,
  CreatedCollaborationInvitation,
} from "@/shared/collaboration";
import { COLLABORATION_PROTOCOL_VERSION } from "@/shared/collaboration";
import type { MeshRelayPeerIdentity } from "@/shared/mesh-relay";
import {
  AcceptCollaborationInvitationSchema,
  CollaborationIdSchema,
  CreateCollaborationInvitationSchema,
  CollaborationWorkspacePermissionSchema,
  type AcceptCollaborationInvitation,
  type CreateCollaborationInvitation,
} from "@/contracts/schemas/collaboration";
import { DomainError } from "../domain/domain-error";
import { ensureLocalMeshNodeIdentity } from "../persistence/mesh-node-identity";
import {
  consumeCollaborationInvitation,
  listCollaborationInvitations,
  revokeCollaborationInvitation,
  saveCollaborationInvitation,
} from "../persistence/collaboration-invitations";
import {
  getCollaborationGuestByNodeInternal,
  listActiveCollaborationGuestsInternal,
  listCollaborationGuests,
  revokeCollaborationGuest,
  updateCollaborationWorkspacePermission,
} from "../persistence/collaboration-guests";
import { requireCollaborationWorkspaces } from "../persistence/collaboration-storage";
import { controllerRelayService } from "./controller-relay-service";
import {
  getCollaborationCreator,
  recordCollaborationCreator,
  requireCollaborationLocalUserId,
  requireWorkspaceAccess,
  withWorkspaceAccess,
  getCollaborationControllerAccess,
} from "./collaboration-authority";
import { CollaborationConnections } from "./collaboration-connections";
import { parseCollaborationInput, validateCollaborationIdentity } from "./collaboration-identity";
import { CollaborationSubscriptions } from "./collaboration-subscriptions";
import {
  authorizeInteractiveResource,
  claimInteractiveResource,
  getInteractiveResourceInternal,
  listGuestInteractiveResourcesInternal,
  listInteractiveResources,
} from "./collaboration-interactive";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

class CollaborationService {
  private readonly revocations = new CollaborationSubscriptions<CollaborationRevocation>();
  private readonly connections = new CollaborationConnections();

  readonly requireWorkspaceAccess = requireWorkspaceAccess;
  readonly withWorkspaceAccess = withWorkspaceAccess;
  readonly getControllerAccess = getCollaborationControllerAccess;
  readonly recordCreator = recordCollaborationCreator;
  readonly getCreator = getCollaborationCreator;
  readonly claimInteractiveResource = claimInteractiveResource;
  readonly authorizeInteractiveResource = authorizeInteractiveResource;
  readonly listInteractiveResources = listInteractiveResources;
  readonly listGuestInteractiveResourcesInternal = listGuestInteractiveResourcesInternal;
  readonly getInteractiveResourceInternal = getInteractiveResourceInternal;
  readonly createPendingConnection = this.connections.createPendingConnection.bind(this.connections);
  readonly activateConnection = this.connections.activateConnection.bind(this.connections);
  readonly listConnections = this.connections.listConnections.bind(this.connections);
  readonly listActiveConnectionsInternal = this.connections.listActiveConnectionsInternal.bind(this.connections);
  readonly loadConnectionIdentity = this.connections.loadConnectionIdentity.bind(this.connections);
  readonly loadConnectionIdentityInternal = this.connections.loadConnectionIdentityInternal.bind(this.connections);
  readonly revokeConnection = this.connections.revokeConnection.bind(this.connections);
  readonly deleteConnection = this.connections.deleteConnection.bind(this.connections);
  readonly onConnectionChanged = this.connections.onConnectionChanged.bind(this.connections);

  async createInvitation(input: CreateCollaborationInvitation): Promise<CreatedCollaborationInvitation> {
    const ownerUserId = requireCollaborationLocalUserId();
    const parsed = parseCollaborationInput(CreateCollaborationInvitationSchema, input);
    if (!parsed.allWorkspacesAdmin) requireCollaborationWorkspaces(ownerUserId, parsed.workspaceIds);
    const target = await controllerRelayService.resolveEnrollmentInvitationTarget("relay", "", parsed.relayName);
    if (!target.relay) {
      throw new DomainError("collaboration_relay_required", "Workspace collaboration requires a paired relay.");
    }
    const identity = await ensureLocalMeshNodeIdentity();
    const controller = validateCollaborationIdentity({
      nodeId: identity.nodeId, publicKey: identity.publicKey, fingerprint: identity.fingerprint,
    });
    const now = new Date();
    const token = randomBytes(32).toString("base64url");
    const invitation: CollaborationInvitation = {
      id: randomUUID(), name: parsed.name ?? null, workspaceIds: parsed.workspaceIds,
      allWorkspacesAdmin: parsed.allWorkspacesAdmin,
      workspacePermissions: Object.fromEntries(parsed.workspaceIds.map((id) => [id, parsed.workspacePermissions?.[id] ?? "work"])),
      protocolVersion: COLLABORATION_PROTOCOL_VERSION, controller,
      ...target.relay, createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + parsed.ttlSeconds * 1_000).toISOString(),
      consumedAt: null, revokedAt: null,
    };
    saveCollaborationInvitation(ownerUserId, hashToken(token), invitation);
    return { token, invitation, controller, ...target.relay };
  }

  listInvitations(): CollaborationInvitation[] {
    return listCollaborationInvitations(requireCollaborationLocalUserId());
  }

  revokeInvitation(id: string): void {
    parseCollaborationInput(CollaborationIdSchema, id);
    revokeCollaborationInvitation(requireCollaborationLocalUserId(), id, new Date().toISOString());
  }

  /**
   * The transport must verify possession of guest.publicKey before calling.
   * This boundary rechecks route trust, invitation state, and all memberships.
   */
  acceptInvitation(input: AcceptCollaborationInvitation): CollaborationGuestGrant {
    const parsed = parseCollaborationInput(AcceptCollaborationInvitationSchema, input);
    validateCollaborationIdentity(parsed.guest);
    controllerRelayService.assertEnrollmentRelayRoute(parsed);
    return consumeCollaborationInvitation({
      ...parsed, tokenHash: hashToken(parsed.token), now: new Date().toISOString(),
    });
  }

  /** Internal lookup for a transport that has already verified node possession. */
  getGrantByNodeId(nodeId: string): CollaborationGuestAccess | undefined {
    parseCollaborationInput(CollaborationIdSchema, nodeId);
    const guest = getCollaborationGuestByNodeInternal(nodeId);
    if (guest) validateCollaborationIdentity(guest.identity);
    return guest;
  }

  getAuthenticatedGuest(nodeId: string): CollaborationGuestAccess | undefined {
    const guest = this.getGrantByNodeId(nodeId);
    return guest?.revokedAt === null ? guest : undefined;
  }

  listActiveGuestsInternal(): CollaborationGuestAccess[] {
    const guests = listActiveCollaborationGuestsInternal();
    for (const guest of guests) validateCollaborationIdentity(guest.identity);
    return guests;
  }

  listActiveRelayIdentities(route: CollaborationRelayRoute): MeshRelayPeerIdentity[] {
    return this.listActiveGuestsInternal()
      .filter((guest) => guest.relayUrl === route.relayUrl && guest.relayFingerprint === route.relayFingerprint)
      .map((guest) => guest.identity);
  }

  listGuests(): CollaborationGuestAccess[] {
    return listCollaborationGuests(requireCollaborationLocalUserId());
  }

  updateWorkspacePermission(id: string, workspaceId: string, permission: CollaborationWorkspacePermission): void {
    parseCollaborationInput(CollaborationIdSchema, id);
    parseCollaborationInput(CollaborationIdSchema, workspaceId);
    parseCollaborationInput(CollaborationWorkspacePermissionSchema, permission);
    updateCollaborationWorkspacePermission({
      ownerUserId: requireCollaborationLocalUserId(), guestId: id, workspaceId, permission,
    });
  }

  revokeGuest(id: string): void {
    parseCollaborationInput(CollaborationIdSchema, id);
    const event = revokeCollaborationGuest({
      ownerUserId: requireCollaborationLocalUserId(), guestId: id, now: new Date().toISOString(),
    });
    if (event) this.revocations.publish(event);
  }

  revokeGuestWorkspace(id: string, workspaceId: string): void {
    parseCollaborationInput(CollaborationIdSchema, id);
    parseCollaborationInput(CollaborationIdSchema, workspaceId);
    const event = revokeCollaborationGuest({
      ownerUserId: requireCollaborationLocalUserId(), guestId: id, workspaceId, now: new Date().toISOString(),
    });
    if (event) this.revocations.publish(event);
  }

  onRevoked(listener: (event: CollaborationRevocation) => void): () => void {
    return this.revocations.subscribe(listener);
  }
}

export const collaborationService = new CollaborationService();
