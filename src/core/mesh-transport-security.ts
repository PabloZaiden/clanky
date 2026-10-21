/**
 * Actual transport security, including authenticated in-process relay streams.
 */
import { getRequestOriginInfo, readRuntimeConfig, type RuntimeConfig } from "@pablozaiden/webapp/server";
import { isSupportedMeshProtocolVersion, MESH_SUPPORTED_PROTOCOL_VERSIONS, type MeshProtocolVersion } from "@/shared/mesh-protocol";
import { DomainError } from "../domain/domain-error";

const relayRequestSecurity = new WeakMap<Request, { secure: boolean; protocolVersion: MeshProtocolVersion }>();

export function markMeshRelayRequestTransport(
  request: Request,
  transport: { secure: boolean; protocolVersion: MeshProtocolVersion },
): void {
  relayRequestSecurity.set(request, transport);
}

export function isSecureMeshRequest(request: Request, config?: RuntimeConfig): boolean {
  const relaySecurity = relayRequestSecurity.get(request);
  if (relaySecurity !== undefined) return relaySecurity.secure;
  const runtime = config ?? readRuntimeConfig({ appName: "Clanky", envPrefix: "CLANKY", appDirectoryName: ".clanky" });
  // A configured public URL is not evidence that this particular hop used TLS.
  return getRequestOriginInfo(request, { trustProxy: runtime.trustProxy }).secure;
}

export function meshRequestProtocolVersions(request: Request): readonly MeshProtocolVersion[] {
  const relay = relayRequestSecurity.get(request);
  return isSecureMeshRequest(request)
    ? MESH_SUPPORTED_PROTOCOL_VERSIONS.filter((version) => relay === undefined || version === relay.protocolVersion)
    : [];
}

export function assertMeshTransportSecurity(version: MeshProtocolVersion, secure: boolean): void {
  if (!isSupportedMeshProtocolVersion(version)) {
    throw new DomainError("mesh_execution_protocol_mismatch", "The Mesh protocol version is unsupported.");
  }
  if (!secure) {
    throw new DomainError("mesh_tls_required", "TLS-only Mesh sessions require HTTPS/WSS on every hop.");
  }
}

export function assertMeshRequestTransport(request: Request, version: MeshProtocolVersion): void {
  assertMeshTransportSecurity(version, isSecureMeshRequest(request));
}
