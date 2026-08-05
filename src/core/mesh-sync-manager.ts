import {
  MeshSyncAckSchema,
  type MeshSyncAck,
  type MeshSyncPush,
} from "@/contracts/schemas/mesh";
import type { MeshSyncCheckpointRecord } from "@/shared/mesh";
import {
  advanceMeshSyncCursor,
  acknowledgeMeshSyncOutbox,
  getMeshSyncCheckpoint,
  getMeshSyncPeerNode,
  listDueMeshSyncOutbox,
  markMeshSyncOutboxRetry,
} from "../persistence/mesh-sync";
import {
  getMeshNode,
  getActiveMeshLinkTakeover,
  applyMeshLinkTakeover,
  listMeshLinkMembers,
  mergeMeshLinkMember,
} from "../persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  signMeshPayload,
  verifyMeshPayloadSignature,
} from "../persistence/mesh-node-identity";
import {
  buildMeshSyncAckSigningPayload,
  buildMeshSyncPushSigningPayload,
  buildMeshTakeoverSigningPayload,
} from "./mesh-protocol";
import { postMeshControlMessage } from "./mesh-control-client";
import { resolveMeshRoute } from "./mesh-transport-config";
import { applyMeshCheckpoint } from "./mesh-sync-service";
import { DomainError } from "./domain-error";
import { decryptMeshCheckpoint, encryptMeshCheckpoint } from "./mesh-payload-crypto";
import {
  assertMeshPeerIdentity,
  requireTrustedMeshPeer,
} from "./mesh-peer-auth";

async function assertTrustedPeer(
  linkId: string,
  nodeId: string,
  publicKey: string,
  fingerprint: string,
  encryptionPublicKey?: string,
  options: { requireEncryptionKey?: boolean } = {},
): Promise<void> {
  await requireTrustedMeshPeer({
    linkId,
    nodeId,
    publicKey,
    fingerprint,
    encryptionPublicKey,
    requireEncryptionKey: options.requireEncryptionKey,
    context: "mesh sync sender",
  });
}

async function getMeshLinkMemberSnapshots(linkId: string): Promise<Array<{
  nodeId: string;
  instanceName: string | null;
  localUserId: string;
  endpoint: string | null;
  transport: "https" | "http";
  status: "pending" | "active" | "offline" | "revoked" | "rejoining";
  membershipGeneration: number;
  publicKey: string;
  fingerprint: string;
  encryptionPublicKey?: string;
}>> {
  const snapshots = [];
  for (const member of await listMeshLinkMembers(linkId)) {
    const node = await getMeshNode(member.nodeId);
    if (!node) {
      throw new DomainError("mesh_peer_not_found", "A mesh link member has no node identity.");
    }
    snapshots.push({
      nodeId: member.nodeId,
      instanceName: node.instanceName,
      localUserId: member.localUserId,
      endpoint: member.endpoint,
      transport: member.transport,
      status: member.status,
      membershipGeneration: member.membershipGeneration,
      publicKey: node.publicKey,
      fingerprint: node.fingerprint,
      encryptionPublicKey: node.encryptionPublicKey,
    });
  }
  return snapshots;
}

