/**
 * Workspace file explorer domain types.
 */

import type { z } from "zod";
import {
  GetWorkspaceFileRequestSchema,
  GetWorkspaceFileTreeRequestSchema,
  ListWorkspaceFilesRequestSchema,
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

export interface WorkspaceFileConflictResponse {
  error: "file_conflict";
  message: string;
  currentFile: WorkspaceFileEntry | null;
}

export type ListWorkspaceFilesRequest = z.input<typeof ListWorkspaceFilesRequestSchema>;
export type GetWorkspaceFileTreeRequest = z.input<typeof GetWorkspaceFileTreeRequestSchema>;
export type GetWorkspaceFileRequest = z.input<typeof GetWorkspaceFileRequestSchema>;
export type WriteWorkspaceFileRequest = z.input<typeof WriteWorkspaceFileRequestSchema>;
