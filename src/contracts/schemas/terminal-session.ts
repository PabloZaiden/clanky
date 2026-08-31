/**
 * Zod schemas for workspace terminal session API requests.
 */

import { z } from "zod";

export const TerminalConnectionModeSchema = z.enum(["dtach", "direct"]);

export const CreateTerminalSessionRequestSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  name: z.string().trim().min(1, "name is required"),
  connectionMode: TerminalConnectionModeSchema.optional(),
  useTmux: z.boolean().optional(),
});

export const UpdateTerminalSessionRequestSchema = z.object({
  name: z.string().trim().min(1, "name is required").optional(),
  isPrivate: z.boolean().optional(),
}).refine((value) => value.name !== undefined || value.isPrivate !== undefined, {
  message: "at least one field must be provided",
});
