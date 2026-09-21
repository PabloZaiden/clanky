import type {
  MeshRelayAuthFrame,
  MeshRelayChallengeFrame,
  MeshRelayEnrollmentAdmission,
} from "@/shared/mesh-relay";

type UnsignedRelayChallenge = Omit<MeshRelayChallengeFrame, "signature">;
type UnsignedRelayAuth = Omit<MeshRelayAuthFrame, "signature">;

export function buildMeshRelayChallengeSigningPayload(
  challenge: UnsignedRelayChallenge,
): string {
  return JSON.stringify([
    challenge.protocolVersion === 5
      ? "clanky-mesh-relay-challenge-v5"
      : "clanky-mesh-relay-challenge-v1",
    challenge.protocolVersion,
    challenge.challengeId,
    challenge.nonce,
    challenge.relayPublicKey,
    challenge.relayFingerprint,
    challenge.issuedAt,
    challenge.expiresAt,
  ]);
}

export function buildMeshRelayAuthSigningPayload(auth: UnsignedRelayAuth): string {
  return JSON.stringify([
    auth.protocolVersion === 5
      ? "clanky-mesh-relay-auth-v5"
      : "clanky-mesh-relay-auth-v1",
    auth.protocolVersion,
    auth.role,
    auth.nodeId,
    auth.publicKey,
    auth.fingerprint,
    auth.challengeId,
    auth.nonce,
    auth.relayFingerprint,
    auth.expiresAt,
    auth.enrollmentAdmission ?? null,
  ]);
}

export function buildMeshRelayEnrollmentAdmissionSigningPayload(
  admission: Omit<MeshRelayEnrollmentAdmission, "signature">,
): string {
  return JSON.stringify([
    "clanky-mesh-relay-enrollment-admission-v1",
    admission.version,
    admission.controllerNodeId,
    admission.controllerFingerprint,
    admission.nonce,
    admission.expiresAt,
  ]);
}
