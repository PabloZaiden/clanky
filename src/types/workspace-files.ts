/**
 * Workspace file explorer domain types.
 */

import type { z } from "zod";
import {
  CancelWorkspaceFileUploadRequestSchema,
  CompleteWorkspaceFileUploadRequestSchema,
  CreateWorkspaceFileUploadRequestSchema,
  DeleteWorkspaceFileRequestSchema,
  GetWorkspaceFileRequestSchema,
  GetWorkspaceFileTreeRequestSchema,
  ListWorkspaceFilesRequestSchema,
  RenameWorkspaceFileRequestSchema,
  UploadWorkspaceFileChunkRequestSchema,
  WriteWorkspaceFileRequestSchema,
} from "./schemas/workspace-files";

export type WorkspaceFileKind = "file" | "directory";

export interface WorkspaceFileNode {
  name: string;
  path: string;
  kind: WorkspaceFileKind;
  loadOnExpand?: boolean;
}

export interface WorkspaceFileEntry extends WorkspaceFileNode {
  absolutePath: string;
  size: number;
  modifiedAt: string;
  versionToken: string;
  mimeType?: string;
  isImage?: boolean;
}

export interface WorkspaceFileListResponse {
  workspaceId: string;
  directory: string;
  entries: WorkspaceFileNode[];
}

export interface WorkspaceFileTreeResponse {
  workspaceId: string;
  entriesByDirectory: Record<string, WorkspaceFileNode[]>;
}

export interface WorkspaceFileReadResponse {
  workspaceId: string;
  file: WorkspaceFileEntry;
  content: string;
}

export interface WorkspaceFileMetadataResponse {
  workspaceId: string;
  file: WorkspaceFileEntry;
}

export interface WorkspaceFileWriteResponse {
  success: true;
  workspaceId: string;
  file: WorkspaceFileEntry;
  overwritten: boolean;
}

export interface WorkspaceFileRenameResponse {
  success: true;
  workspaceId: string;
  file: WorkspaceFileEntry;
  previousPath: string;
  overwritten: boolean;
}

export interface WorkspaceFileDeleteResponse {
  success: true;
  workspaceId: string;
  deletedPath: string;
  kind: WorkspaceFileKind;
}

export interface WorkspaceFileUploadCreateResponse {
  workspaceId: string;
  uploadId: string;
  path: string;
  directory: string;
  fileName: string;
  size: number;
}

export interface WorkspaceFileUploadChunkResponse {
  success: true;
  workspaceId: string;
  uploadId: string;
  bytesWritten: number;
  nextOffset: number;
}

export interface WorkspaceFileUploadCompleteResponse {
  success: true;
  workspaceId: string;
  file: WorkspaceFileEntry;
  overwritten: boolean;
}

export interface WorkspaceFileUploadCancelResponse {
  success: true;
  workspaceId: string;
  uploadId: string;
}

export interface SshServerFileListResponse {
  serverId: string;
  directory: string;
  entries: WorkspaceFileNode[];
}

export interface SshServerFileTreeResponse {
  serverId: string;
  entriesByDirectory: Record<string, WorkspaceFileNode[]>;
}

export interface SshServerFileReadResponse {
  serverId: string;
  file: WorkspaceFileEntry;
  content: string;
}

export interface SshServerFileMetadataResponse {
  serverId: string;
  file: WorkspaceFileEntry;
}

export interface SshServerFileWriteResponse {
  success: true;
  serverId: string;
  file: WorkspaceFileEntry;
  overwritten: boolean;
}

export interface SshServerFileRenameResponse {
  success: true;
  serverId: string;
  file: WorkspaceFileEntry;
  previousPath: string;
  overwritten: boolean;
}

export interface SshServerFileDeleteResponse {
  success: true;
  serverId: string;
  deletedPath: string;
  kind: WorkspaceFileKind;
}

export interface SshServerFileUploadCreateResponse {
  serverId: string;
  uploadId: string;
  path: string;
  directory: string;
  fileName: string;
  size: number;
}

export interface SshServerFileUploadChunkResponse {
  success: true;
  serverId: string;
  uploadId: string;
  bytesWritten: number;
  nextOffset: number;
}

export interface SshServerFileUploadCompleteResponse {
  success: true;
  serverId: string;
  file: WorkspaceFileEntry;
  overwritten: boolean;
}

export interface SshServerFileUploadCancelResponse {
  success: true;
  serverId: string;
  uploadId: string;
}

export interface WorkspaceFileConflictResponse {
  error: "file_conflict";
  message: string;
  currentFile: WorkspaceFileEntry | null;
}

export type ListWorkspaceFilesRequest = z.input<typeof ListWorkspaceFilesRequestSchema>;
export type GetWorkspaceFileTreeRequest = z.input<typeof GetWorkspaceFileTreeRequestSchema>;
export type GetWorkspaceFileRequest = z.input<typeof GetWorkspaceFileRequestSchema>;
export type WriteWorkspaceFileRequest = z.input<typeof WriteWorkspaceFileRequestSchema>;
export type RenameWorkspaceFileRequest = z.input<typeof RenameWorkspaceFileRequestSchema>;
export type DeleteWorkspaceFileRequest = z.input<typeof DeleteWorkspaceFileRequestSchema>;
export type CreateWorkspaceFileUploadRequest = z.input<typeof CreateWorkspaceFileUploadRequestSchema>;
export type UploadWorkspaceFileChunkRequest = z.input<typeof UploadWorkspaceFileChunkRequestSchema>;
export type CompleteWorkspaceFileUploadRequest = z.input<typeof CompleteWorkspaceFileUploadRequestSchema>;
export type CancelWorkspaceFileUploadRequest = z.input<typeof CancelWorkspaceFileUploadRequestSchema>;
