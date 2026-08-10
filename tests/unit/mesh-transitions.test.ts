import { describe, expect, test } from "bun:test";
import type {
  MeshLinkRecord,
  MeshPairingApprovalRecord,
  MeshPairingRequestRecord,
} from "../../src/shared/mesh";
import {
  decideApproveMeshPairing,
  decideCompleteMeshPairing,
  decideCompleteOutgoingMeshPairing,
  decideLocalMeshTakeover,
  decideReceiveMeshPairingApproval,
  decideRejectMeshPairing,
  decideRemoteMeshTakeover,
} from "../../src/domain/mesh-transitions";
import { DomainError } from "../../src/domain/domain-error";

const now = Date.parse("2026-08-07T00:00:00.000Z");

function link(overrides: Partial<MeshLinkRecord> = {}): MeshLinkRecord {
  return {
    linkId: "link-1",
    localUserId: "user-1",
    activeNodeId: "node-1",
    takeoverGeneration: 3,
    activeClaimedAt: "2026-08-06T00:00:00.000Z",
    activeClaimOrigin: "test",
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function request(overrides: Partial<MeshPairingRequestRecord> = {}): MeshPairingRequestRecord {
  return {
    id: "request-1",
    direction: "incoming",
    linkId: null,
    targetLocalUserId: "user-1",
    requestedNodeId: "node-2",
    requestedInstanceName: "Remote",
    requestedLocalUserId: "user-2",
    requestedUsername: "remote",
    endpoint: "https://remote.example.test",
    transport: "https",
    publicKey: "remote-key",
    fingerprint: "remote-fingerprint",
    encryptionPublicKey: "remote-encryption-key",
    nonce: "nonce",
    signature: "signature",
    status: "pending",
    expiresAt: "2026-08-07T00:01:00.000Z",
    approvedAt: null,
    approvedByUserId: null,
    rejectionReason: null,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

function approval(overrides: Partial<MeshPairingApprovalRecord> = {}): MeshPairingApprovalRecord {
  return {
    requestId: "request-1",
    linkId: "link-1",
    approvedByNodeId: "node-2",
    approvedByInstanceName: "Remote",
    approvedByLocalUserId: "user-2",
    activeNodeId: "node-2",
    takeoverGeneration: 3,
    endpoint: "https://remote.example.test",
    transport: "https",
    publicKey: "remote-key",
    fingerprint: "remote-fingerprint",
    encryptionPublicKey: "remote-encryption-key",
    signature: "approval-signature",
    status: "pending",
    members: [],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

function expectDomainError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code} to be thrown.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe("mesh transition decisions", () => {
  test("accepts a local takeover and derives the next generation", () => {
    expect(decideLocalMeshTakeover({
      link: link(),
      member: { status: "active" },
      nodeId: "node-2",
    })).toEqual({
      kind: "accepted",
      generation: 4,
    });
  });

  test("rejects a local takeover when the observed generation changed", () => {
    expectDomainError(() => decideLocalMeshTakeover({
      link: link(),
      member: { status: "active" },
      nodeId: "node-2",
      expectedGeneration: 2,
    }), "mesh_takeover_generation_conflict");
  });

  test("returns stale remote authority without overwriting newer state", () => {
    expect(decideRemoteMeshTakeover({
      link: link(),
      member: { status: "active" },
      nodeId: "node-2",
      generation: 2,
      claimedAt: "2026-08-07T00:00:00.000Z",
      claimOrigin: "remote",
      signature: "signature",
    })).toEqual({
      kind: "stale",
      claim: {
        linkId: "link-1",
        nodeId: "node-1",
        generation: 3,
        claimedAt: "2026-08-06T00:00:00.000Z",
        claimOrigin: "test",
        signature: null,
      },
    });
  });

  test("materializes a same-generation competing takeover as a conflict decision", () => {
    const decision = decideRemoteMeshTakeover({
      link: link(),
      member: { status: "active" },
      nodeId: "node-2",
      generation: 3,
      claimedAt: "2026-08-07T00:00:00.000Z",
      claimOrigin: "remote",
      signature: "signature",
    });
    expect(decision.kind).toBe("conflict");
    if (decision.kind === "conflict") {
      expect(decision.error.code).toBe("mesh_takeover_conflict");
      expect(decision.error.details).toMatchObject({
        generation: 3,
        activeNodeId: "node-1",
        competingNodeId: "node-2",
      });
    }
  });

  test("selects an existing user link for incoming pairing approval", () => {
    expect(decideApproveMeshPairing({
      request: request(),
      approvingUserId: "user-1",
      existingUserLink: link(),
      selectedLink: link(),
      generatedLinkId: "generated-link",
      nowMs: now,
    })).toEqual({
      kind: "apply",
      linkId: "link-1",
      createLink: false,
    });
  });

  test("rejects expired or conflicting pairing approval requests", () => {
    expectDomainError(() => decideApproveMeshPairing({
      request: request({ expiresAt: "2026-08-06T23:59:59.000Z" }),
      approvingUserId: "user-1",
      existingUserLink: null,
      selectedLink: null,
      generatedLinkId: "generated-link",
      nowMs: now,
    }), "mesh_pairing_request_expired");
    expectDomainError(() => decideApproveMeshPairing({
      request: request(),
      approvingUserId: "user-1",
      requestedLinkId: "requested-link",
      existingUserLink: link({ linkId: "other-link" }),
      selectedLink: null,
      generatedLinkId: "generated-link",
      nowMs: now,
    }), "mesh_pairing_link_conflict");
  });

  test("accepts outgoing completion only for the requesting identity and a different peer", () => {
    expect(decideCompleteOutgoingMeshPairing({
      request: request({
        direction: "outgoing",
        targetLocalUserId: null,
        requestedNodeId: "node-1",
        requestedLocalUserId: "user-1",
      }),
      localUserId: "user-1",
      localNodeId: "node-1",
      remoteNodeId: "node-2",
      link: null,
      nowMs: now,
      linkId: "link-1",
    })).toEqual({
      kind: "apply",
      linkId: "link-1",
      createLink: true,
    });
    expectDomainError(() => decideCompleteOutgoingMeshPairing({
      request: request({
        direction: "outgoing",
        requestedNodeId: "node-1",
        requestedLocalUserId: "user-1",
      }),
      localUserId: "user-1",
      localNodeId: "node-1",
      remoteNodeId: "node-1",
      link: null,
      nowMs: now,
      linkId: "link-1",
    }), "mesh_pairing_request_invalid_peer");
  });

  test("preserves pairing approval idempotency and rejection ownership rules", () => {
    const existingApproval = approval();
    expect(decideReceiveMeshPairingApproval({
      request: request({
        direction: "outgoing",
        requestedNodeId: "node-1",
        requestedLocalUserId: "user-1",
        linkId: "link-1",
        status: "approved",
      }),
      existingApproval,
      approvedByNodeId: "node-2",
      signature: "approval-signature",
      nowMs: now,
    })).toEqual({
      kind: "idempotent",
      approval: existingApproval,
    });
    expectDomainError(() => decideRejectMeshPairing({
      request: request({ targetLocalUserId: "another-user" }),
      rejectingUserId: "user-1",
      ownedLink: null,
      nowMs: now,
    }), "mesh_pairing_request_not_owned");
  });

  test("requires the approved fingerprint and recognizes completed pairing", () => {
    expectDomainError(() => decideCompleteMeshPairing({
      request: request({
        direction: "outgoing",
        requestedLocalUserId: "user-1",
      }),
      approval: approval(),
      localUserId: "user-1",
      confirmedFingerprint: "wrong",
    }), "mesh_pairing_fingerprint_mismatch");
    expect(decideCompleteMeshPairing({
      request: request({
        direction: "outgoing",
        requestedLocalUserId: "user-1",
        linkId: "link-1",
        status: "approved",
      }),
      approval: approval({ status: "accepted" }),
      localUserId: "user-1",
      confirmedFingerprint: "remote-fingerprint",
    })).toEqual({ kind: "idempotent" });
  });
});
