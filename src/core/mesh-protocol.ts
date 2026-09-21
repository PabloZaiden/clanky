/**
 * Canonical payloads for signed mesh control messages.
 *
 * No membership update or configuration update payloads - the controller-worker
 * model does not have gossip.
 */

import type {
  MeshEnrollmentRequestV1,
  MeshEnrollmentRequestV2,
  MeshEnrollmentRequestV5,
  MeshEnrollmentResponseV1,
  MeshEnrollmentResponseV2,
  MeshEnrollmentResponseV5,
  MeshHealthCheckV1,
  MeshHealthCheckV5,
  MeshHealthCheckResponseV1,
  MeshHealthCheckResponseV5,
  MeshRevocationNotice,
  MeshWorkerKillRequest,
} from "@/contracts/schemas/mesh";
import type { MeshExecutionSessionRequest } from "@/contracts/schemas/mesh-execution";

type UnsignedEnrollmentRequestV1 = Omit<MeshEnrollmentRequestV1, "signature">;
type UnsignedEnrollmentRequestV2 = Omit<MeshEnrollmentRequestV2, "signature">;
type UnsignedEnrollmentRequestV5 = Omit<MeshEnrollmentRequestV5, "signature">;
type UnsignedEnrollmentResponseV1 = Omit<MeshEnrollmentResponseV1, "signature">;
type UnsignedEnrollmentResponseV2 = Omit<MeshEnrollmentResponseV2, "signature">;
type UnsignedEnrollmentResponseV5 = Omit<MeshEnrollmentResponseV5, "signature">;
type UnsignedEnrollmentRequest =
  | UnsignedEnrollmentRequestV1
  | UnsignedEnrollmentRequestV2
  | UnsignedEnrollmentRequestV5;
type UnsignedEnrollmentResponse =
  | UnsignedEnrollmentResponseV1
  | UnsignedEnrollmentResponseV2
  | UnsignedEnrollmentResponseV5;
type UnsignedHealthCheckV1 = Omit<MeshHealthCheckV1, "signature">;
type UnsignedHealthCheckV5 = Omit<MeshHealthCheckV5, "signature">;
type UnsignedHealthCheck = UnsignedHealthCheckV1 | UnsignedHealthCheckV5;
type UnsignedHealthCheckResponseV1 = Omit<
  MeshHealthCheckResponseV1,
  "signature"
>;
type UnsignedHealthCheckResponseV5 = Omit<
  MeshHealthCheckResponseV5,
  "signature"
>;
type UnsignedHealthCheckResponse =
  | UnsignedHealthCheckResponseV1
  | UnsignedHealthCheckResponseV5;
type UnsignedRevocationNotice = Omit<MeshRevocationNotice, "signature">;
type UnsignedWorkerKillRequest = Omit<MeshWorkerKillRequest, "signature">;
type UnsignedExecutionSession = Omit<MeshExecutionSessionRequest, "signature">;

export function buildMeshEnrollmentRequestSigningPayload(
  envelope: UnsignedEnrollmentRequest,
): string {
  if (envelope.protocolVersion === 5) {
    const v5Envelope = envelope as UnsignedEnrollmentRequestV5;
    return JSON.stringify([
      "clanky-mesh-enrollment-request-v5",
      v5Envelope.protocolVersion,
      v5Envelope.workerNodeId,
      v5Envelope.workerInstanceName ?? null,
      v5Envelope.workerPublicKey,
      v5Envelope.workerFingerprint,
      v5Envelope.workerEncryptionPublicKey,
      v5Envelope.workerDirectory,
      v5Envelope.workerPlatform,
      v5Envelope.workerCapabilities,
      v5Envelope.workerAcceptRemoteExecution,
      v5Envelope.workerConfigRevision,
      v5Envelope.binaryVersion,
      v5Envelope.supportedProtocolVersions,
      v5Envelope.preferredProtocolVersion,
      v5Envelope.enrollmentToken,
      v5Envelope.expectedControllerFingerprint,
      v5Envelope.route,
      v5Envelope.nonce,
      v5Envelope.expiresAt,
    ]);
  }
  if (envelope.protocolVersion === 2) {
    const relayEnvelope = envelope as UnsignedEnrollmentRequestV2;
    const payload: unknown[] = [
      "clanky-mesh-enrollment-request-v2",
      relayEnvelope.protocolVersion,
      relayEnvelope.workerNodeId,
      relayEnvelope.workerInstanceName ?? null,
      relayEnvelope.workerPublicKey,
      relayEnvelope.workerFingerprint,
      relayEnvelope.workerEncryptionPublicKey,
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
    directEnvelope.workerEncryptionPublicKey,
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
  const domain = envelope.protocolVersion === 5
    ? "clanky-mesh-enrollment-response-v5"
    : envelope.protocolVersion === 2
      ? "clanky-mesh-enrollment-response-v2"
      : "clanky-mesh-enrollment-response-v1";
  if (envelope.protocolVersion === 5) {
    const response = envelope as UnsignedEnrollmentResponseV5;
    return JSON.stringify([
      domain,
      response.protocolVersion,
      response.workerNodeId,
      response.controllerNodeId,
      response.controllerInstanceName,
      response.controllerPublicKey,
      response.controllerFingerprint,
      response.controllerEncryptionPublicKey,
      response.binaryVersion,
      response.supportedProtocolVersions,
      response.preferredProtocolVersion,
    ]);
  }
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
    response.controllerEncryptionPublicKey,
  ]);
}

export function buildMeshHealthCheckSigningPayload(
  envelope: UnsignedHealthCheck,
): string {
  const payload: unknown[] = [
    envelope.protocolVersion === 5
      ? "clanky-mesh-health-check-v5"
      : "clanky-mesh-health-check-v1",
    envelope.protocolVersion,
    envelope.senderNodeId,
    envelope.senderPublicKey,
    envelope.senderFingerprint,
  ];
  if (envelope.protocolVersion === 5) {
    payload.push(
      envelope.binaryVersion,
      envelope.supportedProtocolVersions,
      envelope.preferredProtocolVersion,
    );
  }
  payload.push(envelope.nonce, envelope.sentAt);
  return JSON.stringify(payload);
}

export function buildMeshHealthCheckResponseSigningPayload(
  envelope: UnsignedHealthCheckResponse,
): string {
  const payload: unknown[] = [
    envelope.protocolVersion === 5
      ? "clanky-mesh-health-check-response-v5"
      : "clanky-mesh-health-check-response-v1",
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
  if (envelope.protocolVersion === 5) {
    const v5Envelope = envelope as UnsignedHealthCheckResponseV5;
    payload.push(
      v5Envelope.binaryVersion,
      v5Envelope.supportedProtocolVersions,
      v5Envelope.preferredProtocolVersion,
    );
  }
  return JSON.stringify(payload);
}

export function buildMeshRevocationNoticeSigningPayload(
  envelope: UnsignedRevocationNotice,
): string {
  return JSON.stringify([
    envelope.protocolVersion === 5
      ? "clanky-mesh-revocation-notice-v5"
      : "clanky-mesh-revocation-notice-v1",
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
    envelope.protocolVersion === 5
      ? "clanky-mesh-worker-kill-request-v5"
      : "clanky-mesh-worker-kill-request-v1",
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
    envelope.protocolVersion === 5
      ? "clanky-mesh-execution-session-v5"
      : "clanky-mesh-execution-session-v1",
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
  payload.push(envelope.nonce, envelope.expiresAt);
  return JSON.stringify(payload);
}
