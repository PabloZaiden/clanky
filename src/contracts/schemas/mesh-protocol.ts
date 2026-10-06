import { z } from "zod";

export const MeshProtocolGenerationSchema = z.number().int().positive()
  .refine(Number.isSafeInteger, {
    message: "Mesh protocol generations must be safe integers.",
  });

export const MeshProtocolVersionsSchema = z.array(
  MeshProtocolGenerationSchema,
).min(1).max(32).refine(
  (versions) => new Set(versions).size === versions.length,
  { message: "Mesh protocol generations must be unique." },
);

export function assertMeshProtocolMetadata(
  value: {
    protocolVersion: number;
    supportedProtocolVersions: readonly number[];
    preferredProtocolVersion: number;
    negotiatedProtocolVersion?: number | null;
  },
  context: z.RefinementCtx,
): void {
  if (!value.supportedProtocolVersions.includes(value.protocolVersion)) {
    context.addIssue({
      code: "custom",
      path: ["supportedProtocolVersions"],
      message: "The selected Mesh generation must be advertised.",
    });
  }
  if (!value.supportedProtocolVersions.includes(value.preferredProtocolVersion)) {
    context.addIssue({
      code: "custom",
      path: ["preferredProtocolVersion"],
      message: "The preferred Mesh generation must be advertised.",
    });
  }
  if (
    value.negotiatedProtocolVersion != null
    && !value.supportedProtocolVersions.includes(value.negotiatedProtocolVersion)
  ) {
    context.addIssue({
      code: "custom",
      path: ["negotiatedProtocolVersion"],
      message: "The negotiated Mesh generation must be advertised.",
    });
  }
}
