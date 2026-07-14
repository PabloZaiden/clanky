/**
 * Shared request schemas for workspace and standalone SSH-server file APIs.
 */

import { z } from "zod";

export const FileExplorerRelativePathSchema = z.string().trim();
export const FileExplorerStartDirectorySchema = z.string().trim();

export const ListFileExplorerRequestSchema = z.object({
  path: FileExplorerRelativePathSchema.optional().default(""),
  startDirectory: FileExplorerStartDirectorySchema.optional(),
});

export const GetFileExplorerTreeRequestSchema = z.object({
  startDirectory: FileExplorerStartDirectorySchema.optional(),
});

export const GetFileExplorerFileRequestSchema = z.object({
  path: FileExplorerRelativePathSchema.min(1, "path is required"),
  startDirectory: FileExplorerStartDirectorySchema.optional(),
});

export const WriteFileExplorerRequestSchema = z.object({
  path: FileExplorerRelativePathSchema.min(1, "path is required"),
  content: z.string(),
  expectedVersionToken: z.string().trim().nullable(),
  overwrite: z.boolean(),
  startDirectory: FileExplorerStartDirectorySchema.nullable(),
});

export const RenameFileExplorerRequestSchema = z.object({
  path: FileExplorerRelativePathSchema.min(1, "path is required"),
  newName: z.string().trim().min(1, "newName is required"),
  expectedVersionToken: z.string().trim().nullable().optional(),
  overwrite: z.boolean().optional().default(false),
  startDirectory: FileExplorerStartDirectorySchema.nullable().optional(),
});

export const DeleteFileExplorerRequestSchema = z.object({
  path: FileExplorerRelativePathSchema.min(1, "path is required"),
  kind: z.enum(["file", "directory"]),
  expectedVersionToken: z.string().trim().nullable().optional(),
  startDirectory: FileExplorerStartDirectorySchema.nullable().optional(),
});

export const CreateFileExplorerUploadRequestSchema = z.object({
  directory: FileExplorerRelativePathSchema.optional().default(""),
  fileName: z.string().trim().min(1, "fileName is required"),
  size: z.coerce.number().int().min(0),
  contentType: z.string().trim().optional(),
  lastModified: z.coerce.number().int().min(0).optional(),
  overwrite: z.boolean().optional().default(false),
  startDirectory: FileExplorerStartDirectorySchema.nullable().optional(),
});

export const UploadFileExplorerChunkRequestSchema = z.object({
  uploadId: z.string().trim().min(1, "uploadId is required"),
  offset: z.coerce.number().int().min(0),
  startDirectory: FileExplorerStartDirectorySchema.optional(),
});

export const CompleteFileExplorerUploadRequestSchema = z.object({
  uploadId: z.string().trim().min(1, "uploadId is required"),
  startDirectory: FileExplorerStartDirectorySchema.nullable().optional(),
});

export const CancelFileExplorerUploadRequestSchema = z.object({
  uploadId: z.string().trim().min(1, "uploadId is required"),
  startDirectory: FileExplorerStartDirectorySchema.nullable().optional(),
});
