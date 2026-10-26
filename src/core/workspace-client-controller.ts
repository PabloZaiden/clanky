/**
 * Authenticated client admission and deterministic revocation of guest access.
 */
import { workspaceDirectReadyPayload, type WorkspaceClientEnrollment, type WorkspaceDirectOpen } from "@/contracts/schemas/mesh-client";
import { MESH_RELAY_CLIENT_ENROLLMENT_PATH } from "@/shared/mesh-relay";
import type { CollaborationRevocation, CollaborationWorkspacePermission } from "@/shared/collaboration";
import { runWithCollaborationActor, runWithCurrentUser } from "../context/user-context";
import { DomainError } from "../domain/domain-error";
import { ensureLocalMeshNodeIdentity, signMeshPayload } from "../persistence/mesh-node-identity";
import { getCollaborationOwnerUser } from "../persistence/collaboration-storage";
import { collaborationService } from "./collaboration-service";
import { controllerRelayService } from "./controller-relay-service";
import { terminalSessionManager } from "./terminal-session-manager";
import { previewSessionManager } from "./preview-session-manager";
import { validateCollaborationIdentity } from "./collaboration-identity";
import { WorkspaceClientProofVerifier } from "./workspace-client-proof";
import { sameCollaborationRoute } from "@/shared/collaboration";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";

class WorkspaceClientController {
  private readonly proofs = new WorkspaceClientProofVerifier();
  private readonly directProofs = new WorkspaceClientProofVerifier();
  private revokeTransports?: (event: CollaborationRevocation) => Promise<void>;
  private changed?: (ownerUserId: string) => void;

  configure(input: {
    revokeTransports(event: CollaborationRevocation): Promise<void>;
    changed(ownerUserId: string): void;
  }): void {
    this.revokeTransports = input.revokeTransports;
    this.changed = input.changed;
    controllerRelayService.configureWorkspaceClients((route) => collaborationService.listActiveRelayIdentities(route));
  }

  async verifyProof(input: {
    headers: Headers;
    initiatorNodeId: string | undefined;
    publicKey: string;
    secureTransport: boolean;
  }) {
    if (!input.secureTransport || !input.initiatorNodeId) {
      throw new DomainError("collaboration_transport_required", "An authenticated TLS collaboration transport is required.");
    }
    const identity = await ensureLocalMeshNodeIdentity();
    return this.proofs.verify({
      headers: input.headers,
      initiatorNodeId: input.initiatorNodeId,
      publicKey: input.publicKey,
      controllerNodeId: identity.nodeId,
    });
  }

  async admitDirectStream(opening: WorkspaceDirectOpen) {
    validateCollaborationIdentity(opening.identity);
    const identity = await ensureLocalMeshNodeIdentity();
    const metadata = this.directProofs.verify({
      headers: new Headers(opening.headers), publicKey: opening.identity.publicKey,
      initiatorNodeId: opening.identity.nodeId, controllerNodeId: identity.nodeId,
    });
    if (metadata.requestId !== opening.requestId) {
      throw new DomainError("collaboration_request_invalid", "The direct workspace request identity does not match.");
    }
    const enrollment = metadata.kind === "enrollment";
    if (opening.kind === "probe" && (!enrollment || metadata.path !== MESH_RELAY_CLIENT_ENROLLMENT_PATH
      || metadata.method !== "POST" || metadata.bodySha256)
      || opening.kind === "http" && (metadata.kind !== "enrollment" && metadata.kind !== "operation")
      || opening.kind === "socket" && !["realtime", "terminal", "preview"].includes(metadata.kind)) {
      throw new DomainError("collaboration_operation_forbidden", "This direct workspace operation is unavailable.");
    }
    const ready = {
      type: "stream.ready" as const, protocolVersion: MESH_PROTOCOL_VERSION,
      requestId: opening.requestId, streamId: opening.streamId,
    };
    return { enrollment, ready: { ...ready, signature: await signMeshPayload(workspaceDirectReadyPayload(ready)) } };
  }

