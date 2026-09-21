import { CLANKY_VERSION } from "../version";
import {
  MESH_PROTOCOL_PREFERRED_VERSION,
  MESH_PROTOCOL_VERSION,
  MESH_SUPPORTED_PROTOCOL_VERSIONS,
  type MeshProtocolMetadata,
} from "@/shared/mesh-protocol";
import type { MeshNodeIdentity } from "@/shared/mesh";
import { DomainError } from "../domain/domain-error";

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

export function isMeshProtocolCompatibilityError(error: unknown): boolean {
  if (!(error instanceof DomainError)) {
    return false;
  }
  const status = error.details["status"];
  const peerErrorCode = error.details["peerErrorCode"];
  const errorCode = typeof peerErrorCode === "string"
    ? peerErrorCode
    : error.code;
  return (
    (errorCode === "validation_error"
      || errorCode === "mesh_execution_protocol_mismatch"
      || errorCode === "mesh_terminal_protocol_mismatch"
      || errorCode === "mesh_tunnel_protocol_mismatch")
    && (status === 400 || status === 422)
  );
}
