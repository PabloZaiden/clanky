/**
 * Authenticated client admission and deterministic revocation of guest access.
 */
import type { AcceptCollaborationInvitation } from "@/contracts/schemas/collaboration";
import type { CollaborationRevocation } from "@/shared/collaboration";
import { runWithCollaborationActor, runWithCurrentUser } from "../context/user-context";
import { DomainError } from "../domain/domain-error";
import { ensureLocalMeshNodeIdentity } from "../persistence/mesh-node-identity";
import { getCollaborationOwnerUser } from "../persistence/collaboration-storage";
import { collaborationService } from "./collaboration-service";
import { controllerRelayService } from "./controller-relay-service";
import { terminalSessionManager } from "./terminal-session-manager";
import { previewSessionManager } from "./preview-session-manager";
import { validateCollaborationIdentity } from "./collaboration-identity";
import { WorkspaceClientProofVerifier } from "./workspace-client-proof";

class WorkspaceClientController {
  private readonly proofs = new WorkspaceClientProofVerifier();
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
      throw new DomainError("collaboration_transport_required", "An authenticated TLS relay transport is required.");
    }
    const identity = await ensureLocalMeshNodeIdentity();
    return this.proofs.verify({
      headers: input.headers,
      initiatorNodeId: input.initiatorNodeId,
      publicKey: input.publicKey,
      controllerNodeId: identity.nodeId,
    });
  }

  async enroll(input: Omit<AcceptCollaborationInvitation, "token"> & { token?: string }) {
    validateCollaborationIdentity(input.guest);
    const previous = collaborationService.getGrantByNodeId(input.guest.nodeId);
    if (previous) {
      if (previous.revokedAt !== null || previous.identity.publicKey !== input.guest.publicKey
        || previous.identity.fingerprint !== input.guest.fingerprint
        || previous.relayUrl !== input.relayUrl || previous.relayFingerprint !== input.relayFingerprint) {
        throw new DomainError("collaboration_access_denied", "The pairing is no longer authorized.");
      }
      await controllerRelayService.synchronizeWorkspaceClients();
      return previous;
    }
    if (!input.token) {
      throw new DomainError("collaboration_invitation_required", "A workspace invitation is required to pair a new client.");
    }
    const grant = collaborationService.acceptInvitation({ ...input, token: input.token });
    this.changed?.(grant.ownerUserId);
    await controllerRelayService.synchronizeWorkspaceClients();
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
      controllerRelayService.synchronizeWorkspaceClients(),
      this.revokeTransports?.(event),
      this.closeInteractiveResources(event),
    ]);
    const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Collaborator access was revoked but transport cleanup failed.");
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
    this.revokeTransports = undefined;
    this.changed = undefined;
  }
}

export const workspaceClientController = new WorkspaceClientController();