export async function receiveMeshSyncPush(
  envelope: MeshSyncPush,
  headerNodeId?: string,
): Promise<MeshSyncAck> {
  if (headerNodeId && headerNodeId !== envelope.senderNodeId) {
    throw new DomainError("mesh_peer_identity_mismatch", "The mesh sync node header does not match the signed sender.");
  }
  const { signature, ...unsigned } = envelope;
  await assertTrustedPeer(
    envelope.linkId,
    envelope.senderNodeId,
    envelope.senderPublicKey,
    envelope.senderFingerprint,
    envelope.senderEncryptionPublicKey,
  );
  if (!verifyMeshPayloadSignature(
    buildMeshSyncPushSigningPayload(unsigned),
    signature,
    envelope.senderPublicKey,
  )) {
    throw new DomainError("mesh_peer_signature_invalid", "The mesh sync signature is invalid.");
  }


  if (envelope.takeover) {
    if (envelope.takeover.linkId !== envelope.linkId) {
      throw new DomainError("mesh_sync_link_mismatch", "The relayed takeover claim targets another link.");
    }
    await assertTrustedPeer(
      envelope.linkId,
      envelope.takeover.senderNodeId,
      envelope.takeover.senderPublicKey,
      envelope.takeover.senderFingerprint,
      undefined,
      { requireEncryptionKey: false },
    );
    const { signature: takeoverSignature, ...takeoverUnsigned } = envelope.takeover;
    if (!verifyMeshPayloadSignature(
      buildMeshTakeoverSigningPayload(takeoverUnsigned),
      takeoverSignature,
      envelope.takeover.senderPublicKey,
    )) {
      throw new DomainError("mesh_peer_signature_invalid", "The mesh sync takeover signature is invalid.");
    }
    await applyMeshLinkTakeover({
      linkId: envelope.takeover.linkId,
      nodeId: envelope.takeover.senderNodeId,
      generation: envelope.takeover.generation,
      claimedAt: envelope.takeover.claimedAt,
      claimOrigin: envelope.takeover.claimOrigin,
      signature: takeoverSignature,
    });
  }

  for (const member of envelope.members ?? []) {
    assertMeshPeerIdentity(member.publicKey, member.fingerprint, "mesh sync member");
    await mergeMeshLinkMember({
      linkId: envelope.linkId,
      nodeId: member.nodeId,
      instanceName: member.instanceName,
      localUserId: member.localUserId,
      endpoint: member.endpoint,
      transport: member.transport,
      status: member.status,
      membershipGeneration: member.membershipGeneration,
      publicKey: member.publicKey,
      fingerprint: member.fingerprint,
      encryptionPublicKey: member.encryptionPublicKey,
    });
  }

  const checkpoints = await Promise.all(
    envelope.checkpoints.map((checkpoint) => decryptMeshCheckpoint(checkpoint as MeshSyncCheckpointRecord)),
  );
  const acknowledgements: MeshSyncAck["acknowledgements"] = [];
  for (const checkpoint of checkpoints) {
    if (checkpoint.linkId !== envelope.linkId) {
      throw new DomainError("mesh_sync_link_mismatch", "A mesh checkpoint targets another link.");
    }
    const result = await applyMeshCheckpoint(
      envelope.senderNodeId,
      checkpoint as MeshSyncCheckpointRecord,
    );
    acknowledgements.push({
      checkpointId: checkpoint.checkpointId,
      aggregateType: checkpoint.aggregateType,
      aggregateId: checkpoint.aggregateId,
      originNodeId: checkpoint.originNodeId,
      appliedRevision: result.appliedRevision,
    });
  }

  const identity = await ensureLocalMeshNodeIdentity();
  const ackUnsigned = {
    protocolVersion: 1 as const,
    linkId: envelope.linkId,
    senderNodeId: identity.nodeId,
    senderPublicKey: identity.publicKey,
    senderFingerprint: identity.fingerprint,
    senderEncryptionPublicKey: identity.encryptionPublicKey,
    nonce: envelope.nonce,
    acknowledgements,
  };
  const ackSignature = await signMeshPayload(buildMeshSyncAckSigningPayload(ackUnsigned));
  return { ...ackUnsigned, signature: ackSignature };
}

async function validateAck(
  ack: MeshSyncAck,
  expectedPeerNodeId: string,
  expectedLinkId: string,
  expectedNonce: string,
): Promise<void> {
  if (
    ack.senderNodeId !== expectedPeerNodeId
    || ack.linkId !== expectedLinkId
    || ack.nonce !== expectedNonce
  ) {
    throw new DomainError("mesh_sync_ack_mismatch", "The mesh sync acknowledgement does not match the request.");
  }
  await assertTrustedPeer(
    ack.linkId,
    ack.senderNodeId,
    ack.senderPublicKey,
    ack.senderFingerprint,
    ack.senderEncryptionPublicKey,
  );
  const { signature, ...unsigned } = ack;
  if (!verifyMeshPayloadSignature(
    buildMeshSyncAckSigningPayload(unsigned),
    signature,
    ack.senderPublicKey,
  )) {
    throw new DomainError("mesh_peer_signature_invalid", "The mesh sync acknowledgement signature is invalid.");
  }
}

