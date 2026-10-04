/**
 * Global Mesh wire-generation metadata.
 *
 * Generations cover controllers, relays and workers together. Keep v5 during
 * the v6.0 rollout; removal requires fleet confirmation for release 6.1.
 */

export const MESH_PROTOCOL_VERSION = 6 as const;
export const MESH_SUPPORTED_PROTOCOL_VERSIONS = [
  MESH_PROTOCOL_VERSION,
  5,
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
  harnessAdapters?: readonly ("acp" | "copilot" | "codex" | "opencode2")[];
}

export function normalizeMeshProtocolVersions(
  versions: readonly number[] | undefined,
): MeshProtocolVersion[] {
  const normalized = new Set<MeshProtocolVersion>();
  for (const version of versions ?? []) {
    if (version === 5 || version === 6) {
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
    value.split(",").map((part) => Number(part.trim())),
  );
}

/** Exact v5 projection: old strict readers require [5] and preferred 5. */
export function meshProtocolProjection(version: MeshProtocolVersion): {
  protocolVersion: MeshProtocolVersion;
  supportedProtocolVersions: MeshProtocolVersion[];
  preferredProtocolVersion: MeshProtocolVersion;
} {
  return {
    protocolVersion: version,
    supportedProtocolVersions: version === 5 ? [5] : [...MESH_SUPPORTED_PROTOCOL_VERSIONS],
    preferredProtocolVersion: version,
  };
}

export function serializeMeshProtocolVersions(
  versions: readonly MeshProtocolVersion[] = MESH_SUPPORTED_PROTOCOL_VERSIONS,
): string {
  return normalizeMeshProtocolVersions(versions).join(",");
}
