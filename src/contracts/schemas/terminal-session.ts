/**
 * Zod schemas for workspace terminal session API requests.
 */

import { z } from "zod";
import { ExecutionHostRefSchema } from "./execution-host";

export const TerminalConnectionModeSchema = z.enum(["dtach", "direct"]);

export const CreateTerminalSessionRequestSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  executionHost: ExecutionHostRefSchema.optional(),
  directory: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1, "name is required"),
  connectionMode: TerminalConnectionModeSchema.optional(),
  useTmux: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (Boolean(value.workspaceId) === Boolean(value.executionHost)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "exactly one of workspaceId or executionHost is required",
    });
  }
  if (value.executionHost && !value.directory) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "directory is required for execution-host terminal sessions",
      path: ["directory"],
    });
  }
});

export const UpdateTerminalSessionRequestSchema = z.object({
  name: z.string().trim().min(1, "name is required").optional(),
  isPrivate: z.boolean().optional(),
}).refine((value) => value.name !== undefined || value.isPrivate !== undefined, {
  message: "at least one field must be provided",
});
