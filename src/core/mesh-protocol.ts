/**
 * Canonical payloads for signed mesh control messages.
 *
 * No membership update or configuration update payloads - the controller-worker
 * model does not have gossip.
 */

import type {
  MeshEnrollmentRequestV1,
  MeshEnrollmentRequestV2,
  MeshEnrollmentResponseV1,
  MeshEnrollmentResponseV2,
  MeshHealthCheck,
  MeshHealthCheckResponse,
  MeshRevocationNotice,
  MeshWorkerKillRequest,
} from "@/contracts/schemas/mesh";
import type { MeshExecutionSessionRequest } from "@/contracts/schemas/mesh-execution";

type UnsignedEnrollmentRequestV1 = Omit<MeshEnrollmentRequestV1, "signature">;
type UnsignedEnrollmentRequestV2 = Omit<MeshEnrollmentRequestV2, "signature">;
type UnsignedEnrollmentResponseV1 = Omit<MeshEnrollmentResponseV1, "signature">;
type UnsignedEnrollmentResponseV2 = Omit<MeshEnrollmentResponseV2, "signature">;
type UnsignedEnrollmentRequest =
  | UnsignedEnrollmentRequestV1
  | UnsignedEnrollmentRequestV2;
type UnsignedEnrollmentResponse =
  | UnsignedEnrollmentResponseV1
  | UnsignedEnrollmentResponseV2;
type UnsignedHealthCheck = Omit<MeshHealthCheck, "signature">;
type UnsignedHealthCheckResponse = Omit<MeshHealthCheckResponse, "signature">;
type UnsignedRevocationNotice = Omit<MeshRevocationNotice, "signature">;
type UnsignedWorkerKillRequest = Omit<MeshWorkerKillRequest, "signature">;
type UnsignedExecutionSession = Omit<MeshExecutionSessionRequest, "signature">;

export function buildMeshEnrollmentRequestSigningPayload(
  envelope: UnsignedEnrollmentRequest,
): string {
  if (envelope.protocolVersion === 2) {
    const relayEnvelope = envelope as UnsignedEnrollmentRequestV2;
    const payload: unknown[] = [
      "clanky-mesh-enrollment-request-v2",
      relayEnvelope.protocolVersion,
      relayEnvelope.workerNodeId,
      relayEnvelope.workerInstanceName ?? null,
      relayEnvelope.workerPublicKey,
      relayEnvelope.workerFingerprint,
      relayEnvelope.workerEncryptionPublicKey ?? null,
      relayEnvelope.workerDirectory,
      relayEnvelope.workerCapabilities,
      relayEnvelope.workerAcceptRemoteExecution,
      relayEnvelope.workerConfigRevision,
      relayEnvelope.enrollmentToken,
      relayEnvelope.expectedControllerFingerprint,
      relayEnvelope.route.kind,
      relayEnvelope.route.relayUrl,
      relayEnvelope.route.relayFingerprint,
      relayEnvelope.nonce,
      relayEnvelope.expiresAt,
    ];
    if (relayEnvelope.workerPlatform !== undefined) {
      payload.push(relayEnvelope.workerPlatform);
    }
    return JSON.stringify(payload);
  }
  const directEnvelope = envelope as UnsignedEnrollmentRequestV1;
  const payload: unknown[] = [
    "clanky-mesh-enrollment-request-v1",
    directEnvelope.protocolVersion,
    directEnvelope.workerNodeId,
    directEnvelope.workerInstanceName ?? null,
    directEnvelope.workerEndpoint,
    directEnvelope.workerTransport,
    directEnvelope.workerPublicKey,
    directEnvelope.workerFingerprint,
    directEnvelope.workerEncryptionPublicKey ?? null,
    directEnvelope.workerTlsCertificate,
    directEnvelope.workerTlsFingerprint,
    directEnvelope.workerDirectory,
    directEnvelope.workerCapabilities,
    directEnvelope.workerAcceptRemoteExecution,
    directEnvelope.workerConfigRevision,
    directEnvelope.enrollmentToken,
    directEnvelope.expectedControllerFingerprint,
    directEnvelope.nonce,
    directEnvelope.expiresAt,
  ];
  if (directEnvelope.workerPlatform !== undefined) {
    payload.push(directEnvelope.workerPlatform);
  }
  return JSON.stringify(payload);
}

export function buildMeshEnrollmentResponseSigningPayload(
  envelope: UnsignedEnrollmentResponse,
): string {
  const domain = envelope.protocolVersion === 2
    ? "clanky-mesh-enrollment-response-v2"
    : "clanky-mesh-enrollment-response-v1";
  const response = envelope.protocolVersion === 2
    ? envelope as UnsignedEnrollmentResponseV2
    : envelope as UnsignedEnrollmentResponseV1;
  return JSON.stringify([
    domain,
    response.protocolVersion,
    response.workerNodeId,
    response.controllerNodeId,
    response.controllerInstanceName,
    response.controllerPublicKey,
    response.controllerFingerprint,
    response.controllerEncryptionPublicKey ?? null,
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
  const payload: unknown[] = [
    "clanky-mesh-health-check-response-v1",
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
  return JSON.stringify(payload);
}

export function buildMeshRevocationNoticeSigningPayload(
  envelope: UnsignedRevocationNotice,
): string {
  return JSON.stringify([
    "clanky-mesh-revocation-notice-v1",
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
    "clanky-mesh-worker-kill-request-v1",
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
  ];
  // Keep the no-environment shape compatible with workers that predate the
  // managed runtime environment field.
  if (envelope.encryptedEnvironment !== undefined) {
    payload.push(envelope.encryptedEnvironment);
  }
  payload.push(envelope.nonce, envelope.expiresAt);
  return JSON.stringify(payload);
}
