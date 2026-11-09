import type { MeshDirectPeerRoute } from "@/shared/mesh";
import { DomainError } from "../domain/domain-error";
import { assertSelfSignedTlsCertificate } from "../lib/tls-certificate";
import { assertMeshEndpointAllowed } from "./mesh-transport-config";

export function meshTargetTlsTrust(target: string, certificate?: string) {
  const endpoint = assertMeshEndpointAllowed(target, "https").origin;
  if (certificate === undefined) {
    return { tlsTrust: "system" as const, tlsCertificate: null, tlsFingerprint: null };
  }
  try {
    const fingerprint = assertSelfSignedTlsCertificate(certificate, new URL(endpoint).hostname);
    return { tlsTrust: "pinned" as const, tlsCertificate: certificate, tlsFingerprint: fingerprint };
  } catch (error) {
    throw new DomainError("mesh_controller_tls_certificate_invalid", "The trusted controller certificate is invalid, expired or does not cover the target.", { cause: error });
  }
}

export function sameMeshTlsTrust(left: MeshDirectPeerRoute, right: MeshDirectPeerRoute): boolean {
  return left.tlsTrust === right.tlsTrust
    && left.tlsCertificate === right.tlsCertificate
    && left.tlsFingerprint === right.tlsFingerprint;
}
