/**
 * Zod schemas for workspace file explorer APIs.
 */

import { z } from "zod";

export const WorkspaceRelativePathSchema = z.string().trim();
const WorkspaceFilesBooleanQuerySchema = z
  .union([z.literal("true"), z.literal("false"), z.boolean()])
  .transform((value) => value === true || value === "true");

export const ListWorkspaceFilesRequestSchema = z.object({
  path: WorkspaceRelativePathSchema.optional().default(""),
  showHidden: WorkspaceFilesBooleanQuerySchema.optional().default(false),
});

export const GetWorkspaceFileRequestSchema = z.object({
  path: WorkspaceRelativePathSchema.min(1, "path is required"),
});

export const WriteWorkspaceFileRequestSchema = z.object({
  path: WorkspaceRelativePathSchema.min(1, "path is required"),
  content: z.string(),
  expectedVersionToken: z.string().trim().nullable().optional(),
  overwrite: z.boolean().optional().default(false),
});
