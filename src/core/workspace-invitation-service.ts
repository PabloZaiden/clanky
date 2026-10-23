/**
 * Copyable, controller-signed invitations with relay-bound client admission.
 */
import type { CreateCollaborationInvitation } from "@/contracts/schemas/collaboration";
import { ensureLocalMeshNodeIdentity, signMeshPayload } from "../persistence/mesh-node-identity";
import { collaborationService } from "./collaboration-service";
import { controllerRelayService } from "./controller-relay-service";
import { createMeshRelayEnrollmentAdmission } from "./mesh-relay-admission";
import { encodeWorkspaceInvitation } from "./workspace-client-proof";
import { DomainError } from "../domain/domain-error";

export async function createWorkspaceInvitation(input: CreateCollaborationInvitation) {
  const target = await controllerRelayService.resolveEnrollmentInvitationTarget("relay", "", input.relayName);
  if (!target.relay) {
    throw new DomainError("collaboration_relay_required", "A paired relay is required.");
  }
  await controllerRelayService.assertWorkspaceClientSupport(target.relay);
  const created = await collaborationService.createInvitation(input);
  const identity = await ensureLocalMeshNodeIdentity();
  const relayAdmission = await createMeshRelayEnrollmentAdmission({
    controllerNodeId: identity.nodeId,
    controllerFingerprint: identity.fingerprint,
    expiresAt: created.invitation.expiresAt,
    peerRole: "client",
  });
  const token = await encodeWorkspaceInvitation({
    version: 1,
    token: created.token,
    expiresAt: created.invitation.expiresAt,
    controller: {
      ...created.controller,
      name: identity.instanceName ?? "Clanky",
    },
    relay: {
      url: created.relayUrl,
      fingerprint: created.relayFingerprint,
    },
    relayAdmission,
  }, signMeshPayload);
  return { invitation: created.invitation, token };
}
