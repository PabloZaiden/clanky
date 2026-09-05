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
  MeshWorkerUpdateRequest,
} from "@/contracts/schemas/mesh";
import type { MeshExecutionSessionRequest } from "@/contracts/schemas/mesh-execution";

type UnsignedEnrollmentRequest = Omit<MeshEnrollmentRequest, "signature">;
type UnsignedEnrollmentResponse = Omit<MeshEnrollmentResponse, "signature">;
type UnsignedHealthCheck = Omit<MeshHealthCheck, "signature">;
type UnsignedHealthCheckResponse = Omit<MeshHealthCheckResponse, "signature">;
type UnsignedRevocationNotice = Omit<MeshRevocationNotice, "signature">;
type UnsignedExecutionSession = Omit<MeshExecutionSessionRequest, "signature">;
type UnsignedWorkerUpdateRequest = Omit<MeshWorkerUpdateRequest, "signature">;

export function buildMeshEnrollmentRequestSigningPayload(
  envelope: UnsignedEnrollmentRequest,
): string {
  return JSON.stringify([
    "clanky-mesh-enrollment-request-v1",
    envelope.protocolVersion,
    envelope.workerNodeId,
    envelope.workerInstanceName ?? null,
    envelope.workerEndpoint,
    envelope.workerTransport,
    envelope.workerPublicKey,
    envelope.workerFingerprint,
    envelope.workerEncryptionPublicKey ?? null,
    envelope.workerDirectory,
    envelope.workerCapabilities,
    envelope.workerAcceptRemoteExecution,
    envelope.workerConfigRevision,
    envelope.enrollmentToken,
    envelope.expectedControllerFingerprint,
    envelope.nonce,
    envelope.expiresAt,
  ]);
}

export function buildMeshEnrollmentResponseSigningPayload(
  envelope: UnsignedEnrollmentResponse,
): string {
  return JSON.stringify([
    "clanky-mesh-enrollment-response-v1",
    envelope.protocolVersion,
    envelope.workerNodeId,
    envelope.controllerNodeId,
    envelope.controllerInstanceName,
    envelope.controllerPublicKey,
    envelope.controllerFingerprint,
    envelope.controllerEncryptionPublicKey ?? null,
  ]);
}

export function buildMeshHealthCheckSigningPayload(
  envelope: UnsignedHealthCheck,
): string {
  return JSON.stringify([
    "clanky-mesh-health-check-v1",
    envelope.protocolVersion,
    envelope.senderNodeId,
    envelope.senderPublicKey,
    envelope.senderFingerprint,
    envelope.nonce,
    envelope.sentAt,
  ]);
}

export function buildMeshHealthCheckResponseSigningPayload(
  envelope: UnsignedHealthCheckResponse,
): string {
  return JSON.stringify([
    "clanky-mesh-health-check-response-v1",
    envelope.protocolVersion,
    envelope.workerNodeId,
    envelope.controllerNodeId,
    envelope.requestNonce,
    envelope.workerDirectory,
    envelope.workerCapabilities,
    envelope.workerAcceptRemoteExecution,
    envelope.workerConfigRevision,
  ]);
}

export function buildMeshRevocationNoticeSigningPayload(
  envelope: UnsignedRevocationNotice,
): string {
  return JSON.stringify([
    "clanky-mesh-revocation-notice-v1",
    envelope.protocolVersion,
    envelope.controllerNodeId,
    envelope.controllerPublicKey,
    envelope.controllerFingerprint,
    envelope.nonce,
    envelope.expiresAt,
  ]);
}

export function buildMeshExecutionSessionSigningPayload(
  envelope: UnsignedExecutionSession,
): string {
  return JSON.stringify([
    "clanky-mesh-execution-session-v1",
    envelope.protocolVersion,
    envelope.requestId,
    envelope.callerNodeId,
    envelope.callerPublicKey,
    envelope.callerFingerprint,
    envelope.callerEncryptionPublicKey ?? null,
    envelope.targetNodeId,
    envelope.workspaceId,
    envelope.directory,
    envelope.provider,
    envelope.channel,
    envelope.nonce,
    envelope.expiresAt,
  ]);
}

export function buildMeshWorkerUpdateSigningPayload(
  envelope: UnsignedWorkerUpdateRequest,
): string {
  return JSON.stringify([
    "clanky-mesh-worker-update-v1",
    envelope.protocolVersion,
    envelope.action,
    envelope.operationId,
    envelope.controllerNodeId,
    envelope.controllerPublicKey,
    envelope.controllerFingerprint,
    envelope.nonce,
    envelope.expiresAt,
  ]);
}
