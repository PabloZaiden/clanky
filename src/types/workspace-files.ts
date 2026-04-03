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

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: WorkspaceFileKind;
  size: number;
  modifiedAt: string;
  versionToken: string;
}

export interface WorkspaceFileListResponse {
  workspaceId: string;
  directory: string;
  entries: WorkspaceFileEntry[];
}

export interface WorkspaceFileTreeResponse {
  workspaceId: string;
  entriesByDirectory: Record<string, WorkspaceFileEntry[]>;
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
  entries: WorkspaceFileEntry[];
}

export interface SshServerFileTreeResponse {
  serverId: string;
  entriesByDirectory: Record<string, WorkspaceFileEntry[]>;
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
