/**
 * Contracts for direct command execution on a registered execution host.
 */

import { z } from "zod";
import {
  CommandExecRequestSchema,
  CommandExecResultSchema,
} from "./command-execution";

export const ExecutionHostExecRequestSchema = CommandExecRequestSchema;

export const ExecutionHostExecResponseSchema = z.object({
  executionHost: z.string().trim().min(1),
  ...CommandExecResultSchema.shape,
}).strict();

export type ExecutionHostExecRequest = z.infer<typeof CommandExecRequestSchema>;
export type ExecutionHostExecResponse = z.infer<typeof ExecutionHostExecResponseSchema>;
