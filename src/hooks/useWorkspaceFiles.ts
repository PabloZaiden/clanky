/**
 * Public file explorer hook facade.
 *
 * Target lifecycle, tree navigation, active documents, and mutations are
 * implemented by focused hooks and composed here for compatibility.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FileExplorerCredentialErrorCode, FileExplorerTarget } from "./workspaceFileActions";
import {
  getFileExplorerCredentialErrorCode,
} from "./file-explorer-utils";
import {
  useFileExplorerRequestScope,
} from "./file-explorer-request-scope";
import {
  useFileExplorerTree,
} from "./useFileExplorerTree";
import { useFileExplorerConflicts } from "./useFileExplorerConflicts";
import {
  useFileExplorerDocument,
} from "./useFileExplorerDocument";
import {
  useFileExplorerMutations,
} from "./useFileExplorerMutations";
import type {
  UseFileExplorerResult,
  UseWorkspaceFilesResult,
} from "./file-explorer-types";

export type {
  FileExplorerOperation,
  FileExplorerOperationFailure,
  UseFileExplorerResult,
  UseWorkspaceFilesResult,
  WorkspaceFileConflictState,
  WorkspaceLargeFileWarningState,
} from "./file-explorer-types";

export { LARGE_FILE_WARNING_THRESHOLD_BYTES } from "./useFileExplorerDocument";

export function useFileExplorer(
  target: FileExplorerTarget,
  options?: {
    enabled?: boolean;
    loadFullTree?: boolean;
    pollIntervalMs?: number;
  },
): UseFileExplorerResult {
  const enabled = options?.enabled ?? true;
  const loadFullTree = options?.loadFullTree ?? true;
  const pollIntervalMs = options?.pollIntervalMs ?? 5000;
  const lifecycleKey = JSON.stringify([enabled, loadFullTree]);
  const scope = useFileExplorerRequestScope(target, lifecycleKey);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<FileExplorerCredentialErrorCode | null>(null);
  const errorTargetKeyRef = useRef(scope.targetKey);
  const savingFileRef = useRef(false);
  const hasCurrentErrorState = errorTargetKeyRef.current === scope.targetKey;
  const conflicts = useFileExplorerConflicts(scope);

  const clearError = useCallback(() => {
    if (!scope.isCurrent()) {
      return;
    }
    setError(null);
    setErrorCode(null);
  }, [scope]);

  const applyErrorState = useCallback((requestError: unknown): string => {
    const message = requestError instanceof Error ? requestError.message : String(requestError);
    if (scope.isCurrent()) {
      setError(message);
      setErrorCode(getFileExplorerCredentialErrorCode(requestError));
    }
    return message;
  }, [scope]);

  const tree = useFileExplorerTree(scope, {
    enabled,
    loadFullTree,
    onError: applyErrorState,
    clearError,
  });
  const document = useFileExplorerDocument(scope, tree, {
    pollIntervalMs,
    savingFileRef,
    conflicts,
    onError: applyErrorState,
    clearError,
  });
  const mutations = useFileExplorerMutations(scope, tree, document, savingFileRef, {
    conflicts,
    onError: applyErrorState,
    clearError,
  });

  useEffect(() => {
    errorTargetKeyRef.current = scope.targetKey;
    setError(null);
    setErrorCode(null);
  }, [scope]);

  return {
    directoryEntries: tree.directoryEntries,
    expandedDirectories: tree.expandedDirectories,
    currentDirectory: tree.currentDirectory,
    selectedNode: tree.selectedNode,
    currentFile: document.currentFile,
    pendingFilePath: document.pendingFilePath,
    showHiddenFiles: tree.showHiddenFiles,
    editorContent: document.editorContent,
    imagePreviewUrl: document.imagePreviewUrl,
    savedContent: document.savedContent,
    loadingTree: tree.loadingTree,
    loadingFile: document.loadingFile,
    savingFile: mutations.savingFile,
    error: hasCurrentErrorState ? error : null,
    errorCode: hasCurrentErrorState ? errorCode : null,
    operationFailure: mutations.operationFailure,
    isDirty: document.isDirty,
    conflictState: conflicts.conflictState,
    largeFileWarning: document.largeFileWarning,
    autoReloadedAt: document.autoReloadedAt,
    uploadProgress: mutations.uploadProgress,
    refreshTree: tree.refreshTree,
    toggleShowHiddenFiles: tree.toggleShowHiddenFiles,
    toggleDirectory: tree.toggleDirectory,
    openFile: document.openFile,
    selectNode: tree.selectNode,
    renameSelectedNode: mutations.renameSelectedNode,
    deleteSelectedNode: mutations.deleteSelectedNode,
    uploadFileToSelectedDirectory: mutations.uploadFileToSelectedDirectory,
    openLargeFileInEditor: document.openLargeFileInEditor,
    setEditorContent: document.setEditorContent,
    saveCurrentFile: mutations.saveCurrentFile,
    refreshCurrentFile: document.refreshCurrentFile,
    discardLocalChangesAndReload: document.discardLocalChangesAndReload,
    retrySaveWithOverwrite: mutations.retrySaveWithOverwrite,
    dismissConflict: conflicts.dismissConflict,
    checkForExternalChanges: document.checkForExternalChanges,
  };
}

export function useWorkspaceFiles(
  workspaceId: string,
  options?: {
    loadFullTree?: boolean;
    pollIntervalMs?: number;
  },
): UseWorkspaceFilesResult {
  return useFileExplorer({ type: "workspace", id: workspaceId }, options);
}