export async function deliverMeshSyncOutbox(limit = 25): Promise<number> {
  const outbox = await listDueMeshSyncOutbox(limit);
  if (outbox.length === 0) {
    return 0;
  }
  const localIdentity = await ensureLocalMeshNodeIdentity();
  const groups = new Map<string, typeof outbox>();
  for (const item of outbox) {
    const key = `${item.peerNodeId}:${item.linkId}:${item.aggregateType}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  let delivered = 0;
  for (const group of groups.values()) {
    const first = group[0]!;
    try {
      const peer = await getMeshSyncPeerNode(first.peerNodeId);
      if (!peer?.endpoint || (peer.status === "revoked" && first.aggregateType !== "mesh_membership")) {
        throw new Error(`Mesh peer endpoint is unavailable: ${first.peerNodeId}`);
      }
      if (!peer.encryptionPublicKey) {
        throw new DomainError(
          "mesh_peer_encryption_unavailable",
          "The mesh peer has no recipient encryption key.",
        );
      }
      const checkpoints: MeshSyncCheckpointRecord[] = [];
      for (const item of group) {
        const checkpoint = await getMeshSyncCheckpoint(item.checkpointId);
        if (!checkpoint) {
          throw new Error(`Mesh checkpoint is unavailable: ${item.checkpointId}`);
        }
        checkpoints.push(encryptMeshCheckpoint(checkpoint, peer.encryptionPublicKey));
      }
      const unsigned = {
        protocolVersion: 1 as const,
        linkId: first.linkId,
        senderNodeId: localIdentity.nodeId,
        senderPublicKey: localIdentity.publicKey,
        senderFingerprint: localIdentity.fingerprint,
        senderEncryptionPublicKey: localIdentity.encryptionPublicKey,
        nonce: crypto.randomUUID(),
        members: await getMeshLinkMemberSnapshots(first.linkId),
        takeover: await getActiveMeshLinkTakeover(first.linkId).then((claim) => (
          claim?.signature
            ? {
              protocolVersion: 1 as const,
              linkId: claim.linkId,
              senderNodeId: claim.nodeId,
              senderPublicKey: claim.publicKey,
              senderFingerprint: claim.fingerprint,
              generation: claim.generation,
              claimedAt: claim.claimedAt,
              claimOrigin: claim.claimOrigin,
              signature: claim.signature,
            }
            : undefined
        )),
        checkpoints,
      };
      const signature = await signMeshPayload(buildMeshSyncPushSigningPayload(unsigned));
      const response = await postMeshControlMessage(
        resolveMeshRoute(peer.endpoint, "api/mesh/internal/sync"),
        { ...unsigned, signature },
        unsigned.nonce,
      );
      const parsed = MeshSyncAckSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new DomainError("mesh_sync_ack_invalid", "The mesh sync acknowledgement has an invalid shape.", {
          details: { issues: parsed.error.issues },
        });
      }
      await validateAck(parsed.data, first.peerNodeId, first.linkId, unsigned.nonce);
      for (const ack of parsed.data.acknowledgements) {
        await acknowledgeMeshSyncOutbox(
          first.peerNodeId,
          ack.aggregateType,
          ack.aggregateId,
          ack.originNodeId,
          ack.appliedRevision,
        );
        await advanceMeshSyncCursor(
          first.peerNodeId,
          ack.aggregateType,
          ack.aggregateId,
          ack.originNodeId,
          ack.appliedRevision,
        );
        delivered += 1;
      }
    } catch (error) {
      for (const item of group) {
        await markMeshSyncOutboxRetry(item, String(error));
      }
    }
  }
  return delivered;
}
