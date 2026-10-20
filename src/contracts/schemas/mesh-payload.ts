/**
 * Generation boundary for transport payloads and managed environments.
 */
import { z } from "zod";
import { MESH_LEGACY_PROTOCOL_VERSION } from "@/shared/mesh-protocol";

export function assertMeshEnvironmentGeneration(
  value: { protocolVersion: number; environment?: unknown; encryptedEnvironment?: unknown },
  ctx: z.RefinementCtx,
): void {
  const forbidden = value.protocolVersion === MESH_LEGACY_PROTOCOL_VERSION
    ? "environment" : "encryptedEnvironment";
  if (value[forbidden] !== undefined) {
    ctx.addIssue({ code: "custom", path: [forbidden], message: "Environment does not match the negotiated Mesh generation." });
  }
}
