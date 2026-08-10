/**
 * Pure transition decisions for mesh membership, pairing, and authority.
 *
 * Persistence adapters may evaluate these decisions inside a transaction, but
 * this module never reads or writes storage and never performs transport work.
 */

import type {
  MeshLinkMemberRecord,
  MeshLinkRecord,
  MeshPairingApprovalRecord,
  MeshPairingRequestRecord,
  MeshTakeoverRecord,
} from "@/shared/mesh";
import { DomainError } from "./domain-error";

type MeshMemberSnapshot = Pick<MeshLinkMemberRecord, "status"> | null;

export interface LocalMeshTakeoverTransitionInput {
  link: MeshLinkRecord | null;
  member: MeshMemberSnapshot;
  nodeId: string;
  expectedGeneration?: number;
}

export interface LocalMeshTakeoverDecision {
  kind: "accepted";
  generation: number;
}

export function decideLocalMeshTakeover(
  input: LocalMeshTakeoverTransitionInput,
): LocalMeshTakeoverDecision {
  if (!input.link) {
    throw new DomainError("mesh_link_not_found", "The mesh link was not found.");
  }
  if (input.link.status === "conflict") {
    throw new DomainError("mesh_takeover_conflict", "The mesh link has an unresolved takeover conflict.");
  }
  if (
    input.expectedGeneration !== undefined
    && input.expectedGeneration !== input.link.takeoverGeneration
  ) {
    throw new DomainError(
      "mesh_takeover_generation_conflict",
      "The mesh link changed before takeover was confirmed.",
      {
        details: {
          expectedGeneration: input.expectedGeneration,
          currentGeneration: input.link.takeoverGeneration,
          activeNodeId: input.link.activeNodeId,
        },
      },
    );
  }
  if (!input.member || input.member.status !== "active") {
    throw new DomainError("mesh_node_not_member", "The local node is not an active member of this mesh link.");
  }
  return {
    kind: "accepted",
    generation: Math.max(1, input.link.takeoverGeneration + 1),
  };
}

export interface RemoteMeshTakeoverTransitionInput {
  link: MeshLinkRecord | null;
  member: MeshMemberSnapshot;
  nodeId: string;
  generation: number;
  claimedAt: string;
  claimOrigin: string;
  signature: string;
}

export type RemoteMeshTakeoverDecision =
  | {
    kind: "accepted";
    claim: MeshTakeoverRecord;
  }
  | {
    kind: "stale";
    claim: MeshTakeoverRecord;
  }
  | {
    kind: "conflict";
    error: DomainError<"mesh_takeover_conflict">;
  };

export function decideRemoteMeshTakeover(
  input: RemoteMeshTakeoverTransitionInput,
): RemoteMeshTakeoverDecision {
  if (!input.link) {
    throw new DomainError("mesh_link_not_found", "The mesh link was not found.");
  }
  if (!input.member || input.member.status !== "active") {
    throw new DomainError("mesh_node_not_member", "The takeover node is not an active member of this mesh link.");
  }
  if (
    input.generation === input.link.takeoverGeneration
    && input.link.activeNodeId
    && input.link.activeNodeId !== input.nodeId
  ) {
    return {
      kind: "conflict",
      error: new DomainError(
        "mesh_takeover_conflict",
        "The mesh link received two takeover claims for the same generation.",
        {
          details: {
            generation: input.generation,
            activeNodeId: input.link.activeNodeId,
            competingNodeId: input.nodeId,
          },
        },
      ),
    };
  }
  if (input.generation < input.link.takeoverGeneration) {
    return {
      kind: "stale",
      claim: {
        linkId: input.link.linkId,
        nodeId: input.link.activeNodeId ?? input.nodeId,
        generation: input.link.takeoverGeneration,
        claimedAt: input.link.activeClaimedAt ?? input.claimedAt,
        claimOrigin: input.link.activeClaimOrigin ?? input.claimOrigin,
        signature: null,
      },
    };
  }
  return {
    kind: "accepted",
    claim: {
      linkId: input.link.linkId,
      nodeId: input.nodeId,
      generation: input.generation,
      claimedAt: input.claimedAt,
      claimOrigin: input.claimOrigin,
      signature: input.signature,
    },
  };
}

export interface ApproveMeshPairingTransitionInput {
  request: MeshPairingRequestRecord | null;
  approvingUserId: string;
  requestedLinkId?: string;
  existingUserLink: MeshLinkRecord | null;
  selectedLink: MeshLinkRecord | null;
  generatedLinkId: string;
  nowMs: number;
}

