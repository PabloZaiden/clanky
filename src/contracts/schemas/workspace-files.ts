/**
 * Zod schemas for workspace file explorer APIs.
 */

import { z } from "zod";

export const WorkspaceRelativePathSchema = z.string().trim();
export const WorkspaceStartDirectorySchema = z.string().trim();

export const ListWorkspaceFilesRequestSchema = z.object({
  path: WorkspaceRelativePathSchema.optional().default(""),
  startDirectory: WorkspaceStartDirectorySchema.optional(),
});

export const GetWorkspaceFileTreeRequestSchema = z.object({
  startDirectory: WorkspaceStartDirectorySchema.optional(),
});

export const GetWorkspaceFileRequestSchema = z.object({
  path: WorkspaceRelativePathSchema.min(1, "path is required"),
  startDirectory: WorkspaceStartDirectorySchema.optional(),
});

export const WriteWorkspaceFileRequestSchema = z.object({
  path: WorkspaceRelativePathSchema.min(1, "path is required"),
  content: z.string(),
  expectedVersionToken: z.string().trim().nullable(),
  overwrite: z.boolean(),
  startDirectory: WorkspaceStartDirectorySchema.nullable(),
});

export const RenameWorkspaceFileRequestSchema = z.object({
  path: WorkspaceRelativePathSchema.min(1, "path is required"),
  newName: z.string().trim().min(1, "newName is required"),
  expectedVersionToken: z.string().trim().nullable().optional(),
  overwrite: z.boolean().optional().default(false),
  startDirectory: WorkspaceStartDirectorySchema.nullable().optional(),
});

export const DeleteWorkspaceFileRequestSchema = z.object({
  path: WorkspaceRelativePathSchema.min(1, "path is required"),
  kind: z.enum(["file", "directory"]),
  expectedVersionToken: z.string().trim().nullable().optional(),
  startDirectory: WorkspaceStartDirectorySchema.nullable().optional(),
});

export const CreateWorkspaceFileUploadRequestSchema = z.object({
  directory: WorkspaceRelativePathSchema.optional().default(""),
  fileName: z.string().trim().min(1, "fileName is required"),
  size: z.coerce.number().int().min(0),
  contentType: z.string().trim().optional(),
  lastModified: z.coerce.number().int().min(0).optional(),
  overwrite: z.boolean().optional().default(false),
  startDirectory: WorkspaceStartDirectorySchema.nullable().optional(),
});

export const UploadWorkspaceFileChunkRequestSchema = z.object({
  uploadId: z.string().trim().min(1, "uploadId is required"),
  offset: z.coerce.number().int().min(0),
  startDirectory: WorkspaceStartDirectorySchema.optional(),
});

export const CompleteWorkspaceFileUploadRequestSchema = z.object({
  uploadId: z.string().trim().min(1, "uploadId is required"),
  startDirectory: WorkspaceStartDirectorySchema.nullable().optional(),
});

export const CancelWorkspaceFileUploadRequestSchema = z.object({
  uploadId: z.string().trim().min(1, "uploadId is required"),
  startDirectory: WorkspaceStartDirectorySchema.nullable().optional(),
});
