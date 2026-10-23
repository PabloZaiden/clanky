/**
 * Key-bound invitations and one-use request proofs for workspace clients.
 */
import { randomUUID } from "node:crypto";
import {
  WorkspaceClientRequestMetadataSchema,
  WorkspaceInvitationBootstrapSchema,
  type WorkspaceClientRequestMetadata,
  type WorkspaceInvitationBootstrap,
} from "@/contracts/schemas/mesh-client";
import { DomainError } from "../domain/domain-error";
import { getMeshRelayFingerprint, verifyMeshRelaySignature } from "./mesh-relay-identity";
import type { MeshRelayConnectorIdentity } from "./mesh-relay-connector";
import { sanitizeMeshRelayRequestHeaders } from "./mesh-relay-http";

const INVITATION_PREFIX = "clanky_workspace_";
const REQUEST_HEADER = "x-clanky-workspace-request";
const SIGNATURE_HEADER = "x-clanky-workspace-signature";
const MAX_PROOF_BYTES = 16_384;
const REQUEST_LIFETIME_MS = 30_000;
const MAX_PENDING_PROOFS = 4_096;
const CLIENT_REQUEST_HEADERS = new Set([
  "accept", "content-type", "range", "if-match", "if-none-match",
  "if-modified-since", "if-unmodified-since", "content-range",
  "if-range", "x-clanky-file-target", "x-clanky-file-conditions",
]);

function invitationPayload(input: Omit<WorkspaceInvitationBootstrap, "signature">): string {
  return JSON.stringify([
    "clanky-workspace-invitation-v1", input.version, input.token,
    input.expiresAt, input.controller, input.relay, input.relayAdmission,
  ]);
}

export async function encodeWorkspaceInvitation(
  input: Omit<WorkspaceInvitationBootstrap, "signature">,
  sign: (payload: string) => Promise<string>,
): Promise<string> {
  const signature = await sign(invitationPayload(input));
  const value = WorkspaceInvitationBootstrapSchema.parse({ ...input, signature });
  return `${INVITATION_PREFIX}${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

export function decodeWorkspaceInvitation(token: string): WorkspaceInvitationBootstrap {
  if (!token.startsWith(INVITATION_PREFIX) || token.length > 64 * 1_024) {
    throw new DomainError("collaboration_invitation_invalid", "The workspace invitation is invalid.");
  }
  try {
    const value = WorkspaceInvitationBootstrapSchema.parse(JSON.parse(
      Buffer.from(token.slice(INVITATION_PREFIX.length), "base64url").toString("utf8"),
    ));
    if (Date.parse(value.expiresAt) <= Date.now()) {
      throw new DomainError("collaboration_invitation_expired", "The workspace invitation has expired.");
    }
    if (getMeshRelayFingerprint(value.controller.publicKey) !== value.controller.fingerprint
      || !verifyMeshRelaySignature(invitationPayload(value), value.signature, value.controller.publicKey)) {
      throw new DomainError("collaboration_invitation_invalid", "The workspace invitation signature is invalid.");
    }
    return value;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("collaboration_invitation_invalid", "The workspace invitation is invalid.", { cause: error });
  }
}

export async function createWorkspaceClientProof(
  identity: MeshRelayConnectorIdentity,
  input: Omit<WorkspaceClientRequestMetadata, "version" | "nodeId" | "requestId" | "issuedAt" | "headers"> & {
    headers?: HeadersInit;
  },
): Promise<Record<string, string>> {
  const headers = Object.fromEntries(Object.entries(
    sanitizeMeshRelayRequestHeaders(input.headers),
  ).filter(([name]) => CLIENT_REQUEST_HEADERS.has(name)));
  const metadata = WorkspaceClientRequestMetadataSchema.parse({
    ...input,
    version: 1,
    nodeId: identity.nodeId,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    headers,
  });
  const encoded = Buffer.from(JSON.stringify(metadata)).toString("base64url");
  if (Buffer.byteLength(encoded) > MAX_PROOF_BYTES) {
    throw new DomainError("collaboration_request_invalid", "The workspace request metadata is too large.");
  }
  return {
    [REQUEST_HEADER]: encoded,
    [SIGNATURE_HEADER]: await identity.sign(`clanky-workspace-request-v1:${encoded}`),
  };
}

export function readWorkspaceClientProof(headers: Headers): WorkspaceClientRequestMetadata {
  const encoded = headers.get(REQUEST_HEADER);
  if (!encoded || Buffer.byteLength(encoded) > MAX_PROOF_BYTES) {
    throw new DomainError("collaboration_request_invalid", "A signed workspace request is required.");
  }
  try {
    return WorkspaceClientRequestMetadataSchema.parse(JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ));
  } catch (error) {
    throw new DomainError("collaboration_request_invalid", "The workspace request metadata is invalid.", { cause: error });
  }
}

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
