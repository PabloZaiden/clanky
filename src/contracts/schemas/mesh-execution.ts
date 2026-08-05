import { z } from "zod";
import {
  MESH_EXECUTION_CHANNEL,
  MESH_ACP_CHANNEL,
  MESH_EXECUTION_OPERATIONS,
  MESH_EXECUTION_PROTOCOL_VERSION,
  MESH_EXECUTION_MAX_RPC_TIMEOUT_MS,
  MESH_EXECUTION_MAX_RESULT_BYTES,
} from "@/shared/mesh-execution";

const MeshExecutionPathSchema = z.string().min(1).max(16_384);

export const MeshExecutionSessionRequestSchema = z.object({
  protocolVersion: z.literal(MESH_EXECUTION_PROTOCOL_VERSION),
  requestId: z.string().trim().min(1).max(200),
  linkId: z.string().trim().min(1).max(200),
  callerNodeId: z.string().trim().min(1).max(200),
  callerPublicKey: z.string().min(1).max(16_384),
  callerFingerprint: z.string().trim().min(1).max(200),
  callerEncryptionPublicKey: z.string().min(1).max(16_384),
  targetNodeId: z.string().trim().min(1).max(200),
  workspaceId: z.string().trim().min(1).max(200),
  directory: MeshExecutionPathSchema,
  channel: z.union([z.literal(MESH_EXECUTION_CHANNEL), z.literal(MESH_ACP_CHANNEL)]),
  nonce: z.string().trim().min(1).max(200),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1).max(16_384),
});

export const MeshExecutionRpcRequestSchema = z.object({
  protocolVersion: z.literal(MESH_EXECUTION_PROTOCOL_VERSION),
  sessionId: z.string().trim().min(1).max(200),
  sessionToken: z.string().trim().min(32).max(256),
  requestId: z.string().trim().min(1).max(200),
  operation: z.enum(MESH_EXECUTION_OPERATIONS),
  command: z.string().min(1).max(4_096).optional(),
  args: z.array(z.string().max(16_384)).max(256).optional(),
  cwd: MeshExecutionPathSchema.optional(),
  timeout: z.number().int().min(1).max(MESH_EXECUTION_MAX_RPC_TIMEOUT_MS).nullable().optional(),
  env: z.record(z.string().max(1_024), z.string().max(32_768)).optional(),
  path: MeshExecutionPathSchema.optional(),
  content: z.string().max(MESH_EXECUTION_MAX_RESULT_BYTES).optional(),
  includeHidden: z.boolean().optional(),
});

export type MeshExecutionSessionRequest = z.infer<typeof MeshExecutionSessionRequestSchema>;
export type MeshExecutionRpcRequest = z.infer<typeof MeshExecutionRpcRequestSchema>;
