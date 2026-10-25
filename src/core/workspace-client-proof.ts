/**
 * Key-bound invitations and one-use request proofs for workspace clients.
 */
import type { WorkspaceClientRequestMetadata } from "@/contracts/schemas/mesh-client";
import { DomainError } from "../domain/domain-error";
import { verifyMeshRelaySignature } from "./mesh-relay-identity";
import {
  WORKSPACE_REQUEST_HEADER as REQUEST_HEADER,
  WORKSPACE_SIGNATURE_HEADER as SIGNATURE_HEADER,
  MAX_WORKSPACE_PROOF_BYTES as MAX_PROOF_BYTES,
  WORKSPACE_CLIENT_REQUEST_HEADERS as CLIENT_REQUEST_HEADERS,
  readWorkspaceClientProof,
} from "../client-sdk/collaboration/proof";
export {
  createWorkspaceClientProof, decodeWorkspaceInvitation, encodeWorkspaceInvitation,
  readWorkspaceClientProof,
} from "../client-sdk/collaboration/proof";

const REQUEST_LIFETIME_MS = 30_000;
const MAX_PENDING_PROOFS = 4_096;

export class WorkspaceClientProofVerifier {
  private readonly seen = new Map<string, number>();

  verify(input: {
    headers: Headers;
    publicKey: string;
    controllerNodeId: string;
    initiatorNodeId: string;
  }): WorkspaceClientRequestMetadata {
    const metadata = readWorkspaceClientProof(input.headers);
    const encoded = input.headers.get(REQUEST_HEADER)!;
    const signature = input.headers.get(SIGNATURE_HEADER);
    const now = Date.now();
    if (!signature || signature.length > MAX_PROOF_BYTES
      || metadata.nodeId !== input.initiatorNodeId
      || metadata.controllerNodeId !== input.controllerNodeId
      || metadata.issuedAt > now + 5_000
      || now - metadata.issuedAt >= REQUEST_LIFETIME_MS
      || !verifyMeshRelaySignature(`clanky-workspace-request-v1:${encoded}`, signature, input.publicKey)) {
      throw new DomainError("collaboration_request_invalid", "The workspace request proof is invalid or expired.");
    }
    if (Object.keys(metadata.headers).some((name) => !CLIENT_REQUEST_HEADERS.has(name))) {
      throw new DomainError("collaboration_request_invalid", "The workspace request includes an unsupported header.");
    }
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(key);
    }
    const key = JSON.stringify([metadata.nodeId, metadata.requestId]);
    if (this.seen.has(key)) {
      throw new DomainError("collaboration_request_replayed", "The workspace request has already been admitted.");
    }
    if (this.seen.size >= MAX_PENDING_PROOFS) {
      throw new DomainError("collaboration_request_capacity", "Workspace request admission capacity is exhausted.");
    }
    this.seen.set(key, metadata.issuedAt + REQUEST_LIFETIME_MS);
    return metadata;
  }

  clear(): void {
    this.seen.clear();
  }
}
