import type {
  MeshLinkMemberRecord,
  MeshLinkRecord,
  MeshNodeRecord,
} from "@/shared/mesh";
import {
  getMeshLinkById,
  getMeshNode,
  listMeshLinkMembers,
} from "../persistence/mesh";
import { getMeshNodeFingerprint } from "../persistence/mesh-node-identity";
import { DomainError } from "./domain-error";

export interface TrustedMeshPeer {
  node: MeshNodeRecord;
  link: MeshLinkRecord;
  member: MeshLinkMemberRecord;
}

export interface TrustedMeshPeerOptions {
  linkId: string;
  nodeId: string;
  publicKey: string;
  fingerprint: string;
  encryptionPublicKey?: string;
  requireEncryptionKey?: boolean;
  requireActiveNode?: boolean;
  requireActiveMember?: boolean;
  context?: string;
}

export function assertMeshPeerIdentity(
  publicKey: string,
  fingerprint: string,
  context = "mesh peer",
): void {
  let derivedFingerprint: string;
  try {
    derivedFingerprint = getMeshNodeFingerprint(publicKey);
  } catch (error) {
    throw new DomainError("mesh_peer_identity_invalid", `The ${context} public key is invalid.`, {
      cause: error,
    });
  }
  if (derivedFingerprint !== fingerprint) {
    throw new DomainError(
      "mesh_peer_identity_mismatch",
      `The ${context} fingerprint does not match its public key.`,
    );
  }
}

export async function requireTrustedMeshNode(
  nodeId: string,
  publicKey: string,
  fingerprint: string,
  options: {
    requireActive?: boolean;
    context?: string;
  } = {},
): Promise<MeshNodeRecord> {
  const context = options.context ?? "mesh peer";
  assertMeshPeerIdentity(publicKey, fingerprint, context);
  const node = await getMeshNode(nodeId);
  if (!node || node.status === "revoked" || (options.requireActive && node.status !== "active")) {
    throw new DomainError("mesh_peer_not_trusted", `The ${context} is not a trusted mesh node.`);
  }
  if (node.fingerprint !== fingerprint || node.publicKey !== publicKey) {
    throw new DomainError("mesh_peer_not_trusted", `The ${context} identity does not match the trusted mesh node.`);
  }
  return node;
}

export async function requireTrustedMeshPeer(
  options: TrustedMeshPeerOptions,
): Promise<TrustedMeshPeer> {
  const context = options.context ?? "mesh peer";
  const node = await requireTrustedMeshNode(
    options.nodeId,
    options.publicKey,
    options.fingerprint,
    {
      requireActive: options.requireActiveNode,
      context,
    },
  );
  if (
    node.encryptionPublicKey
    && (
      options.requireEncryptionKey !== false
        ? !options.encryptionPublicKey || node.encryptionPublicKey !== options.encryptionPublicKey
        : options.encryptionPublicKey !== undefined && node.encryptionPublicKey !== options.encryptionPublicKey
    )
  ) {
    throw new DomainError("mesh_peer_not_trusted", `The ${context} encryption identity does not match the trusted mesh node.`);
  }

  const link = await getMeshLinkById(options.linkId);
  if (!link) {
    throw new DomainError("mesh_link_not_found", "The mesh link was not found.");
  }
  const member = (await listMeshLinkMembers(options.linkId))
    .find((candidate) => candidate.nodeId === options.nodeId);
  if (!member || member.status === "revoked" || (options.requireActiveMember && member.status !== "active")) {
    throw new DomainError("mesh_peer_not_trusted", `The ${context} is not an active member of this mesh link.`);
  }
  return { node, link, member };
}
