/**
 * Workspace file explorer domain types.
 */

import type { z } from "zod";
import {
  GetWorkspaceFileRequestSchema,
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

export interface WorkspaceFileConflictResponse {
  error: "file_conflict";
  message: string;
  currentFile: WorkspaceFileEntry | null;
}

export type ListWorkspaceFilesRequest = z.input<typeof ListWorkspaceFilesRequestSchema>;
export type GetWorkspaceFileRequest = z.input<typeof GetWorkspaceFileRequestSchema>;
export type WriteWorkspaceFileRequest = z.input<typeof WriteWorkspaceFileRequestSchema>;
