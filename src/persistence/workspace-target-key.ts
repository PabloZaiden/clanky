/**
 * Credential-free execution-target key construction shared by core target
 * resolution and persistence adapters.
 */

import { createHash } from "node:crypto";

function hashTarget(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function buildLocalTargetKey(installationId: string): string {
  return hashTarget(`local\u0000${installationId}`);
}

export function buildMeshTargetKey(nodeId: string): string {
  return hashTarget(`mesh\u0000${nodeId}`);
}

export function buildMeshEnrollmentTargetKey(
  enrollmentId: string,
  nodeId: string,
): string {
  return hashTarget(`mesh-enrollment\u0000${enrollmentId}\u0000${nodeId}`);
}

export function buildMeshWorkspaceTargetKey(
  workspaceId: string,
  nodeId: string,
): string {
  return hashTarget(`mesh-workspace\u0000${workspaceId}\u0000${nodeId}`);
}
