/**
 * Shared contracts for bounded non-interactive command execution.
 */

import { z } from "zod";
import {
  MESH_EXECUTION_MAX_RPC_TIMEOUT_MS,
  WORKSPACE_EXEC_MAX_OUTPUT_BYTES,
} from "@/shared/mesh-execution";

const executionString = (max: number) => z.string().max(max).refine(
  (value) => !value.includes("\0"),
  "NUL bytes are not allowed",
);

export const CommandExecRequestSchema = z.object({
  command: executionString(4_096).trim().min(1, "command is required"),
  args: z.array(executionString(16_384)).max(256).default([]),
  cwd: executionString(16_384).trim().min(1).optional(),
  timeoutMs: z.number().int().min(1).max(MESH_EXECUTION_MAX_RPC_TIMEOUT_MS).optional(),
}).strict();

export const CommandExecResultSchema = z.object({
  success: z.boolean(),
  stdout: z.string().max(WORKSPACE_EXEC_MAX_OUTPUT_BYTES),
  stderr: z.string().max(WORKSPACE_EXEC_MAX_OUTPUT_BYTES),
  exitCode: z.number().int(),
}).strict();

export type CommandExecRequest = z.infer<typeof CommandExecRequestSchema>;
export type CommandExecResult = z.infer<typeof CommandExecResultSchema>;