  async enroll(input: WorkspaceClientEnrollment) {
    validateCollaborationIdentity(input.guest);
    const previous = collaborationService.getGrantByNodeId(input.guest.nodeId);
    if (previous) {
      if (previous.revokedAt !== null || previous.identity.publicKey !== input.guest.publicKey
        || previous.identity.fingerprint !== input.guest.fingerprint
        || !sameCollaborationRoute(previous, input)) {
        throw new DomainError("collaboration_access_denied", "The pairing is no longer authorized.");
      }
      if (previous.controllerUrl === undefined) await controllerRelayService.synchronizeWorkspaceClients();
      return previous;
    }
    if (!input.token) {
      throw new DomainError("collaboration_invitation_required", "A workspace invitation is required to pair a new client.");
    }
    const grant = await collaborationService.acceptInvitation({ ...input, token: input.token });
    this.changed?.(grant.ownerUserId);
    if (grant.controllerUrl === undefined) await controllerRelayService.synchronizeWorkspaceClients();
    return grant;
  }

  async revoke(guestId: string, workspaceId?: string): Promise<void> {
    const guest = collaborationService.listGuests().find((item) => item.id === guestId);
    if (!guest) throw new DomainError("collaboration_guest_not_found", "Collaborator not found.");
    if (workspaceId) collaborationService.revokeGuestWorkspace(guestId, workspaceId);
    else collaborationService.revokeGuest(guestId);
    const event: CollaborationRevocation = {
      guestId, nodeId: guest.identity.nodeId, ownerUserId: guest.ownerUserId,
      workspaceIds: workspaceId ? [workspaceId] : guest.workspaceIds,
      wholeGuest: !workspaceId,
    };
    this.changed?.(guest.ownerUserId);
    const outcomes = await Promise.allSettled([
      ...(guest.controllerUrl === undefined ? [controllerRelayService.synchronizeWorkspaceClients()] : []),
      this.revokeTransports?.(event),
      this.closeInteractiveResources(event),
    ]);
    const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Collaborator access was revoked but transport cleanup failed.");
  }

  async updatePermission(guestId: string, workspaceId: string, permission: CollaborationWorkspacePermission): Promise<void> {
    const guest = collaborationService.listGuests().find((item) => item.id === guestId);
    if (!guest) throw new DomainError("collaboration_guest_not_found", "Collaborator not found.");
    collaborationService.updateWorkspacePermission(guestId, workspaceId, permission);
    this.changed?.(guest.ownerUserId);
    const event: CollaborationRevocation = {
      guestId, nodeId: guest.identity.nodeId, ownerUserId: guest.ownerUserId,
      workspaceIds: [workspaceId], wholeGuest: false,
    };
    // Reconnect realtime to refresh effective permissions as well as closing write-capable streams.
    const outcomes = await Promise.allSettled([
      this.revokeTransports?.(event),
      ...(permission === "read" ? [this.closeInteractiveResources(event)] : []),
    ]);
    const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Workspace permissions changed but transport cleanup failed.");
  }

  private async closeInteractiveResources(event: CollaborationRevocation): Promise<void> {
    const owner = getCollaborationOwnerUser(event.ownerUserId);
    if (!owner) throw new DomainError("collaboration_user_unavailable", "The workspace owner is unavailable.");
    const resources = collaborationService.listGuestInteractiveResourcesInternal({
      guestId: event.guestId, ownerUserId: event.ownerUserId, workspaceIds: event.workspaceIds,
    });
    await runWithCurrentUser(owner, async () => await runWithCollaborationActor(
      { kind: "user", userId: owner.id },
      async () => {
        for (const resource of resources) {
          await collaborationService.withWorkspaceAccess(resource.workspaceId, async () => {
            if (resource.kind === "terminal") await terminalSessionManager.deleteSession(resource.id);
            else await previewSessionManager.closePreview(resource.id, "Workspace access revoked", 1008);
          });
        }
      },
    ));
  }

  stop(): void {
    this.proofs.clear();
    this.directProofs.clear();
    this.revokeTransports = undefined;
    this.changed = undefined;
  }
}

export const workspaceClientController = new WorkspaceClientController();
