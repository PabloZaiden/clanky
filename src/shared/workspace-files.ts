/**
 * Workspace file explorer domain types.
 */

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
