/**
 * Canonical signed payload for Mesh terminal session handshakes.
 */

import type { MeshTerminalSessionRequest } from "@/contracts/schemas/mesh-terminal";

type UnsignedMeshTerminalSessionRequest = Omit<MeshTerminalSessionRequest, "signature">;

export function buildMeshTerminalSessionSigningPayload(
  request: UnsignedMeshTerminalSessionRequest,
): string {
  return JSON.stringify([
    "clanky-mesh-terminal-session-v1",
    request.protocolVersion,
    request.capability,
    request.requestId,
    request.callerNodeId,
    request.callerPublicKey,
    request.callerFingerprint,
    request.callerEncryptionPublicKey,
    request.targetNodeId,
    request.workspaceId,
    request.executionRoot,
    request.directory,
    request.provider,
    request.terminalSessionId,
    request.remoteSessionName,
    request.connectionMode,
    request.useTmux,
    request.allowPersistentSessionCreate,
    request.encryptedEnvironment ?? null,
    request.nonce,
    request.expiresAt,
  ]);
}
