import { CLANKY_VERSION } from "../version";
import {
  MESH_PROTOCOL_PREFERRED_VERSION,
  MESH_PROTOCOL_VERSION,
  MESH_SUPPORTED_PROTOCOL_VERSIONS,
  type MeshProtocolMetadata,
  type MeshProtocolVersion,
} from "@/shared/mesh-protocol";
import type { MeshNodeIdentity } from "@/shared/mesh";

export { negotiateMeshDescriptorGeneration } from "@/shared/mesh-protocol";

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
  const counts: Record<MeshProtocolVersion, number> = { [MESH_PROTOCOL_VERSION]: 0 };
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
