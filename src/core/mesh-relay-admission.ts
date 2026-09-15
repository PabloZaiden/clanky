/**
 * Controller-signed admission carried only while an unknown worker enrolls.
 */

import { MeshRelayEnrollmentAdmissionSchema } from "@/contracts/schemas/mesh-relay";
import {
  MESH_RELAY_ENROLLMENT_ADMISSION_VERSION,
  type MeshRelayEnrollmentAdmission,
  type MeshRelayPeerIdentity,
} from "@/shared/mesh-relay";
import { signMeshPayload } from "../persistence/mesh-node-identity";
import { verifyMeshRelaySignature } from "./mesh-relay-identity";
import { buildMeshRelayEnrollmentAdmissionSigningPayload } from "./mesh-relay-protocol";

const ADMISSION_PREFIX = "clanky_mesh_relay_";

export async function createMeshRelayEnrollmentAdmission(input: {
  controllerNodeId: string;
  controllerFingerprint: string;
  expiresAt: string;
  sign?: (payload: string) => Promise<string>;
}): Promise<string> {
  const unsigned: Omit<MeshRelayEnrollmentAdmission, "signature"> = {
    version: MESH_RELAY_ENROLLMENT_ADMISSION_VERSION,
    controllerNodeId: input.controllerNodeId,
    controllerFingerprint: input.controllerFingerprint,
    nonce: crypto.randomUUID(),
    expiresAt: input.expiresAt,
  };
  const admission: MeshRelayEnrollmentAdmission = {
    ...unsigned,
    signature: await (input.sign ?? signMeshPayload)(
      buildMeshRelayEnrollmentAdmissionSigningPayload(unsigned),
    ),
  };
  return `${ADMISSION_PREFIX}${Buffer.from(
    JSON.stringify(admission),
    "utf8",
  ).toString("base64url")}`;
}

export function verifyMeshRelayEnrollmentAdmission(
  token: string | undefined,
  controller: MeshRelayPeerIdentity | undefined,
  now = Date.now(),
): MeshRelayEnrollmentAdmission | undefined {
  if (!token?.startsWith(ADMISSION_PREFIX) || !controller) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      Buffer.from(token.slice(ADMISSION_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    ) as unknown;
  } catch {
    return undefined;
  }
  const parsed = MeshRelayEnrollmentAdmissionSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const admission = parsed.data;
  if (
    admission.controllerNodeId !== controller.nodeId
    || admission.controllerFingerprint !== controller.fingerprint
    || Date.parse(admission.expiresAt) <= now
  ) {
    return undefined;
  }
  const { signature, ...unsigned } = admission;
  return verifyMeshRelaySignature(
    buildMeshRelayEnrollmentAdmissionSigningPayload(unsigned),
    signature,
    controller.publicKey,
  )
    ? admission
    : undefined;
}

export function isMeshRelayEnrollmentAdmissionToken(token: string): boolean {
  return token.startsWith(ADMISSION_PREFIX);
}
