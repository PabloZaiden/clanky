/**
 * Request and response schemas for one-shot workspace command execution.
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

export const WorkspaceExecRequestSchema = z.object({
  command: executionString(4_096).trim().min(1, "command is required"),
  args: z.array(executionString(16_384)).max(256).default([]),
  cwd: executionString(16_384).trim().min(1).optional(),
  timeoutMs: z.number().int().min(1).max(MESH_EXECUTION_MAX_RPC_TIMEOUT_MS).optional(),
}).strict();

export const WorkspaceExecResponseSchema = z.object({
  workspaceId: z.string().min(1),
  success: z.boolean(),
  stdout: z.string().max(WORKSPACE_EXEC_MAX_OUTPUT_BYTES),
  stderr: z.string().max(WORKSPACE_EXEC_MAX_OUTPUT_BYTES),
  exitCode: z.number().int(),
});

export type WorkspaceExecRequest = z.infer<typeof WorkspaceExecRequestSchema>;
export type WorkspaceExecResponse = z.infer<typeof WorkspaceExecResponseSchema>;
