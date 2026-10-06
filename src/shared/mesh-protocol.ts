/**
 * Global Mesh wire-generation metadata.
 *
 * Generations cover controllers, relays and workers together.
 */

export const MESH_PROTOCOL_VERSION = 6 as const;
export const MESH_SUPPORTED_PROTOCOL_VERSIONS = [MESH_PROTOCOL_VERSION] as const;
export const MESH_PROTOCOL_PREFERRED_VERSION = MESH_PROTOCOL_VERSION;

export type MeshProtocolGeneration = number;
export type MeshProtocolVersion = typeof MESH_SUPPORTED_PROTOCOL_VERSIONS[number];

export const MESH_PROTOCOL_VERSIONS_HEADER =
  "x-clanky-mesh-protocol-versions";
export const MESH_PROTOCOL_VERSION_HEADER =
  "x-clanky-mesh-protocol-version";
export const MESH_BINARY_VERSION_HEADER =
  "x-clanky-binary-version";

export interface MeshProtocolMetadata {
  binaryVersion: string | null;
  supportedProtocolVersions: MeshProtocolGeneration[];
  preferredProtocolVersion: MeshProtocolGeneration;
  negotiatedProtocolVersion: MeshProtocolVersion | null;
  harnessAdapters?: readonly ("acp" | "copilot" | "codex" | "opencode2")[];
}

export function isMeshProtocolGeneration(
  value: unknown,
): value is MeshProtocolGeneration {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0;
}

export function isSupportedMeshProtocolVersion(
  value: unknown,
): value is MeshProtocolVersion {
  return isMeshProtocolGeneration(value)
    && MESH_SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === value);
}

export function normalizeMeshProtocolVersions(
  versions: readonly number[] | undefined,
): MeshProtocolGeneration[] {
  const normalized = new Set<MeshProtocolGeneration>();
  for (const version of versions ?? []) {
    if (isMeshProtocolGeneration(version)) {
      normalized.add(version);
    }
  }
  return [...normalized].sort((left, right) => right - left);
}

export function negotiateMeshProtocolGeneration(
  localVersions: readonly MeshProtocolGeneration[],
  remoteVersions: readonly MeshProtocolGeneration[],
): MeshProtocolGeneration | null {
  const remote = new Set(normalizeMeshProtocolVersions(remoteVersions));
  return normalizeMeshProtocolVersions(localVersions)
    .find((version) => remote.has(version))
    ?? null;
}

export function negotiateMeshProtocolVersion(
  localVersions: readonly MeshProtocolVersion[],
  remoteVersions: readonly MeshProtocolGeneration[],
): MeshProtocolVersion | null {
  const negotiated = negotiateMeshProtocolGeneration(localVersions, remoteVersions);
  return negotiated !== null
    && isSupportedMeshProtocolVersion(negotiated)
    && localVersions.includes(negotiated)
    ? negotiated
    : null;
}

export function parseMeshProtocolVersionsHeader(
  value: string | null,
): MeshProtocolGeneration[] {
  if (!value) {
    return [];
  }
  return normalizeMeshProtocolVersions(
    value.split(",").map((part) => Number(part.trim())),
  );
}

export function meshProtocolProjection(version: MeshProtocolVersion): {
  protocolVersion: MeshProtocolVersion;
  supportedProtocolVersions: MeshProtocolGeneration[];
  preferredProtocolVersion: MeshProtocolGeneration;
} {
  return {
    protocolVersion: version,
    supportedProtocolVersions: [...MESH_SUPPORTED_PROTOCOL_VERSIONS],
    preferredProtocolVersion: MESH_PROTOCOL_PREFERRED_VERSION,
  };
}

export function serializeMeshProtocolVersions(
  versions: readonly MeshProtocolGeneration[] = MESH_SUPPORTED_PROTOCOL_VERSIONS,
): string {
  return normalizeMeshProtocolVersions(versions).join(",");
}
