import type { MeshTcpTunnelSessionRequest } from "@/contracts/schemas/mesh-tcp-tunnel";

export function buildMeshTcpTunnelSigningPayload(
  request: Omit<MeshTcpTunnelSessionRequest, "signature">,
): string {
  return JSON.stringify([
    "clanky-mesh-tcp-tunnel-v1",
    request.protocolVersion,
    request.capability,
    request.requestId,
    request.callerNodeId,
    request.callerPublicKey,
    request.callerFingerprint,
    request.callerEncryptionPublicKey,
    request.targetNodeId,
    request.remoteHost,
    request.remotePort,
    request.nonce,
    request.expiresAt,
  ]);
}
