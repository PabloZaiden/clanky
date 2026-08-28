/**
 * Canonical payloads for signed mesh control messages.
 */

import type {
  MeshPeerPairingApproval,
  MeshPeerPairingRequest,
  MeshHealthCheck,
  MeshMembershipUpdate,
} from "@/contracts/schemas/mesh";
import type { MeshExecutionSessionRequest } from "@/contracts/schemas/mesh-execution";

type UnsignedPairingRequest = Omit<MeshPeerPairingRequest, "signature">;
type UnsignedPairingApproval = Omit<MeshPeerPairingApproval, "signature">;
type UnsignedMembershipUpdate = Omit<MeshMembershipUpdate, "signature">;
type UnsignedHealthCheck = Omit<MeshHealthCheck, "signature">;
type UnsignedExecutionSession = Omit<MeshExecutionSessionRequest, "signature">;

export function buildMeshPairingRequestSigningPayload(
  envelope: UnsignedPairingRequest,
): string {
  return JSON.stringify([
    "clanky-mesh-pairing-request-v1",
    envelope.protocolVersion,
    envelope.requestId,
    envelope.linkId ?? null,
    envelope.targetLocalUserId ?? null,
    envelope.requestedNodeId,
    envelope.requestedInstanceName ?? null,
    envelope.requestedLocalUserId,
    envelope.requestedUsername ?? null,
    envelope.endpoint,
    envelope.transport,
    envelope.publicKey,
    envelope.fingerprint,
    envelope.encryptionPublicKey ?? null,
    envelope.nonce,
    envelope.expiresAt,
  ]);
}

export function buildMeshPairingApprovalSigningPayload(
  envelope: UnsignedPairingApproval,
): string {
  return JSON.stringify([
    "clanky-mesh-pairing-approval-v1",
    envelope.protocolVersion,
    envelope.requestId,
    envelope.linkId,
    envelope.approvedByNodeId,
    envelope.approvedByInstanceName ?? null,
    envelope.approvedByLocalUserId,
    envelope.endpoint,
    envelope.transport,
    envelope.publicKey,
    envelope.fingerprint,
    envelope.encryptionPublicKey ?? null,
    envelope.members ?? [],
  ]);
}

export function buildMeshMembershipUpdateSigningPayload(
  envelope: UnsignedMembershipUpdate,
): string {
  return JSON.stringify([
    "clanky-mesh-membership-update-v1",
    envelope.protocolVersion,
    envelope.linkId,
    envelope.senderNodeId,
    envelope.senderPublicKey,
    envelope.senderFingerprint,
    envelope.senderEncryptionPublicKey ?? null,
    envelope.nonce,
    envelope.members,
  ]);
}

export function buildMeshHealthCheckSigningPayload(
  envelope: UnsignedHealthCheck,
): string {
  return JSON.stringify([
    "clanky-mesh-health-check-v1",
    envelope.protocolVersion,
    envelope.linkId,
    envelope.senderNodeId,
    envelope.senderPublicKey,
    envelope.senderFingerprint,
    envelope.nonce,
    envelope.sentAt,
  ]);
}

export function buildMeshExecutionSessionSigningPayload(
  envelope: UnsignedExecutionSession,
): string {
  return JSON.stringify([
    "clanky-mesh-execution-session-v1",
    envelope.protocolVersion,
    envelope.requestId,
    envelope.linkId,
    envelope.callerNodeId,
    envelope.callerPublicKey,
    envelope.callerFingerprint,
    envelope.callerEncryptionPublicKey ?? null,
    envelope.targetNodeId,
    envelope.workspaceId,
    envelope.directory,
    envelope.provider,
    envelope.channel,
    envelope.nonce,
    envelope.expiresAt,
  ]);
}
