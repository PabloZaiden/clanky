/**
 * Portable invitation verification and signed outbound workspace requests.
 */

import {
  WorkspaceClientRequestMetadataSchema, WorkspaceInvitationBootstrapSchema,
  type WorkspaceClientRequestMetadata, type WorkspaceInvitationBootstrap,
} from "@/contracts/schemas/mesh-client";
import { DomainError } from "../../domain/domain-error";
import { sanitizeMeshRelayRequestHeaders } from "../../core/mesh-relay-http-client";
import {
  decodeUtf8Base64Url, encodeJsonBase64Url, utf8ByteLength,
} from "@/shared/encoding";
import { getClientKeyFingerprint, verifyClientSignature } from "./crypto";
import type { CollaborationSigningIdentity } from "./types";

const INVITATION_PREFIX = "clanky_workspace_";
export const WORKSPACE_REQUEST_HEADER = "x-clanky-workspace-request";
export const WORKSPACE_SIGNATURE_HEADER = "x-clanky-workspace-signature";
export const MAX_WORKSPACE_PROOF_BYTES = 16_384;
export const WORKSPACE_CLIENT_REQUEST_HEADERS = new Set([
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
  return `${INVITATION_PREFIX}${encodeJsonBase64Url(WorkspaceInvitationBootstrapSchema.parse({ ...input, signature }))}`;
}

export async function decodeWorkspaceInvitation(token: string): Promise<WorkspaceInvitationBootstrap> {
  if (!token.startsWith(INVITATION_PREFIX) || token.length > 64 * 1_024) {
    throw new DomainError("collaboration_invitation_invalid", "The workspace invitation is invalid.");
  }
  try {
    const value = WorkspaceInvitationBootstrapSchema.parse(JSON.parse(decodeUtf8Base64Url(token.slice(INVITATION_PREFIX.length))));
    if (Date.parse(value.expiresAt) <= Date.now()) {
      throw new DomainError("collaboration_invitation_expired", "The workspace invitation has expired.");
    }
    if (await getClientKeyFingerprint(value.controller.publicKey) !== value.controller.fingerprint
      || !await verifyClientSignature(invitationPayload(value), value.signature, value.controller.publicKey)) {
      throw new DomainError("collaboration_invitation_invalid", "The workspace invitation signature is invalid.");
    }
    return value;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("collaboration_invitation_invalid", "The workspace invitation is invalid.", { cause: error });
  }
}

export async function createWorkspaceClientProof(
  identity: CollaborationSigningIdentity,
  input: Omit<WorkspaceClientRequestMetadata, "version" | "nodeId" | "requestId" | "issuedAt" | "headers"> & {
    headers?: HeadersInit;
  },
): Promise<Record<string, string>> {
  const headers = Object.fromEntries(Object.entries(sanitizeMeshRelayRequestHeaders(input.headers))
    .filter(([name]) => WORKSPACE_CLIENT_REQUEST_HEADERS.has(name)));
  const metadata = WorkspaceClientRequestMetadataSchema.parse({
    ...input, version: 1, nodeId: identity.nodeId,
    requestId: crypto.randomUUID(), issuedAt: Date.now(), headers,
  });
  const encoded = encodeJsonBase64Url(metadata);
  if (utf8ByteLength(encoded) > MAX_WORKSPACE_PROOF_BYTES) {
    throw new DomainError("collaboration_request_invalid", "The workspace request metadata is too large.");
  }
  return {
    [WORKSPACE_REQUEST_HEADER]: encoded,
    [WORKSPACE_SIGNATURE_HEADER]: await identity.sign(`clanky-workspace-request-v1:${encoded}`),
  };
}

export function readWorkspaceClientProof(headers: Headers): WorkspaceClientRequestMetadata {
  const encoded = headers.get(WORKSPACE_REQUEST_HEADER);
  if (!encoded || utf8ByteLength(encoded) > MAX_WORKSPACE_PROOF_BYTES) {
    throw new DomainError("collaboration_request_invalid", "A signed workspace request is required.");
  }
  try {
    return WorkspaceClientRequestMetadataSchema.parse(JSON.parse(decodeUtf8Base64Url(encoded)));
  } catch (error) {
    throw new DomainError("collaboration_request_invalid", "The workspace request metadata is invalid.", { cause: error });
  }
}
