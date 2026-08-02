/**
 * Canonical payloads for signed mesh control messages.
 */

import type {
  MeshPeerPairingApproval,
  MeshPeerPairingRequest,
  MeshSyncAck,
  MeshSyncPush,
  MeshTakeoverEnvelope,
} from "@/contracts/schemas/mesh";

type UnsignedPairingRequest = Omit<MeshPeerPairingRequest, "signature">;
type UnsignedPairingApproval = Omit<MeshPeerPairingApproval, "signature">;
type UnsignedSyncPush = Omit<MeshSyncPush, "signature">;
type UnsignedSyncAck = Omit<MeshSyncAck, "signature">;
type UnsignedTakeover = Omit<MeshTakeoverEnvelope, "signature">;

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
    envelope.activeNodeId,
    envelope.takeoverGeneration,
    envelope.endpoint,
    envelope.transport,
    envelope.publicKey,
    envelope.fingerprint,
    envelope.encryptionPublicKey ?? null,
    envelope.members ?? [],
  ]);
}

export function buildMeshSyncPushSigningPayload(envelope: UnsignedSyncPush): string {
  return JSON.stringify([
    "clanky-mesh-sync-push-v1",
    envelope.protocolVersion,
    envelope.linkId,
    envelope.senderNodeId,
    envelope.senderPublicKey,
    envelope.senderFingerprint,
    envelope.senderEncryptionPublicKey ?? null,
    envelope.nonce,
    envelope.members ?? [],
    envelope.takeover ?? null,
    envelope.checkpoints,
  ]);
}

export function buildMeshSyncAckSigningPayload(envelope: UnsignedSyncAck): string {
  return JSON.stringify([
    "clanky-mesh-sync-ack-v1",
    envelope.protocolVersion,
    envelope.linkId,
    envelope.senderNodeId,
    envelope.senderPublicKey,
    envelope.senderFingerprint,
    envelope.senderEncryptionPublicKey ?? null,
    envelope.nonce,
    envelope.acknowledgements,
  ]);
}

export function buildMeshTakeoverSigningPayload(envelope: UnsignedTakeover): string {
  return JSON.stringify([
    "clanky-mesh-takeover-v1",
    envelope.protocolVersion,
    envelope.linkId,
    envelope.senderNodeId,
    envelope.senderPublicKey,
    envelope.senderFingerprint,
    envelope.generation,
    envelope.claimedAt,
    envelope.claimOrigin,
  ]);
}
