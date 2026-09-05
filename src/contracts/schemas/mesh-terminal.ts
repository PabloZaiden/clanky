import { z } from "zod";
import {
  MESH_TERMINAL_CAPABILITY,
  MESH_TERMINAL_MAX_CLIPBOARD_BYTES,
  MESH_TERMINAL_MAX_INPUT_BYTES,
  MESH_TERMINAL_MAX_OUTPUT_BYTES,
  MESH_TERMINAL_PROTOCOL_VERSION,
} from "@/shared/mesh-terminal";
import { AgentProviderSchema } from "./workspace";

const MeshTerminalPathSchema = z.string().min(1).max(16_384);
const byteBoundedString = (maximumBytes: number) => z.string().refine(
  (value) => new TextEncoder().encode(value).byteLength <= maximumBytes,
  { message: `String exceeds the ${String(maximumBytes)} byte limit` },
);

export const MeshTerminalSessionRequestSchema = z.object({
  protocolVersion: z.literal(MESH_TERMINAL_PROTOCOL_VERSION),
  capability: z.literal(MESH_TERMINAL_CAPABILITY),
  requestId: z.string().trim().min(1).max(200),
  callerNodeId: z.string().trim().min(1).max(200),
  callerPublicKey: z.string().min(1).max(16_384),
  callerFingerprint: z.string().trim().min(1).max(200),
  callerEncryptionPublicKey: z.string().min(1).max(16_384),
  targetNodeId: z.string().trim().min(1).max(200),
  workspaceId: z.string().trim().min(1).max(200),
  executionRoot: MeshTerminalPathSchema,
  directory: MeshTerminalPathSchema,
  provider: AgentProviderSchema,
  terminalSessionId: z.string().trim().min(1).max(200),
  remoteSessionName: z.string().trim().min(1).max(200),
  connectionMode: z.enum(["dtach", "direct"]),
  useTmux: z.boolean(),
  allowPersistentSessionCreate: z.boolean().default(true),
  encryptedEnvironment: z.unknown().optional(),
  nonce: z.string().trim().min(1).max(200),
  expiresAt: z.string().datetime(),
  signature: z.string().trim().min(1).max(16_384),
});

export const MeshTerminalClientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("terminal.input"),
    data: byteBoundedString(MESH_TERMINAL_MAX_INPUT_BYTES),
  }),
  z.object({
    type: z.literal("terminal.resize"),
    cols: z.number().int().min(2).max(10_000),
    rows: z.number().int().min(1).max(10_000),
  }),
  z.object({ type: z.literal("terminal.close") }),
  z.object({ type: z.literal("ping") }),
]);

export const MeshTerminalServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("terminal.ready"),
    runtimeConnectionMode: z.enum(["dtach", "direct"]),
    notice: z.string().max(4_096).optional(),
  }),
  z.object({
    type: z.literal("terminal.output"),
    data: byteBoundedString(MESH_TERMINAL_MAX_OUTPUT_BYTES),
  }),
  z.object({
    type: z.literal("terminal.clipboard"),
    text: byteBoundedString(MESH_TERMINAL_MAX_CLIPBOARD_BYTES),
  }),
  z.object({
    type: z.literal("terminal.exit"),
    code: z.number().int().nullable(),
    signal: z.string().max(100).nullable(),
  }),
  z.object({
    type: z.literal("terminal.error"),
    code: z.string().max(200).optional(),
    message: z.string().min(1).max(4_096),
  }),
  z.object({ type: z.literal("pong") }),
]);

export type MeshTerminalSessionRequest = z.infer<typeof MeshTerminalSessionRequestSchema>;
export type MeshTerminalClientFrame = z.infer<typeof MeshTerminalClientFrameSchema>;
export type MeshTerminalServerFrame = z.infer<typeof MeshTerminalServerFrameSchema>;
