/**
 * Zod schemas for workspace file explorer APIs.
 */

import { z } from "zod";

export const WorkspaceRelativePathSchema = z.string().trim();

export const ListWorkspaceFilesRequestSchema = z.object({
  path: WorkspaceRelativePathSchema.optional().default(""),
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
