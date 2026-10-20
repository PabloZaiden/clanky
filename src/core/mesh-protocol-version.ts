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
export function negotiateMeshDescriptorGeneration(
  value: unknown,
  localVersions: readonly MeshProtocolVersion[] = MESH_SUPPORTED_PROTOCOL_VERSIONS,
): MeshProtocolVersion | null {
  if (typeof value !== "object" || value === null) return null;
  const envelope = value as Record<string, unknown>;
  const versions = envelope["supportedProtocolVersions"];
  if (!Array.isArray(versions) || !versions.every(isMeshProtocolGeneration)) return null;
  const selected = negotiateMeshProtocolVersion(localVersions, versions);
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

export function countMeshProtocolSessions<T>(
  sessions: Iterable<T>,
  describe: (session: T) => { protocolVersion: MeshProtocolVersion; expiresAt: number },
): Record<MeshProtocolVersion, number> {
  const counts: Record<MeshProtocolVersion, number> = { 6: 0, 7: 0 };
  const now = Date.now();
  for (const session of sessions) {
    const descriptor = describe(session);
    if (descriptor.expiresAt > now) counts[descriptor.protocolVersion]++;
  }
  return counts;
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
