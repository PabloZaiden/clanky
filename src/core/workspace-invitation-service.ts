/**
 * Controller-signed invitations bound to a direct or paired-relay route.
 */
import type { CreateCollaborationInvitation } from "@/contracts/schemas/collaboration";
import { ensureLocalMeshNodeIdentity, signMeshPayload } from "../persistence/mesh-node-identity";
import { collaborationService } from "./collaboration-service";
import { createMeshRelayEnrollmentAdmission } from "./mesh-relay-admission";
import { encodeWorkspaceInvitation } from "./workspace-client-proof";

export async function createWorkspaceInvitation(input: CreateCollaborationInvitation) {
  const created = await collaborationService.createInvitation(input);
  const identity = await ensureLocalMeshNodeIdentity();
  const common = {
    version: 1 as const,
    token: created.token,
    expiresAt: created.invitation.expiresAt,
    controller: { ...created.controller, name: identity.instanceName ?? "Clanky" },
  };
  if (created.controllerUrl !== undefined) {
    return { invitation: created.invitation, token: await encodeWorkspaceInvitation({
      ...common, controllerUrl: created.controllerUrl,
    }, signMeshPayload) };
  }
  const relayAdmission = await createMeshRelayEnrollmentAdmission({
    controllerNodeId: identity.nodeId,
    controllerFingerprint: identity.fingerprint,
    expiresAt: created.invitation.expiresAt,
    peerRole: "client",
  });
  const token = await encodeWorkspaceInvitation({
    ...common,
    relay: {
      url: created.relayUrl,
      fingerprint: created.relayFingerprint,
    },
    relayAdmission,
  }, signMeshPayload);
  return { invitation: created.invitation, token };
}
