/**
 * One route generation, constrained by every participating hop.
 */
import type { MeshWorkerRegistration } from "@/shared/mesh";
import { MESH_SUPPORTED_PROTOCOL_VERSIONS, negotiateMeshProtocolVersion, type MeshProtocolVersion } from "@/shared/mesh-protocol";
import { listControllerRelayPairings } from "../persistence/controller-relay-pairing";
import { DomainError } from "../domain/domain-error";

export function meshWorkerRouteVersion(worker: MeshWorkerRegistration): MeshProtocolVersion {
  let supported: readonly MeshProtocolVersion[] = worker.workerSupportedProtocolVersions ?? [5];
  if (worker.route.kind === "relay") {
    const route = worker.route;
    const relay = listControllerRelayPairings().find((pairing) => pairing.relayUrl === route.relayUrl && pairing.relayFingerprint === route.relayFingerprint);
    supported = supported.filter((version) => relay?.relaySupportedProtocolVersions.includes(version));
  }
  const version = negotiateMeshProtocolVersion(MESH_SUPPORTED_PROTOCOL_VERSIONS, supported);
  if (!version) throw new DomainError("mesh_execution_protocol_mismatch", "The Mesh route has no mutually supported generation.");
  return version;
}
