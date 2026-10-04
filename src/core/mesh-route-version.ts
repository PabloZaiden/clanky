/**
 * One route generation, constrained by every participating hop.
 */
import type { MeshPeerRoute, MeshWorkerRegistration } from "@/shared/mesh";
import { MESH_SUPPORTED_PROTOCOL_VERSIONS, negotiateMeshProtocolVersion, type MeshProtocolVersion } from "@/shared/mesh-protocol";
import { listControllerRelayPairings } from "../persistence/controller-relay-pairing";
import { DomainError } from "../domain/domain-error";

export function meshRouteSupportedProtocolVersions(route: MeshPeerRoute): readonly MeshProtocolVersion[] {
  if (route.kind === "direct") return MESH_SUPPORTED_PROTOCOL_VERSIONS;
  const relay = listControllerRelayPairings().find((pairing) => pairing.relayUrl === route.relayUrl && pairing.relayFingerprint === route.relayFingerprint);
  const negotiated = relay?.relayNegotiatedProtocolVersion;
  if (!negotiated) {
    throw new DomainError("mesh_execution_protocol_mismatch", "The Mesh relay hop has no negotiated generation.");
  }
  return MESH_SUPPORTED_PROTOCOL_VERSIONS.filter((version) =>
    version <= negotiated && relay.relaySupportedProtocolVersions.includes(version),
  );
}

export function meshWorkerRouteVersion(worker: MeshWorkerRegistration): MeshProtocolVersion {
  const version = negotiateMeshProtocolVersion(meshRouteSupportedProtocolVersions(worker.route), worker.workerSupportedProtocolVersions ?? [5]);
  if (!version) throw new DomainError("mesh_execution_protocol_mismatch", "The Mesh route has no mutually supported generation.");
  return version;
}