export type ApproveMeshPairingDecision =
  | {
    kind: "idempotent";
    linkId: string;
  }
  | {
    kind: "apply";
    linkId: string;
    createLink: boolean;
  };

export function decideApproveMeshPairing(
  input: ApproveMeshPairingTransitionInput,
): ApproveMeshPairingDecision {
  const request = requirePairingRequest(input.request);
  if (request.status === "approved" && request.linkId) {
    if (!input.selectedLink || input.selectedLink.localUserId !== input.approvingUserId) {
      throw new DomainError("mesh_pairing_request_not_owned", "The approved mesh request is not owned by this user.");
    }
    return {
      kind: "idempotent",
      linkId: input.selectedLink.linkId,
    };
  }
  if (request.status !== "pending") {
    throw new DomainError("mesh_pairing_request_not_pending", "The mesh pairing request is no longer pending.");
  }
  if (request.direction !== "incoming") {
    throw new DomainError("mesh_pairing_request_not_incoming", "Only incoming mesh pairing requests can be approved here.");
  }
  if (Date.parse(request.expiresAt) <= input.nowMs) {
    throw new DomainError("mesh_pairing_request_expired", "The mesh pairing request has expired.");
  }
  if (request.targetLocalUserId && request.targetLocalUserId !== input.approvingUserId) {
    throw new DomainError("mesh_pairing_request_not_targeted", "The mesh pairing request targets another local user.");
  }

  const linkId = input.requestedLinkId
    ?? request.linkId
    ?? input.existingUserLink?.linkId
    ?? input.generatedLinkId;
  if (input.selectedLink && input.selectedLink.localUserId !== input.approvingUserId) {
    throw new DomainError("mesh_pairing_request_not_owned", "The selected mesh link is not owned by this user.");
  }
  if (input.existingUserLink && input.existingUserLink.linkId !== linkId) {
    throw new DomainError("mesh_pairing_link_conflict", "This user already belongs to another mesh link.");
  }
  return {
    kind: "apply",
    linkId,
    createLink: !input.selectedLink,
  };
}

export interface CompleteOutgoingMeshPairingTransitionInput {
  request: MeshPairingRequestRecord | null;
  localUserId: string;
  localNodeId: string;
  remoteNodeId: string;
  link: MeshLinkRecord | null;
  nowMs: number;
  linkId: string;
}

export type CompleteOutgoingMeshPairingDecision =
  | {
    kind: "idempotent";
    linkId: string;
  }
  | {
    kind: "apply";
    linkId: string;
    createLink: boolean;
  };

export function decideCompleteOutgoingMeshPairing(
  input: CompleteOutgoingMeshPairingTransitionInput,
): CompleteOutgoingMeshPairingDecision {
  const request = requirePairingRequest(input.request);
  if (request.status === "approved" && request.linkId) {
    if (!input.link || input.link.localUserId !== input.localUserId) {
      throw new DomainError("mesh_pairing_request_not_owned", "The approved mesh request is not owned by this user.");
    }
    return {
      kind: "idempotent",
      linkId: input.link.linkId,
    };
  }
  if (request.status !== "pending") {
    throw new DomainError("mesh_pairing_request_not_pending", "The mesh pairing request is no longer pending.");
  }
  if (input.link && input.link.localUserId !== input.localUserId) {
    throw new DomainError("mesh_pairing_request_not_owned", "The selected mesh link is not owned by this user.");
  }
  if (request.direction !== "outgoing") {
    throw new DomainError("mesh_pairing_request_not_outgoing", "Only outgoing mesh pairing requests can be completed here.");
  }
  if (
    request.requestedNodeId !== input.localNodeId
    || request.requestedLocalUserId !== input.localUserId
  ) {
    throw new DomainError("mesh_pairing_request_not_owned", "The mesh pairing request belongs to another local identity.");
  }
  if (Date.parse(request.expiresAt) <= input.nowMs) {
    throw new DomainError("mesh_pairing_request_expired", "The mesh pairing request has expired.");
  }
  if (request.requestedNodeId === input.remoteNodeId) {
    throw new DomainError("mesh_pairing_request_invalid_peer", "The pairing approval identifies the requesting node as the peer.");
  }
  return {
    kind: "apply",
    linkId: input.linkId,
    createLink: !input.link,
  };
}

export interface RejectMeshPairingTransitionInput {
  request: MeshPairingRequestRecord | null;
  rejectingUserId: string;
  ownedLink: MeshLinkRecord | null;
  nowMs: number;
}

export interface RejectMeshPairingDecision {
  kind: "apply";
}

