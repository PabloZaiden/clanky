/**
 * Bounded discovery for a controller or relay enrollment target.
 */

import { MeshWellKnownDescriptorSchema } from "@/contracts/schemas/mesh-relay";
import {
  MESH_RUNTIME_SNAPSHOT_HEADER,
  MESH_RUNTIME_SNAPSHOT_VERSION,
} from "@/shared/mesh";
import {
  MESH_RELAY_DESCRIPTOR_PATH,
  MESH_RELAY_WORKSPACE_CLIENT_HEADER,
  MESH_RELAY_WORKSPACE_CLIENT_VERSION,
  normalizeMeshRelayOrigin,
  type MeshWellKnownDescriptor,
} from "@/shared/mesh-relay";
import {
  meshTransportProtocolVersions,
  negotiateMeshDescriptorGeneration,
  negotiateMeshProtocolVersion,
  MESH_PROTOCOL_VERSIONS_HEADER,
  serializeMeshProtocolVersions,
  type MeshProtocolVersion,
} from "@/shared/mesh-protocol";
import { DomainError } from "../domain/domain-error";

export const MESH_TARGET_DISCOVERY_TIMEOUT_MS = 10_000;
export const MESH_TARGET_DISCOVERY_MAX_BYTES = 64 * 1024;

export function normalizeMeshEnrollmentTarget(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw new DomainError(
      "mesh_enrollment_target_invalid",
      "The Mesh enrollment target must be a valid absolute URL.",
      { cause: error },
    );
  }
  if (url.protocol !== "https:") {
    throw new DomainError(
      "mesh_enrollment_target_invalid",
      "The Mesh enrollment target must use HTTPS.",
    );
  }
  if (
    url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new DomainError(
      "mesh_enrollment_target_invalid",
      "The Mesh enrollment target must be an absolute HTTPS origin without credentials, a path, a query, or a fragment.",
    );
  }
  return url.origin;
}

async function readBoundedDescriptor(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new DomainError(
      "mesh_enrollment_discovery_too_large",
      "The Mesh target descriptor exceeds the allowed size.",
    );
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DomainError(
          "mesh_enrollment_discovery_too_large",
          "The Mesh target descriptor exceeds the allowed size.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function discoverMeshEnrollmentTarget(
  target: string,
  options: {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
    workspaceClient?: boolean;
  } = {},
): Promise<{
  target: string;
  descriptor: MeshWellKnownDescriptor;
  runtimeSnapshotVersion: number;
  negotiatedProtocolVersion: MeshProtocolVersion;
}> {
  const normalizedTarget = normalizeMeshEnrollmentTarget(target);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? MESH_TARGET_DISCOVERY_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    const response = await (options.fetchFn ?? fetch)(
      new URL(MESH_RELAY_DESCRIPTOR_PATH, `${normalizedTarget}/`),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          [MESH_PROTOCOL_VERSIONS_HEADER]: serializeMeshProtocolVersions(meshTransportProtocolVersions(normalizedTarget)),
          ...(options.workspaceClient ? {
            [MESH_RELAY_WORKSPACE_CLIENT_HEADER]: String(MESH_RELAY_WORKSPACE_CLIENT_VERSION),
          } : {}),
        },
        signal: controller.signal,
        redirect: "error",
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new DomainError(
        "mesh_enrollment_discovery_rejected",
        "The Mesh target descriptor request was rejected.",
        { details: { status: response.status } },
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readBoundedDescriptor(
        response,
        options.maxBytes ?? MESH_TARGET_DISCOVERY_MAX_BYTES,
      )) as unknown;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      throw new DomainError(
        "mesh_enrollment_discovery_invalid",
        "The Mesh target descriptor is not valid JSON.",
        { cause: error },
      );
    }
    const generation = negotiateMeshDescriptorGeneration(raw, meshTransportProtocolVersions(normalizedTarget));
    if (!generation) throw new DomainError("mesh_enrollment_discovery_invalid", "The Mesh target has no highest mutually supported generation.");
    const parsed = MeshWellKnownDescriptorSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError(
        "mesh_enrollment_discovery_invalid",
        "The Mesh target descriptor is incompatible or invalid.",
        { cause: parsed.error },
      );
    }
    if (!parsed.data.negotiatedProtocolVersion || parsed.data.negotiatedProtocolVersion !== negotiateMeshProtocolVersion(
      meshTransportProtocolVersions(normalizedTarget), parsed.data.supportedProtocolVersions,
    )) {
      throw new DomainError(
        "mesh_enrollment_discovery_invalid",
        "The Mesh target does not negotiate the required protocol generation.",
      );
    }
    if (parsed.data.role === "relay") {
      try {
        normalizeMeshRelayOrigin(normalizedTarget);
      } catch (error) {
        throw new DomainError(
          "mesh_enrollment_relay_url_insecure",
          "Remote Mesh relay targets must use HTTPS.",
          { cause: error },
        );
      }
    }
    const advertisedSnapshotVersion = Number(
      response.headers.get(MESH_RUNTIME_SNAPSHOT_HEADER),
    );
    const runtimeSnapshotVersion =
      Number.isInteger(advertisedSnapshotVersion)
        && advertisedSnapshotVersion >= MESH_RUNTIME_SNAPSHOT_VERSION
        ? advertisedSnapshotVersion
        : 0;
    const descriptor = parsed.data;
    const controllerVersions = descriptor.role === "relay"
      ? descriptor.controllerSupportedProtocolVersions ?? []
      : descriptor.supportedProtocolVersions;
    const negotiated = descriptor.role === "relay"
      ? negotiateMeshProtocolVersion(meshTransportProtocolVersions(normalizedTarget), descriptor.supportedProtocolVersions.filter((version) => controllerVersions.includes(version)))
      : descriptor.negotiatedProtocolVersion;
    if (!negotiated) throw new DomainError("mesh_enrollment_discovery_invalid", "The controller, relay and worker have no mutually supported generation.");
    return {
      target: normalizedTarget,
      descriptor: parsed.data,
      runtimeSnapshotVersion,
      negotiatedProtocolVersion: negotiated,
    };
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new DomainError(
        "mesh_enrollment_discovery_timeout",
        "The Mesh target descriptor request timed out.",
        { cause: error },
      );
    }
    throw new DomainError(
      "mesh_enrollment_discovery_unreachable",
      "The Mesh target descriptor could not be reached.",
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}
