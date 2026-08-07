/**
 * Core orchestration for linked-instance mesh membership.
 *
 * Transport workers will call the persistence functions directly through this
 * boundary as they are added. User-facing routes use this manager so local
 * authentication remains separate from mesh membership.
 */

import type {
  ApproveMeshPairingRequest,
  CompleteMeshPairingRequest,
  MeshPeerPairingRequest,
  MeshPeerPairingApproval,
  RejectMeshPairingRequest,
  StartMeshPairingRequest,
  MeshTakeoverEnvelope,
} from "@/contracts/schemas/mesh";
import type {
  MeshLinkStatusRecord,
  MeshPairingMemberRecord,
  MeshSyncConflictRecord,
  MeshStatusRecord,
} from "@/shared/mesh";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  applyMeshLinkTakeover,
  approveMeshPairingRequest,
  claimMeshLinkForLocalUser,
  completeOutgoingMeshPairingRequest,
  createMeshPairingRequest,
  getMeshPairingApproval,
  getMeshPairingRequest,
  getMeshLinkForLocalUser,
  getMeshNode,
  listMeshLinkMembers,
  listMeshLinksForLocalUser,
  listPendingMeshPairingRequests,
  rejectMeshPairingRequest,
  saveMeshNode,
  saveMeshPairingApproval,
  mergeMeshLinkMember,
  setMeshPairingApprovalStatus,
  revokeMeshLinkMember,
  setMeshLinkTakeoverSignature,
} from "../persistence/mesh";
import {
  listOpenMeshSyncConflicts,
  recordMeshMembershipCheckpoint,
} from "../persistence/mesh-sync";
import {
  ensureLocalMeshNodeIdentity,
  requireMeshInstanceName,
  rotateLocalMeshNodeIdentity,
  setLocalMeshInstanceName,
  signMeshPayload,
  verifyMeshPayloadSignature,
} from "../persistence/mesh-node-identity";
import {
  buildMeshPairingApprovalSigningPayload,
  buildMeshPairingRequestSigningPayload,
  buildMeshTakeoverSigningPayload,
} from "./mesh-protocol";
import {
  assertMeshEndpointAllowed,
  getMeshTransport,
  resolveAdvertisedMeshEndpoint,
  resolveMeshRoute,
} from "./mesh-transport-config";
import { DomainError } from "./domain-error";
import { postMeshControlMessage } from "./mesh-control-client";
import { bootstrapMeshPeerForUser } from "./mesh-sync-bootstrap";
import { listTasksForUser } from "../persistence/tasks";
import { backendManager } from "./backend/backend-manager";
import { assertMeshPeerIdentity } from "./mesh-peer-auth";
import {
  decideCompleteMeshPairing,
  decideReceiveMeshPairingApproval,
} from "../domain/mesh-transitions";

const PAIRING_REQUEST_TTL_MS = 15 * 60 * 1000;
const log = createLogger("core:mesh-manager");

export class MeshManager {
  async listOpenConflicts(localUserId: string): Promise<MeshSyncConflictRecord[]> {
    const links = await listMeshLinksForLocalUser(localUserId);
    const conflictsByLink = await Promise.all(
      links.map((link) => listOpenMeshSyncConflicts(link.linkId)),
    );
    return conflictsByLink.flat();
  }

  async getStatus(localUserId: string): Promise<MeshStatusRecord> {
    const node = await ensureLocalMeshNodeIdentity();
    const links = await listMeshLinksForLocalUser(localUserId);
    const pendingRequests = await listPendingMeshPairingRequests(localUserId);
    const requestsWithApprovals = await Promise.all(pendingRequests.map(async (request) => {
      if (request.direction !== "outgoing") {
        return request;
      }

      const approval = await getMeshPairingApproval(request.id);
      return approval ? { ...request, remoteApproval: approval } : request;
    }));
    const statusLinks: MeshLinkStatusRecord[] = [];

    for (const link of links) {
      statusLinks.push({
        ...link,
        members: await listMeshLinkMembers(link.linkId),
        pendingPairingRequests: requestsWithApprovals.filter((request) => request.linkId === link.linkId),
      });
    }

    return {
      node,
      links: statusLinks,
      pendingPairingRequests: requestsWithApprovals,
    };
  }