export function decideRejectMeshPairing(
  input: RejectMeshPairingTransitionInput,
): RejectMeshPairingDecision {
  const request = requirePairingRequest(input.request);
  if (request.status !== "pending") {
    throw new DomainError("mesh_pairing_request_not_pending", "The mesh pairing request is no longer pending.");
  }
  if (Date.parse(request.expiresAt) <= input.nowMs) {
    throw new DomainError("mesh_pairing_request_expired", "The mesh pairing request has expired.");
  }
  const ownsIncomingRequest = request.direction === "incoming"
    && (!request.targetLocalUserId || request.targetLocalUserId === input.rejectingUserId)
    && (!request.linkId || input.ownedLink !== null);
  const ownsOutgoingRequest = request.direction === "outgoing"
    && request.requestedLocalUserId === input.rejectingUserId;
  if (!ownsIncomingRequest && !ownsOutgoingRequest) {
    throw new DomainError("mesh_pairing_request_not_owned", "The mesh pairing request is not owned by this user.");
  }
  return { kind: "apply" };
}

export interface ReceiveMeshPairingApprovalTransitionInput {
  request: MeshPairingRequestRecord | null;
  existingApproval: MeshPairingApprovalRecord | null;
  approvedByNodeId: string;
  signature: string;
  nowMs: number;
}

export type ReceiveMeshPairingApprovalDecision =
  | {
    kind: "idempotent";
    approval: MeshPairingApprovalRecord;
  }
  | {
    kind: "apply";
  };

export function decideReceiveMeshPairingApproval(
  input: ReceiveMeshPairingApprovalTransitionInput,
): ReceiveMeshPairingApprovalDecision {
  const request = input.request;
  if (!request || request.direction !== "outgoing") {
    throw new DomainError("mesh_pairing_request_not_found", "The outgoing mesh pairing request was not found.");
  }
  if (request.status === "approved" && input.existingApproval) {
    if (
      input.existingApproval.approvedByNodeId !== input.approvedByNodeId
      || input.existingApproval.signature !== input.signature
    ) {
      throw new DomainError("mesh_pairing_approval_conflict", "The pairing approval does not match the completed request.");
    }
    return {
      kind: "idempotent",
      approval: input.existingApproval,
    };
  }
  if (request.status !== "pending") {
    throw new DomainError("mesh_pairing_request_not_pending", "The outgoing mesh pairing request is no longer pending.");
  }
  if (Date.parse(request.expiresAt) <= input.nowMs) {
    throw new DomainError("mesh_pairing_request_expired", "The outgoing mesh pairing request has expired.");
  }
  if (request.requestedNodeId === input.approvedByNodeId) {
    throw new DomainError("mesh_pairing_request_invalid_peer", "The pairing approval identifies the local node as the peer.");
  }
  return { kind: "apply" };
}

export interface CompleteMeshPairingTransitionInput {
  request: MeshPairingRequestRecord | null;
  approval: MeshPairingApprovalRecord | null;
  localUserId: string;
  confirmedFingerprint: string;
}

export type CompleteMeshPairingDecision =
  | {
    kind: "idempotent";
  }
  | {
    kind: "apply";
    approval: MeshPairingApprovalRecord;
  };

export function decideCompleteMeshPairing(
  input: CompleteMeshPairingTransitionInput,
): CompleteMeshPairingDecision {
  const request = input.request;
  if (
    !request
    || request.direction !== "outgoing"
    || request.requestedLocalUserId !== input.localUserId
  ) {
    throw new DomainError("mesh_pairing_request_not_owned", "The outgoing mesh pairing request is not owned by this user.");
  }
  if (!input.approval) {
    throw new DomainError("mesh_pairing_approval_not_found", "The peer has not approved this pairing request yet.");
  }
  if (input.approval.status === "accepted" && request.status === "approved" && request.linkId) {
    return { kind: "idempotent" };
  }
  if (input.approval.status !== "pending") {
    throw new DomainError("mesh_pairing_approval_not_pending", "The peer pairing approval is no longer pending.");
  }
  if (input.approval.fingerprint !== input.confirmedFingerprint) {
    throw new DomainError("mesh_pairing_fingerprint_mismatch", "The confirmed fingerprint does not match the peer approval.");
  }
  return {
    kind: "apply",
    approval: input.approval,
  };
}

function requirePairingRequest(
  request: MeshPairingRequestRecord | null,
): MeshPairingRequestRecord {
  if (!request) {
    throw new DomainError("mesh_pairing_request_not_found", "Mesh pairing request was not found.");
  }
  return request;
}
