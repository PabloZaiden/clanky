import { CLANKY_VERSION } from "../version";
import {
  MESH_PROTOCOL_PREFERRED_VERSION,
  MESH_PROTOCOL_VERSION,
  MESH_SUPPORTED_PROTOCOL_VERSIONS,
  isMeshProtocolGeneration,
  negotiateMeshProtocolVersion,
  type MeshProtocolMetadata,
  type MeshProtocolVersion,
} from "@/shared/mesh-protocol";
import type { MeshNodeIdentity } from "@/shared/mesh";

/** Read only the negotiation envelope before choosing a versioned contract. */
export function negotiateMeshDescriptorGeneration(value: unknown): MeshProtocolVersion | null {
  if (typeof value !== "object" || value === null) return null;
  const envelope = value as Record<string, unknown>;
  const versions = envelope["supportedProtocolVersions"];
  if (!Array.isArray(versions) || !versions.every(isMeshProtocolGeneration)) return null;
  const selected = negotiateMeshProtocolVersion(MESH_SUPPORTED_PROTOCOL_VERSIONS, versions);
  return selected && envelope["protocolVersion"] === selected && envelope["negotiatedProtocolVersion"] === selected ? selected : null;
}

export function getLocalMeshProtocolMetadata(): MeshProtocolMetadata {
  return {
    binaryVersion: CLANKY_VERSION,
    supportedProtocolVersions: [...MESH_SUPPORTED_PROTOCOL_VERSIONS],
    preferredProtocolVersion: MESH_PROTOCOL_PREFERRED_VERSION,
    negotiatedProtocolVersion: MESH_PROTOCOL_VERSION,
    harnessAdapters: ["acp", "copilot", "codex", "opencode2"],
  };
}

export function addLocalMeshProtocolMetadata(
  identity: MeshNodeIdentity,
): MeshNodeIdentity {
  const protocol = getLocalMeshProtocolMetadata();
  return {
    ...identity,
    binaryVersion: protocol.binaryVersion ?? undefined,
    supportedProtocolVersions: protocol.supportedProtocolVersions,
    preferredProtocolVersion: protocol.preferredProtocolVersion,
    negotiatedProtocolVersion: protocol.negotiatedProtocolVersion,
  };
}