  async setInstanceName(localUserId: string, value: string): Promise<MeshStatusRecord> {
    await setLocalMeshInstanceName(value);
    if (await getMeshLinkForLocalUser(localUserId)) {
      await recordMeshMembershipCheckpoint(localUserId);
    }
    return await this.getStatus(localUserId);
  }

  async getTakeoverPreflight(localUserId: string): Promise<{
    linkId: string | null;
    activeNodeId: string | null;
    takeoverGeneration: number | null;
    linkStatus: string | null;
    activeTasks: Array<{ id: string; name: string; status: string }>;
  }> {
    const status = await this.getStatus(localUserId);
    const link = status.links[0];
    const activeTasks = (await listTasksForUser(localUserId))
      .filter((task) => ["idle", "planning", "starting", "running", "waiting"].includes(task.state.status))
      .map((task) => ({
        id: task.config.id,
        name: task.config.name,
        status: task.state.status,
      }));
    return {
      linkId: link?.linkId ?? null,
      activeNodeId: link?.activeNodeId ?? null,
      takeoverGeneration: link?.takeoverGeneration ?? null,
      linkStatus: link?.status ?? null,
      activeTasks,
    };
  }

  async receivePairingRequest(
    envelope: MeshPeerPairingRequest,
  ): Promise<{ requestId: string; status: string; fingerprint: string }> {
    assertMeshEndpointAllowed(envelope.endpoint, envelope.transport);
    if (new Date(envelope.expiresAt).getTime() <= Date.now()) {
      throw new DomainError("mesh_pairing_request_expired", "The mesh pairing request has expired.");
    }

    assertMeshPeerIdentity(envelope.publicKey, envelope.fingerprint, "pairing request");
    if (!envelope.requestedInstanceName) {
      throw new DomainError(
        "mesh_instance_name_required",
        "The requesting instance must have a name before joining this mesh.",
      );
    }
    const knownNode = await getMeshNode(envelope.requestedNodeId);
    if (knownNode?.status === "revoked") {
      throw new DomainError("mesh_peer_revoked", "The pairing request uses a revoked mesh node identity.");
    }
    const { signature, ...unsigned } = envelope;
    const payload = buildMeshPairingRequestSigningPayload(unsigned);
    if (!verifyMeshPayloadSignature(payload, signature, envelope.publicKey)) {
      throw new DomainError("mesh_peer_signature_invalid", "The pairing request signature is invalid.");
    }

    const existing = await getMeshPairingRequest(envelope.requestId);
    if (existing) {
      if (
        existing.direction !== "incoming"
        || existing.linkId !== (envelope.linkId ?? null)
        || existing.requestedNodeId !== envelope.requestedNodeId
        || existing.nonce !== envelope.nonce
        || existing.signature !== envelope.signature
      ) {
        throw new DomainError("mesh_pairing_request_conflict", "The pairing request ID is already used by another request.");
      }
      return {
        requestId: existing.id,
        status: existing.status,
        fingerprint: existing.fingerprint,
      };
    }

    await saveMeshNode({
      nodeId: envelope.requestedNodeId,
      instanceName: envelope.requestedInstanceName,
      publicKey: envelope.publicKey,
      fingerprint: envelope.fingerprint,
      encryptionPublicKey: envelope.encryptionPublicKey,
      endpoint: envelope.endpoint,
      transport: envelope.transport,
      status: "pending",
    });
    const request = await createMeshPairingRequest({
      id: envelope.requestId,
      direction: "incoming",
      linkId: envelope.linkId ?? null,
      targetLocalUserId: envelope.targetLocalUserId ?? null,
      requestedNodeId: envelope.requestedNodeId,
      requestedInstanceName: envelope.requestedInstanceName,
      requestedLocalUserId: envelope.requestedLocalUserId,
      requestedUsername: envelope.requestedUsername ?? null,
      endpoint: envelope.endpoint,
      transport: envelope.transport,
      publicKey: envelope.publicKey,
      fingerprint: envelope.fingerprint,
      encryptionPublicKey: envelope.encryptionPublicKey,
      nonce: envelope.nonce,
      signature: envelope.signature,
      expiresAt: envelope.expiresAt,
    });
    return {
      requestId: request.id,
      status: request.status,
      fingerprint: request.fingerprint,
    };
  }

