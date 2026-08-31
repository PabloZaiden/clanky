/**
 * Credential-free execution-target key construction shared by core target
 * resolution and persistence compatibility adapters.
 */

import { createHash } from "node:crypto";

function hashTarget(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function buildSshTargetKey(
  host: string,
  port: number,
  username?: string,
): string {
  return hashTarget([
    "ssh",
    host.trim().toLowerCase(),
    String(port),
    username?.trim() ?? "",
  ].join("\u0000"));
}

export function buildLocalTargetKey(installationId: string): string {
  return hashTarget(`local\u0000${installationId}`);
}

export function buildMeshTargetKey(nodeId: string): string {
  return hashTarget(`mesh\u0000${nodeId}`);
}
