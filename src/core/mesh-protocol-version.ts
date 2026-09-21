import { CLANKY_VERSION } from "../version";
import {
  MESH_PROTOCOL_PREFERRED_VERSION,
  MESH_PROTOCOL_VERSION,
  MESH_SUPPORTED_PROTOCOL_VERSIONS,
  type MeshProtocolMetadata,
} from "@/shared/mesh-protocol";
import type { MeshNodeIdentity } from "@/shared/mesh";

export function getLocalMeshProtocolMetadata(): MeshProtocolMetadata {
  return {
    binaryVersion: CLANKY_VERSION,
    supportedProtocolVersions: [...MESH_SUPPORTED_PROTOCOL_VERSIONS],
    preferredProtocolVersion: MESH_PROTOCOL_PREFERRED_VERSION,
    negotiatedProtocolVersion: MESH_PROTOCOL_VERSION,
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