  async startPairing(
    localUserId: string,
    localUsername: string,
    input: StartMeshPairingRequest,
  ): Promise<MeshStatusRecord> {
    const identity = await ensureLocalMeshNodeIdentity();
    const instanceName = requireMeshInstanceName(identity);
    const localLink = await getMeshLinkForLocalUser(localUserId);
    const localEndpoint = resolveAdvertisedMeshEndpoint();
    const localTransport = getMeshTransport(localEndpoint);
    assertMeshEndpointAllowed(input.targetEndpoint);
    const requestId = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + PAIRING_REQUEST_TTL_MS).toISOString();
    const unsigned = {
      protocolVersion: 1 as const,
      requestId,
      linkId: localLink?.linkId ?? null,
      targetLocalUserId: input.targetLocalUserId ?? null,
      requestedNodeId: identity.nodeId,
      requestedInstanceName: instanceName,
      requestedLocalUserId: localUserId,
      requestedUsername: localUsername,
      endpoint: localEndpoint,
      transport: localTransport,
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      encryptionPublicKey: identity.encryptionPublicKey,
      nonce,
      expiresAt,
    };
    const signature = await signMeshPayload(buildMeshPairingRequestSigningPayload(unsigned));
    await createMeshPairingRequest({
      id: requestId,
      direction: "outgoing",
      nodeStatus: "active",
      linkId: localLink?.linkId ?? null,
      targetLocalUserId: input.targetLocalUserId ?? null,
      requestedNodeId: identity.nodeId,
      requestedInstanceName: instanceName,
      requestedLocalUserId: localUserId,
      requestedUsername: localUsername,
      endpoint: localEndpoint,
      transport: localTransport,
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      encryptionPublicKey: identity.encryptionPublicKey,
      nonce,
      signature,
      expiresAt,
    });

