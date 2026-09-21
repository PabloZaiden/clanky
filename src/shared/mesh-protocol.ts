/**
 * Global Mesh wire-generation metadata.
 *
 * Mesh v5 is aligned with the Clanky release major and covers controller,
 * relay, and worker transports as one generation.
 */

export const MESH_PROTOCOL_VERSION = 5 as const;
export const MESH_SUPPORTED_PROTOCOL_VERSIONS = [
  MESH_PROTOCOL_VERSION,
] as const;
export const MESH_PROTOCOL_PREFERRED_VERSION = MESH_PROTOCOL_VERSION;

export type MeshProtocolVersion = typeof MESH_SUPPORTED_PROTOCOL_VERSIONS[number];

export const MESH_PROTOCOL_VERSIONS_HEADER =
  "x-clanky-mesh-protocol-versions";
export const MESH_PROTOCOL_VERSION_HEADER =
  "x-clanky-mesh-protocol-version";
export const MESH_BINARY_VERSION_HEADER =
  "x-clanky-binary-version";

export interface MeshProtocolMetadata {
  binaryVersion: string | null;
  supportedProtocolVersions: MeshProtocolVersion[];
  preferredProtocolVersion: MeshProtocolVersion;
  negotiatedProtocolVersion: MeshProtocolVersion | null;
}

export function normalizeMeshProtocolVersions(
  versions: readonly number[] | undefined,
): MeshProtocolVersion[] {
  const normalized = new Set<MeshProtocolVersion>();
  for (const version of versions ?? []) {
    if (version === MESH_PROTOCOL_VERSION) {
      normalized.add(version);
    }
  }
  return [...normalized].sort((left, right) => right - left);
}

export function negotiateMeshProtocolVersion(
  localVersions: readonly MeshProtocolVersion[],
  remoteVersions: readonly MeshProtocolVersion[],
): MeshProtocolVersion | null {
  const remote = new Set(remoteVersions);
  return normalizeMeshProtocolVersions(localVersions)
    .find((version) => remote.has(version))
    ?? null;
}

export function parseMeshProtocolVersionsHeader(
  value: string | null,
): MeshProtocolVersion[] {
  if (!value) {
    return [];
  }
  return normalizeMeshProtocolVersions(
    value.split(",").map((part) => Number.parseInt(part.trim(), 10)),
  );
}

export function serializeMeshProtocolVersions(
  versions: readonly MeshProtocolVersion[] = MESH_SUPPORTED_PROTOCOL_VERSIONS,
): string {
  return normalizeMeshProtocolVersions(versions).join(",");
}
