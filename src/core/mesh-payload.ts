/**
 * Read Mesh payload envelopes carried over authenticated TLS hops.
 */
import { DomainError } from "../domain/domain-error";

export interface MeshPayloadFields {
  payload?: unknown;
}

export function readMeshPayload(envelope: MeshPayloadFields): unknown {
  if (!Object.hasOwn(envelope, "payload")) {
    throw new DomainError("mesh_execution_protocol_mismatch", "The Mesh response has no payload.");
  }
  return envelope.payload;
}
