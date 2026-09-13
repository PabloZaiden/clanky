/**
 * Request and response schemas for one-shot workspace command execution.
 */

import { z } from "zod";
import {
  CommandExecRequestSchema,
  CommandExecResultSchema,
} from "./command-execution";

export const WorkspaceExecRequestSchema = CommandExecRequestSchema;

export const WorkspaceExecResponseSchema = z.object({
  workspaceId: z.string().min(1),
  ...CommandExecResultSchema.shape,
}).strict();

export type WorkspaceExecRequest = z.infer<typeof CommandExecRequestSchema>;
export type WorkspaceExecResponse = z.infer<typeof WorkspaceExecResponseSchema>;