    await postMeshControlMessage(
      resolveMeshRoute(input.targetEndpoint, "api/mesh/internal/pairing-requests"),
      { ...unsigned, signature },
      requestId,
    );
    return await this.getStatus(localUserId);
  }

  async rejoin(
    localUserId: string,
    localUsername: string,
    input: StartMeshPairingRequest,
  ): Promise<MeshStatusRecord> {
    const identity = await ensureLocalMeshNodeIdentity();
    requireMeshInstanceName(identity);
    const links = await listMeshLinksForLocalUser(localUserId);
    const link = links[0];
    if (!link) {
      throw new DomainError("mesh_link_not_found", "The local user is not linked to a mesh.");
    }
    const member = (await listMeshLinkMembers(link.linkId))
      .find((candidate) => candidate.nodeId === identity.nodeId);
    if (!member || member.status !== "revoked") {
      throw new DomainError(
        "mesh_rejoin_requires_revoked",
        "Only a revoked mesh node can rejoin an existing mesh.",
      );
    }
    await rotateLocalMeshNodeIdentity();
    return await this.startPairing(localUserId, localUsername, input);
  }

  async revokeMember(
    localUserId: string,
    nodeId: string,
  ): Promise<MeshStatusRecord> {
    const link = await listMeshLinksForLocalUser(localUserId).then((links) => links[0] ?? null);
    if (!link) {
      throw new DomainError("mesh_link_not_found", "The local user is not linked to a mesh.");
    }
    await revokeMeshLinkMember({
      linkId: link.linkId,
      localUserId,
      nodeId,
    });
    await backendManager.invalidateMeshExecutionConnections();
    await recordMeshMembershipCheckpoint(localUserId, { includeRevokedPeers: true });
    return await this.getStatus(localUserId);
  }

  async receivePairingApproval(
    envelope: MeshPeerPairingApproval,
  ): Promise<{ requestId: string; status: string; fingerprint: string }> {
    assertMeshEndpointAllowed(envelope.endpoint, envelope.transport);
    assertMeshPeerIdentity(envelope.publicKey, envelope.fingerprint, "pairing approval");
    if (!envelope.approvedByInstanceName) {
      throw new DomainError(
        "mesh_instance_name_required",
        "The approving instance must have a name before completing the mesh join.",
      );
    }
    const members = envelope.members ?? [];
    for (const member of members) {
      assertMeshPeerIdentity(member.publicKey, member.fingerprint, "pairing approval member");
      if (member.endpoint) {
        assertMeshEndpointAllowed(member.endpoint, member.transport);
      }
    }
    const { signature, ...unsigned } = envelope;
    if (!verifyMeshPayloadSignature(
      buildMeshPairingApprovalSigningPayload(unsigned),
      signature,
      envelope.publicKey,
    )) {
      throw new DomainError("mesh_peer_signature_invalid", "The pairing approval signature is invalid.");
    }

    const request = await getMeshPairingRequest(envelope.requestId);
    const existingApproval = await getMeshPairingApproval(envelope.requestId);
    const approvalDecision = decideReceiveMeshPairingApproval({
      request,
      existingApproval,
      approvedByNodeId: envelope.approvedByNodeId,
      signature: envelope.signature,
      nowMs: Date.now(),
    });
    if (approvalDecision.kind === "idempotent") {
      return {
        requestId: approvalDecision.approval.requestId,
        status: approvalDecision.approval.status,
        fingerprint: approvalDecision.approval.fingerprint,
      };
    }
    const approvedNode = await getMeshNode(envelope.approvedByNodeId);
    if (approvedNode?.status === "revoked") {
      throw new DomainError("mesh_peer_revoked", "The pairing approval uses a revoked mesh node identity.");
    }
    await saveMeshNode({
      nodeId: envelope.approvedByNodeId,
      instanceName: envelope.approvedByInstanceName,
      publicKey: envelope.publicKey,
      fingerprint: envelope.fingerprint,
      encryptionPublicKey: envelope.encryptionPublicKey,
      endpoint: envelope.endpoint,
      transport: envelope.transport,
      status: "pending",
    });
    const approval = await saveMeshPairingApproval({
      requestId: envelope.requestId,
      linkId: envelope.linkId,
      approvedByNodeId: envelope.approvedByNodeId,
      approvedByInstanceName: envelope.approvedByInstanceName,
      approvedByLocalUserId: envelope.approvedByLocalUserId,
      activeNodeId: envelope.activeNodeId,
      takeoverGeneration: envelope.takeoverGeneration,
      endpoint: envelope.endpoint,
      transport: envelope.transport,
      publicKey: envelope.publicKey,
      fingerprint: envelope.fingerprint,
      encryptionPublicKey: envelope.encryptionPublicKey,
      signature: envelope.signature,
      members,
    });
    return {
      requestId: approval.requestId,
      status: approval.status,
      fingerprint: approval.fingerprint,
    };
  }

  async completePairing(
    localUserId: string,
    requestId: string,
    input: CompleteMeshPairingRequest,
  ): Promise<MeshStatusRecord> {
    const request = await getMeshPairingRequest(requestId);
    const storedApproval = await getMeshPairingApproval(requestId);
    const pairingDecision = decideCompleteMeshPairing({
      request,
      approval: storedApproval,
      localUserId,
      confirmedFingerprint: input.fingerprint,
    });
    if (pairingDecision.kind === "idempotent") {
      return await this.getStatus(localUserId);
    }
    const approval = pairingDecision.approval;
    const identity = await ensureLocalMeshNodeIdentity();
    requireMeshInstanceName(identity);
    const localEndpoint = resolveAdvertisedMeshEndpoint();
    const localTransport = getMeshTransport(localEndpoint);
    await saveMeshNode({
      nodeId: identity.nodeId,
      instanceName: identity.instanceName,
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      endpoint: localEndpoint,
      transport: localTransport,
      status: "active",
    });
    await completeOutgoingMeshPairingRequest({
      requestId,
      localUserId,
      localNodeId: identity.nodeId,
      localNodeEndpoint: localEndpoint,
      localNodeTransport: localTransport,
      remoteNodeId: approval.approvedByNodeId,
      remoteInstanceName: approval.approvedByInstanceName,
      remoteLocalUserId: approval.approvedByLocalUserId,
      remoteEndpoint: approval.endpoint,
      remoteTransport: approval.transport,
      remotePublicKey: approval.publicKey,
      remoteFingerprint: approval.fingerprint,
      remoteEncryptionPublicKey: approval.encryptionPublicKey,
      activeNodeId: approval.activeNodeId,
      takeoverGeneration: approval.takeoverGeneration,
      linkId: approval.linkId,
    });
    for (const member of approval.members) {
      await mergeMeshLinkMember({
        linkId: approval.linkId,
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
    await setMeshPairingApprovalStatus(requestId, "accepted");
    await backendManager.invalidateMeshExecutionConnections();
    await recordMeshMembershipCheckpoint(localUserId);
    queueMicrotask(() => {
      void bootstrapMeshPeerForUser(localUserId).catch((error) => {
        log.error("Mesh local bootstrap after pairing completion failed", {
          linkId: approval.linkId,
          peerNodeId: approval.approvedByNodeId,
          error: String(error),
        });
      });
    });
    return await this.getStatus(localUserId);
  }

  async approvePairingRequest(
    localUserId: string,
    requestId: string,
    input: ApproveMeshPairingRequest,
  ): Promise<MeshStatusRecord> {
    const identity = await ensureLocalMeshNodeIdentity();
    const instanceName = requireMeshInstanceName(identity);
    const request = await getMeshPairingRequest(requestId);
    if (!request) {
      throw new DomainError("mesh_pairing_request_not_found", "Mesh pairing request was not found.");
    }
    if (!request.requestedInstanceName) {
      throw new DomainError(
        "mesh_instance_name_required",
        "The requesting instance must have a name before it can join this mesh.",
      );
    }
    const localEndpoint = resolveAdvertisedMeshEndpoint();
    const localTransport = getMeshTransport(localEndpoint);
    await saveMeshNode({
      nodeId: identity.nodeId,
      instanceName,
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      endpoint: localEndpoint,
      transport: localTransport,
      status: "active",
    });
    const link = await approveMeshPairingRequest({
      requestId,
      approvingUserId: localUserId,
      localNodeId: identity.nodeId,
      localNodeEndpoint: localEndpoint,
      localNodeTransport: localTransport,
      linkId: input.linkId,
    });
    await recordMeshMembershipCheckpoint(localUserId);
    const members: MeshPairingMemberRecord[] = [];
    for (const member of await listMeshLinkMembers(link.linkId)) {
      const node = await getMeshNode(member.nodeId);
      if (!node) {
        throw new DomainError("mesh_peer_not_found", "A mesh link member has no node identity.");
      }
      members.push({
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
    const unsigned = {
      protocolVersion: 1 as const,
      requestId,
      linkId: link.linkId,
      approvedByNodeId: identity.nodeId,
      approvedByInstanceName: instanceName,
      approvedByLocalUserId: localUserId,
      activeNodeId: link.activeNodeId,
      takeoverGeneration: link.takeoverGeneration,
      endpoint: localEndpoint,
      transport: localTransport,
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      encryptionPublicKey: identity.encryptionPublicKey,
      members,
    };
    const signature = await signMeshPayload(buildMeshPairingApprovalSigningPayload(unsigned));
    await postMeshControlMessage(
      resolveMeshRoute(request.endpoint, "api/mesh/internal/pairing-approvals"),
      { ...unsigned, signature },
      requestId,
    );
    queueMicrotask(() => {
      void bootstrapMeshPeerForUser(localUserId).catch((error) => {
        log.error("Mesh peer bootstrap failed", {
          linkId: link.linkId,
          peerNodeId: request.requestedNodeId,
          error: String(error),
        });
      });
    });
    return await this.getStatus(localUserId);
  }

  async rejectPairingRequest(
    localUserId: string,
    requestId: string,
    input: RejectMeshPairingRequest,
  ): Promise<MeshStatusRecord> {
    const request = await getMeshPairingRequest(requestId);
    await rejectMeshPairingRequest(requestId, localUserId, input.reason ?? null);
    if (request?.direction === "outgoing") {
      const approval = await getMeshPairingApproval(requestId);
      if (approval?.status === "pending") {
        await setMeshPairingApprovalStatus(requestId, "rejected");
      }
    }
    return await this.getStatus(localUserId);
  }

  async takeover(
    localUserId: string,
    expectedGeneration?: number,
  ): Promise<{
    status: MeshStatusRecord;
    generation: number;
    warnings: string[];
  }> {
    const identity = await ensureLocalMeshNodeIdentity();
    const link = await listMeshLinksForLocalUser(localUserId).then((links) => links[0] ?? null);
    if (!link) {
      throw new DomainError("mesh_link_not_found", "The local user is not linked to a mesh.");
    }
    const claim = await claimMeshLinkForLocalUser({
      linkId: link.linkId,
      localUserId,
      nodeId: identity.nodeId,
      claimOrigin: "api",
      expectedGeneration,
    });
    const unsigned = {
      protocolVersion: 1 as const,
      linkId: claim.linkId,
      senderNodeId: identity.nodeId,
      senderPublicKey: identity.publicKey,
      senderFingerprint: identity.fingerprint,
      generation: claim.generation,
      claimedAt: claim.claimedAt,
      claimOrigin: claim.claimOrigin,
    };
    const signature = await signMeshPayload(buildMeshTakeoverSigningPayload(unsigned));
    await setMeshLinkTakeoverSignature({
      linkId: claim.linkId,
      nodeId: claim.nodeId,
      generation: claim.generation,
      signature,
    });
    await backendManager.invalidateMeshExecutionConnections();
    const activeTasks = (await listTasksForUser(localUserId))
      .filter((task) => ["idle", "planning", "starting", "running", "waiting"].includes(task.state.status));
    const warnings: string[] = activeTasks.length > 0
      ? [`${String(activeTasks.length)} task(s) remain active on their original node.`]
      : [];
    const members = await listMeshLinkMembers(claim.linkId);
    await Promise.all(members
      .filter((member) => member.nodeId !== identity.nodeId && member.status === "active")
      .map(async (member) => {
        if (!member.endpoint) {
          warnings.push(`Peer ${member.nodeId} has no advertised endpoint.`);
          return;
        }
        try {
          await postMeshControlMessage(
            resolveMeshRoute(member.endpoint, "api/mesh/internal/takeover"),
            { ...unsigned, signature },
            `${claim.linkId}:${claim.generation}:${identity.nodeId}`,
          );
        } catch (error) {
          warnings.push(`Peer ${member.nodeId} did not receive the takeover claim: ${String(error)}`);
          log.warn("Mesh takeover propagation failed", {
            linkId: claim.linkId,
            peerNodeId: member.nodeId,
            generation: claim.generation,
            error: String(error),
          });
        }
      }));
    return {
      status: await this.getStatus(localUserId),
      generation: claim.generation,
      warnings,
    };
  }

  async receiveTakeover(envelope: MeshTakeoverEnvelope): Promise<{ generation: number; status: string }> {
    const node = await getMeshNode(envelope.senderNodeId);
    if (!node || node.status === "revoked") {
      throw new DomainError("mesh_peer_not_member", "The takeover sender is not a trusted mesh member.");
    }
    assertMeshPeerIdentity(envelope.senderPublicKey, envelope.senderFingerprint, "takeover sender");
    if (envelope.senderFingerprint !== node.fingerprint) {
      throw new DomainError("mesh_peer_identity_mismatch", "The takeover sender fingerprint does not match the trusted node.");
    }
    const { signature, ...unsigned } = envelope;
    if (!verifyMeshPayloadSignature(
      buildMeshTakeoverSigningPayload(unsigned),
      signature,
      envelope.senderPublicKey,
    )) {
      throw new DomainError("mesh_peer_signature_invalid", "The takeover signature is invalid.");
    }
    const claim = await applyMeshLinkTakeover({
      linkId: envelope.linkId,
      nodeId: envelope.senderNodeId,
      generation: envelope.generation,
      claimedAt: envelope.claimedAt,
      claimOrigin: envelope.claimOrigin,
      signature: envelope.signature,
    });
    await backendManager.invalidateMeshExecutionConnections();
    return { generation: claim.generation, status: "accepted" };
  }
}

export const meshManager = new MeshManager();
