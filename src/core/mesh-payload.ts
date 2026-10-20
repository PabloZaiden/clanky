/**
 * The temporary Mesh 6 adapter is the only payload-crypto boundary.
 * Mesh 7 relies on authenticated TLS hops through trusted relays.
 */
import { MESH_LEGACY_PROTOCOL_VERSION, type MeshProtocolVersion } from "@/shared/mesh-protocol";
import { decryptMeshPayload, encryptMeshPayload, isEncryptedMeshPayload } from "./mesh-payload-crypto";
import { DomainError } from "../domain/domain-error";

export interface MeshPayloadFields {
  payload?: unknown;
  encryptedPayload?: unknown;
}

export function encodeMeshPayload(
  version: MeshProtocolVersion,
  value: unknown,
  recipientKey: string,
): MeshPayloadFields {
  return version === MESH_LEGACY_PROTOCOL_VERSION
    ? { encryptedPayload: encryptMeshPayload(value, recipientKey) }
    : { payload: value };
}

export async function decodeMeshPayload(version: MeshProtocolVersion, envelope: MeshPayloadFields): Promise<unknown> {
  if (version !== MESH_LEGACY_PROTOCOL_VERSION) {
    if (!Object.hasOwn(envelope, "payload") || Object.hasOwn(envelope, "encryptedPayload")) {
      throw new DomainError("mesh_execution_protocol_mismatch", "The Mesh payload does not match its negotiated generation.");
    }
    return envelope.payload;
  }
  const encrypted = envelope.encryptedPayload;
  if (Object.hasOwn(envelope, "payload") || !isEncryptedMeshPayload(encrypted)) {
    throw new DomainError("mesh_execution_protocol_mismatch", "The Mesh 6 payload must be encrypted.");
  }
  return await decryptMeshPayload(encrypted);
}

export function encodeMeshEnvironment(
  version: MeshProtocolVersion,
  environment: Record<string, string> | undefined,
  recipientKey: string,
): { environment?: Record<string, string>; encryptedEnvironment?: unknown } {
  if (environment === undefined) return {};
  return version === MESH_LEGACY_PROTOCOL_VERSION
    ? { encryptedEnvironment: encryptMeshPayload(environment, recipientKey) }
    : { environment };
}

export async function decodeMeshEnvironment(request: {
  protocolVersion: MeshProtocolVersion;
  environment?: Record<string, string>;
  encryptedEnvironment?: unknown;
}): Promise<unknown> {
  if (request.protocolVersion !== MESH_LEGACY_PROTOCOL_VERSION) return request.environment;
  return request.encryptedEnvironment == null ? undefined
    : await decodeMeshPayload(request.protocolVersion, { encryptedPayload: request.encryptedEnvironment });
}
