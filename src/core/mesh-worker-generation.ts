/**
 * Discover and verify the worker generation before emitting any contract.
 */
import { MeshWorkerProtocolDescriptorSchema, type MeshWorkerProtocolDescriptor } from "@/contracts/schemas/mesh";
import type { MeshWorkerRegistration } from "@/shared/mesh";
import { MESH_PROTOCOL_VERSION_HEADER, MESH_PROTOCOL_VERSIONS_HEADER, MESH_SUPPORTED_PROTOCOL_VERSIONS, isSupportedMeshProtocolVersion, negotiateMeshProtocolVersion, serializeMeshProtocolVersions, parseMeshProtocolVersionsHeader, meshProtocolProjection, type MeshProtocolVersion } from "@/shared/mesh-protocol";
import { requestMeshPeer } from "./mesh-peer-transport";
import { meshRouteSupportedProtocolVersions } from "./mesh-route-version";
import { verifyMeshPayloadSignature, ensureLocalMeshNodeIdentity, signMeshPayload } from "../persistence/mesh-node-identity";
import { DomainError } from "../domain/domain-error";
import { requireMeshRuntimeRole } from "./mesh-runtime";
import { getLocalMeshProtocolMetadata } from "./mesh-protocol-version";
import { readMeshControlResponseJson } from "./mesh-control-client";

export function meshWorkerGenerationSigningPayload(input: Omit<MeshWorkerProtocolDescriptor, "signature">): string {
  return JSON.stringify([`clanky-mesh-worker-generation-v${input.protocolVersion}`, input.nodeId, input.fingerprint, input.requestNonce, input.binaryVersion, input.supportedProtocolVersions, input.preferredProtocolVersion]);
}

export async function describeMeshWorkerGeneration(versionsHeader: string | null, nonce: string | null): Promise<MeshWorkerProtocolDescriptor> {
  requireMeshRuntimeRole("worker");
  const selected = negotiateMeshProtocolVersion(
    MESH_SUPPORTED_PROTOCOL_VERSIONS,
    parseMeshProtocolVersionsHeader(versionsHeader),
  );
  if (!selected || !nonce || nonce.length > 200) throw new DomainError("mesh_execution_protocol_mismatch", "Supported generations and a request nonce are required.");
  const identity = await ensureLocalMeshNodeIdentity();
  const descriptor = {
    ...meshProtocolProjection(selected),
    nodeId: identity.nodeId, fingerprint: identity.fingerprint, requestNonce: nonce,
    binaryVersion: getLocalMeshProtocolMetadata().binaryVersion!,
  };
  return { ...descriptor, signature: await signMeshPayload(meshWorkerGenerationSigningPayload(descriptor)) };
}

export async function discoverMeshWorkerGeneration(worker: MeshWorkerRegistration, signal?: AbortSignal, fetch?: typeof globalThis.fetch): Promise<MeshProtocolVersion> {
  const versions = meshRouteSupportedProtocolVersions(worker.route);
  if (versions.length === 0) {
    throw new DomainError("mesh_execution_protocol_mismatch", "The Mesh route has no supported generation.");
  }
  const nonce = crypto.randomUUID();
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await requestMeshPeer(worker.route, "api/mesh/internal/protocol", {
      method: "GET", signal: controller.signal, fetch,
      headers: { [MESH_PROTOCOL_VERSIONS_HEADER]: serializeMeshProtocolVersions(versions), "x-clanky-mesh-request-id": nonce },
    });
    if (response.status === 404) {
      await response.body?.cancel();
      throw new DomainError("mesh_execution_protocol_mismatch", "The worker does not expose generation discovery.");
    }
    if (!response.ok) throw new DomainError("mesh_execution_protocol_mismatch", "The worker generation discovery request was rejected.");
    const selectedValue = Number(response.headers.get(MESH_PROTOCOL_VERSION_HEADER));
    if (
      !isSupportedMeshProtocolVersion(selectedValue)
      || !versions.includes(selectedValue)
    ) {
      throw new DomainError("mesh_execution_protocol_mismatch", "The worker selected an unsupported generation.");
    }
    const selected = selectedValue;
    const descriptor = MeshWorkerProtocolDescriptorSchema.parse(await readMeshControlResponseJson(response, { signal: controller.signal, maxBytes: 16_384 }));
    const { signature, ...unsigned } = descriptor;
    if (descriptor.protocolVersion !== selected || descriptor.nodeId !== worker.workerNodeId
      || descriptor.requestNonce !== nonce || descriptor.fingerprint !== worker.workerFingerprint
      || selected !== negotiateMeshProtocolVersion(versions, descriptor.supportedProtocolVersions)
      || !verifyMeshPayloadSignature(meshWorkerGenerationSigningPayload(unsigned), signature, worker.workerPublicKey)
    ) throw new DomainError("mesh_execution_protocol_mismatch", "The worker generation descriptor is invalid.");
    return descriptor.protocolVersion;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("mesh_execution_unreachable", "Worker generation discovery could not complete.", { cause: error });
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
