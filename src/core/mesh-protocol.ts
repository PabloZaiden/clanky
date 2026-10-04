/**
 * Canonical payloads for signed mesh control messages.
 *
 * No membership update or configuration update payloads - the controller-worker
 * model does not have gossip.
 */

import type {
  MeshEnrollmentRequest,
  MeshEnrollmentResponse,
  MeshHealthCheck,
  MeshHealthCheckResponse,
  MeshRevocationNotice,
  MeshWorkerKillRequest,
} from "@/contracts/schemas/mesh";
import type { MeshExecutionSessionRequest } from "@/contracts/schemas/mesh-execution";

type UnsignedEnrollmentRequest = Omit<MeshEnrollmentRequest, "signature">;
type UnsignedEnrollmentResponse = Omit<MeshEnrollmentResponse, "signature">;
type UnsignedHealthCheck = Omit<MeshHealthCheck, "signature">;
type UnsignedHealthCheckResponse = Omit<MeshHealthCheckResponse, "signature">;
type UnsignedRevocationNotice = Omit<MeshRevocationNotice, "signature">;
type UnsignedWorkerKillRequest = Omit<MeshWorkerKillRequest, "signature">;
type UnsignedExecutionSession = Omit<MeshExecutionSessionRequest, "signature">;

export function buildMeshEnrollmentRequestSigningPayload(
  envelope: UnsignedEnrollmentRequest,
): string {
  return JSON.stringify([
    `clanky-mesh-enrollment-request-v${envelope.protocolVersion}`,
    envelope.protocolVersion,
    envelope.workerNodeId,
    envelope.workerInstanceName ?? null,
    envelope.workerPublicKey,
    envelope.workerFingerprint,
    envelope.workerEncryptionPublicKey,
    envelope.workerDirectory,
    envelope.workerPlatform,
    envelope.workerCapabilities,
    envelope.workerAcceptRemoteExecution,
    envelope.workerConfigRevision,
    envelope.binaryVersion,
    envelope.supportedProtocolVersions,
    envelope.preferredProtocolVersion,
    envelope.enrollmentToken,
    envelope.expectedControllerFingerprint,
    envelope.route,
    envelope.nonce,
    envelope.expiresAt,
  ]);
}

export function buildMeshEnrollmentResponseSigningPayload(
  envelope: UnsignedEnrollmentResponse,
): string {
  return JSON.stringify([
    `clanky-mesh-enrollment-response-v${envelope.protocolVersion}`,
    envelope.protocolVersion,
    envelope.workerNodeId,
    envelope.controllerNodeId,
    envelope.controllerInstanceName,
    envelope.controllerPublicKey,
    envelope.controllerFingerprint,
    envelope.controllerEncryptionPublicKey,
    envelope.binaryVersion,
    envelope.supportedProtocolVersions,
    envelope.preferredProtocolVersion,
  ]);
}

export function buildMeshHealthCheckSigningPayload(
  envelope: UnsignedHealthCheck,
): string {
  return JSON.stringify([
    `clanky-mesh-health-check-v${envelope.protocolVersion}`,
    envelope.protocolVersion,
    envelope.senderNodeId,
    envelope.senderPublicKey,
    envelope.senderFingerprint,
    envelope.binaryVersion,
    envelope.supportedProtocolVersions,
    envelope.preferredProtocolVersion,
    envelope.nonce,
    envelope.sentAt,
  ]);
}

export function buildMeshHealthCheckResponseSigningPayload(
  envelope: UnsignedHealthCheckResponse,
): string {
  const payload: unknown[] = [
    `clanky-mesh-health-check-response-v${envelope.protocolVersion}`,
    envelope.protocolVersion,
    envelope.workerNodeId,
    envelope.controllerNodeId,
    envelope.requestNonce,
    envelope.workerDirectory,
    envelope.workerCapabilities,
    envelope.workerAcceptRemoteExecution,
    envelope.workerConfigRevision,
  ];
  if (envelope.workerPlatform !== undefined) {
    payload.push(envelope.workerPlatform);
  }
  payload.push(
    envelope.binaryVersion,
    envelope.supportedProtocolVersions,
    envelope.preferredProtocolVersion,
  );
  return JSON.stringify(payload);
}

export function buildMeshRevocationNoticeSigningPayload(
  envelope: UnsignedRevocationNotice,
): string {
  return JSON.stringify([
    `clanky-mesh-revocation-notice-v${envelope.protocolVersion}`,
    envelope.protocolVersion,
    envelope.controllerNodeId,
    envelope.workerNodeId,
    envelope.controllerPublicKey,
    envelope.controllerFingerprint,
    envelope.nonce,
    envelope.expiresAt,
  ]);
}

export function buildMeshWorkerKillRequestSigningPayload(
  envelope: UnsignedWorkerKillRequest,
): string {
  return JSON.stringify([
    `clanky-mesh-worker-kill-request-v${envelope.protocolVersion}`,
    envelope.protocolVersion,
    envelope.controllerNodeId,
    envelope.workerNodeId,
    envelope.controllerPublicKey,
    envelope.controllerFingerprint,
    envelope.nonce,
    envelope.expiresAt,
  ]);
}

export function buildMeshExecutionSessionSigningPayload(
  envelope: UnsignedExecutionSession,
): string {
  const payload: unknown[] = [
    `clanky-mesh-execution-session-v${envelope.protocolVersion}`,
    envelope.protocolVersion,
    envelope.requestId,
    envelope.callerNodeId,
    envelope.callerPublicKey,
    envelope.callerFingerprint,
    envelope.callerEncryptionPublicKey,
    envelope.targetNodeId,
    envelope.workspaceId,
    envelope.directory,
    envelope.provider,
    envelope.channel,
  ];
  // Keep the no-environment shape compatible with workers that predate the
  // managed runtime environment field.
  if (envelope.encryptedEnvironment !== undefined) {
    payload.push(envelope.encryptedEnvironment);
  }
  if (envelope.protocolVersion === 6) {
    payload.push(envelope.adapter ?? null, envelope.ownerId ?? null);
  }
  payload.push(envelope.nonce, envelope.expiresAt);
  return JSON.stringify(payload);
}
