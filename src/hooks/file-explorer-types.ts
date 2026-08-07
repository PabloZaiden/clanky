import type { WorkspaceFileEntry, WorkspaceFileNode } from "@/shared";
import type { FileExplorerCredentialErrorCode } from "./workspaceFileActions";

export interface WorkspaceFileConflictState {
  kind: "save_conflict" | "reload_conflict";
  message: string;
  currentFile: WorkspaceFileEntry | null;
}

export interface WorkspaceLargeFileWarningState {
  file: WorkspaceFileEntry;
}

export type FileExplorerOperation = "save" | "rename" | "delete" | "upload";

export interface FileExplorerOperationFailure {
  operation: FileExplorerOperation;
  message: string;
  conflict: boolean;
}

export interface UseFileExplorerResult {
  directoryEntries: Record<string, WorkspaceFileNode[]>;
  expandedDirectories: string[];
  currentDirectory: string;
  selectedNode: WorkspaceFileNode | null;
  currentFile: WorkspaceFileEntry | null;
  pendingFilePath: string | null;
  showHiddenFiles: boolean;
  editorContent: string;
  imagePreviewUrl: string | null;
  savedContent: string;
  loadingTree: boolean;
  loadingFile: boolean;
  savingFile: boolean;
  error: string | null;
  errorCode: FileExplorerCredentialErrorCode | null;
  operationFailure: FileExplorerOperationFailure | null;
  isDirty: boolean;
  conflictState: WorkspaceFileConflictState | null;
  largeFileWarning: WorkspaceLargeFileWarningState | null;
  autoReloadedAt: string | null;
  uploadProgress: { bytesUploaded: number; totalBytes: number } | null;
  refreshTree: (path?: string) => Promise<void>;
  toggleShowHiddenFiles: () => Promise<void>;
  toggleDirectory: (path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  selectNode: (node: WorkspaceFileNode | null) => void;
  renameSelectedNode: (newName: string, options?: { overwrite?: boolean }) => Promise<WorkspaceFileEntry | null>;
  deleteSelectedNode: () => Promise<boolean>;
  uploadFileToSelectedDirectory: (file: File, options?: { overwrite?: boolean; signal?: AbortSignal }) => Promise<WorkspaceFileEntry | null>;
  openLargeFileInEditor: (path?: string) => Promise<boolean>;
  setEditorContent: (value: string) => void;
  saveCurrentFile: (options?: { overwrite?: boolean }) => Promise<boolean>;
  refreshCurrentFile: (options?: { force?: boolean }) => Promise<boolean>;
  discardLocalChangesAndReload: () => Promise<boolean>;
  retrySaveWithOverwrite: () => Promise<boolean>;
  dismissConflict: () => void;
  checkForExternalChanges: () => Promise<void>;
}

export type UseWorkspaceFilesResult = UseFileExplorerResult;

