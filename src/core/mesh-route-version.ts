/**
 * One route generation, constrained by every participating hop.
 */
import type { MeshPeerRoute, MeshRouteSecurity, MeshWorkerRegistration } from "@/shared/mesh";
import {
  meshTransportProtocolVersions,
  isSupportedMeshProtocolVersion,
  negotiateMeshProtocolVersion,
  type MeshProtocolVersion,
} from "@/shared/mesh-protocol";
import { listControllerRelayPairings } from "../persistence/controller-relay-pairing";
import { DomainError } from "../domain/domain-error";

export function meshRouteSupportedProtocolVersions(route: MeshPeerRoute): readonly MeshProtocolVersion[] {
  if (route.kind === "direct") return meshTransportProtocolVersions(route.endpoint);
  const relay = listControllerRelayPairings().find((pairing) => pairing.relayUrl === route.relayUrl && pairing.relayFingerprint === route.relayFingerprint);
  const relayVersion = relay?.relayNegotiatedProtocolVersion;
  if (
    !isSupportedMeshProtocolVersion(relayVersion)
    || !relay?.relaySupportedProtocolVersions.includes(relayVersion)
  ) {
    throw new DomainError("mesh_execution_protocol_mismatch", "The Mesh relay hop has no negotiated generation.");
  }
  return meshTransportProtocolVersions(route.relayUrl).filter((version) =>
    relay.relaySupportedProtocolVersions.includes(version) && version === relayVersion);
}

export function meshWorkerRouteVersion(worker: MeshWorkerRegistration): MeshProtocolVersion {
  const version = negotiateMeshProtocolVersion(
    meshRouteSupportedProtocolVersions(worker.route),
    worker.workerSupportedProtocolVersions ?? [],
  );
  if (!version) throw new DomainError("mesh_execution_protocol_mismatch", "The Mesh route has no mutually supported generation.");
  return version;
}

export function meshWorkerRouteSecurity(worker: MeshWorkerRegistration): MeshRouteSecurity {
  const unavailable = (fallbackReason: MeshRouteSecurity["fallbackReason"]): MeshRouteSecurity => ({
    protocolVersion: null, payloadProtection: "unavailable", fallbackReason,
  });
  if (worker.grantStatus !== "active") return unavailable("revoked");
  const endpoint = worker.route.kind === "direct" ? worker.route.endpoint : worker.route.relayUrl;
  if (meshTransportProtocolVersions(endpoint).length === 0) return unavailable("tls-unavailable");
  let versions: readonly MeshProtocolVersion[];
  try {
    versions = meshRouteSupportedProtocolVersions(worker.route);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "mesh_execution_protocol_mismatch") throw error;
    return unavailable("protocol-unavailable");
  }
  const protocolVersion = negotiateMeshProtocolVersion(versions, worker.workerSupportedProtocolVersions ?? []);
  if (!protocolVersion) return unavailable("protocol-unavailable");
  return { protocolVersion, payloadProtection: "trusted-tls", fallbackReason: null };
}
