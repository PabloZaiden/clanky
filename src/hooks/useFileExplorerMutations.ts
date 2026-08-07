import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "@/shared";
import {
  WorkspaceFileConflictError,
  deleteFileExplorerNodeApi,
  renameFileExplorerNodeApi,
  uploadFileExplorerFileApi,
  writeFileExplorerFileApi,
} from "./workspaceFileActions";
import type { FileExplorerRequestScope } from "./file-explorer-request-scope";
import { isFileExplorerAbortError } from "./file-explorer-request-scope";
import type {
  FileExplorerOperationFailure,
} from "./file-explorer-types";
import type { UseFileExplorerTreeResult } from "./useFileExplorerTree";
import {
  LARGE_FILE_WARNING_THRESHOLD_BYTES,
  type UseFileExplorerDocumentResult,
} from "./useFileExplorerDocument";
import type { FileExplorerConflictController } from "./useFileExplorerConflicts";
import {
  getParentDirectory,
  isPathWithinOrEqual,
} from "./file-explorer-utils";

export interface UseFileExplorerMutationsOptions {
  conflicts: FileExplorerConflictController;
  onError: (requestError: unknown) => string;
  clearError: () => void;
}

export interface UseFileExplorerMutationsResult {
  savingFile: boolean;
  operationFailure: FileExplorerOperationFailure | null;
  uploadProgress: { bytesUploaded: number; totalBytes: number } | null;
  renameSelectedNode: (
    newName: string,
    options?: { overwrite?: boolean },
  ) => Promise<WorkspaceFileEntry | null>;
  deleteSelectedNode: () => Promise<boolean>;
  uploadFileToSelectedDirectory: (
    file: File,
    options?: { overwrite?: boolean; signal?: AbortSignal },
  ) => Promise<WorkspaceFileEntry | null>;
  saveCurrentFile: (options?: { overwrite?: boolean }) => Promise<boolean>;
  retrySaveWithOverwrite: () => Promise<boolean>;
}

export function useFileExplorerMutations(
  scope: FileExplorerRequestScope,
  tree: UseFileExplorerTreeResult,
  document: UseFileExplorerDocumentResult,
  savingFileRef: React.MutableRefObject<boolean>,
  options: UseFileExplorerMutationsOptions,
): UseFileExplorerMutationsResult {
  const {
    conflicts,
    onError,
    clearError,
  } = options;
  const [savingFile, setSavingFile] = useState(false);
  const [operationFailure, setOperationFailure] = useState<FileExplorerOperationFailure | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    bytesUploaded: number;
    totalBytes: number;
  } | null>(null);
  const mutationRequestIdRef = useRef(0);
  const stateTargetKeyRef = useRef(scope.targetKey);
  const hasCurrentTargetState = stateTargetKeyRef.current === scope.targetKey;

  const beginMutation = useCallback((): number | null => {
    if (!scope.isCurrent()) {
      return null;
    }
    const requestId = mutationRequestIdRef.current + 1;
    mutationRequestIdRef.current = requestId;
    return requestId;
  }, [scope]);

  const isCurrentMutation = useCallback((
    requestId: number,
    operation?: { isCurrent: () => boolean },
  ): boolean => {
    return scope.isCurrent()
      && mutationRequestIdRef.current === requestId
      && (operation?.isCurrent() ?? true);
  }, [scope]);

  const saveCurrentFile = useCallback(async (saveOptions?: { overwrite?: boolean }) => {
    const activeFile = document.currentFile;
    if (!activeFile || activeFile.isImage || !scope.isCurrent()) {
      return false;
    }
    const requestId = beginMutation();
    if (requestId === null) {
      return false;
    }

    setOperationFailure(null);
    clearError();
    conflicts.dismissConflict();
    savingFileRef.current = true;
    setSavingFile(true);
    const operation = scope.createOperation();

    try {
      const response = await writeFileExplorerFileApi(scope.target, {
        path: activeFile.path,
        content: document.editorContent,
        expectedVersionToken: activeFile.versionToken,
        overwrite: saveOptions?.overwrite ?? false,
        startDirectory: scope.target.startDirectory ?? null,
      }, {
        startDirectory: scope.target.startDirectory,
        signal: operation.signal,
      });
      if (!isCurrentMutation(requestId, operation)) {
        return false;
      }
      document.applySavedFile(response.file, document.editorContent);
      return true;
    } catch (requestError) {
      if (!isCurrentMutation(requestId, operation) || isFileExplorerAbortError(requestError)) {
        return false;
      }
      if (requestError instanceof WorkspaceFileConflictError) {
        setOperationFailure({
          operation: "save",
          message: requestError.message,
          conflict: true,
        });
        conflicts.setConflictState({
          kind: "save_conflict",
          message: requestError.message,
          currentFile: requestError.currentFile,
        });
        return false;
      }
      const message = onError(requestError);
      setOperationFailure({
        operation: "save",
        message,
        conflict: false,
      });
      return false;
    } finally {
      if (isCurrentMutation(requestId, operation)) {
        savingFileRef.current = false;
        setSavingFile(false);
      }
    }
  }, [
    beginMutation,
    conflicts,
    document,
    isCurrentMutation,
    clearError,
    onError,
    savingFileRef,
    scope,
  ]);

  const renameSelectedNode = useCallback(async (
    newName: string,
    renameOptions?: { overwrite?: boolean },
  ) => {
    const selectedNode = tree.selectedNode;
    if (!selectedNode || !scope.isCurrent()) {
      return null;
    }
    const requestId = beginMutation();
    if (requestId === null) {
      return null;
    }

    setOperationFailure(null);
    clearError();
    const operation = scope.createOperation();

    try {
      const response = await renameFileExplorerNodeApi(scope.target, {
        path: selectedNode.path,
        newName,
        expectedVersionToken: document.currentFile?.path === selectedNode.path
          ? document.currentFile.versionToken
          : null,
        overwrite: renameOptions?.overwrite ?? false,
        startDirectory: scope.target.startDirectory ?? null,
      }, {
        startDirectory: scope.target.startDirectory,
        signal: operation.signal,
      });
      if (!isCurrentMutation(requestId, operation)) {
        return null;
      }
      tree.selectNode(response.file);
      await tree.refreshTree(getParentDirectory(response.file.path));
      if (!isCurrentMutation(requestId, operation)) {
        return null;
      }
      if (document.currentFile?.path === response.previousPath) {
        await document.openFile(response.file.path, {
          allowLargeFile: response.file.size > LARGE_FILE_WARNING_THRESHOLD_BYTES,
        });
      }
      return response.file;
    } catch (requestError) {
      if (!isCurrentMutation(requestId, operation) || isFileExplorerAbortError(requestError)) {
        return null;
      }
      const message = onError(requestError);
      setOperationFailure({
        operation: "rename",
        message,
        conflict: false,
      });
      return null;
    }
  }, [beginMutation, clearError, document, isCurrentMutation, onError, scope, tree]);

  const deleteSelectedNode = useCallback(async () => {
    const selectedNode = tree.selectedNode;
    if (!selectedNode || !scope.isCurrent()) {
      return false;
    }
    const requestId = beginMutation();
    if (requestId === null) {
      return false;
    }

    setOperationFailure(null);
    clearError();
    const operation = scope.createOperation();

    try {
      const response = await deleteFileExplorerNodeApi(scope.target, {
        path: selectedNode.path,
        kind: selectedNode.kind,
        expectedVersionToken: document.currentFile?.path === selectedNode.path
          ? document.currentFile.versionToken
          : null,
        startDirectory: scope.target.startDirectory ?? null,
      }, {
        startDirectory: scope.target.startDirectory,
        signal: operation.signal,
      });
      if (!isCurrentMutation(requestId, operation)) {
        return false;
      }
      const parentDirectory = getParentDirectory(response.deletedPath);
      tree.selectNode(null);
      if (
        document.currentFile
        && isPathWithinOrEqual(document.currentFile.path, response.deletedPath)
      ) {
        document.clearCurrentFile();
      }
      await tree.refreshTree(parentDirectory);
      return isCurrentMutation(requestId, operation);
    } catch (requestError) {
      if (!isCurrentMutation(requestId, operation) || isFileExplorerAbortError(requestError)) {
        return false;
      }
      const message = onError(requestError);
      setOperationFailure({
        operation: "delete",
        message,
        conflict: false,
      });
      return false;
    }
  }, [beginMutation, clearError, document, isCurrentMutation, onError, scope, tree]);

  const uploadFileToSelectedDirectory = useCallback(async (
    file: File,
    uploadOptions?: { overwrite?: boolean; signal?: AbortSignal },
  ) => {
    if (!scope.isCurrent()) {
      return null;
    }
    const requestId = beginMutation();
    if (requestId === null) {
      return null;
    }
    const targetDirectory = tree.selectedNode?.kind === "directory"
      ? tree.selectedNode.path
      : tree.currentDirectory;
    const operation = scope.createOperation(uploadOptions?.signal);

    setOperationFailure(null);
    clearError();
    setUploadProgress({ bytesUploaded: 0, totalBytes: file.size });
    try {
      const response = await uploadFileExplorerFileApi(
        scope.target,
        targetDirectory,
        file,
        {
          overwrite: uploadOptions?.overwrite ?? false,
          startDirectory: scope.target.startDirectory,
          signal: operation.signal,
          onProgress: (progress) => {
            if (isCurrentMutation(requestId, operation)) {
              setUploadProgress(progress);
            }
          },
        },
      );
      if (!isCurrentMutation(requestId, operation)) {
        return null;
      }
      tree.selectNode(response.file);
      await tree.refreshTree(targetDirectory);
      return isCurrentMutation(requestId, operation) ? response.file : null;
    } catch (requestError) {
      if (!isCurrentMutation(requestId, operation) || isFileExplorerAbortError(requestError)) {
        return null;
      }
      const message = onError(requestError);
      setOperationFailure({
        operation: "upload",
        message,
        conflict: false,
      });
      return null;
    } finally {
      if (isCurrentMutation(requestId, operation)) {
        setUploadProgress(null);
      }
    }
  }, [beginMutation, clearError, isCurrentMutation, onError, scope, tree]);

  const retrySaveWithOverwrite = useCallback(async () => {
    conflicts.dismissConflict();
    return await saveCurrentFile({ overwrite: true });
  }, [conflicts, saveCurrentFile]);

  useEffect(() => {
    stateTargetKeyRef.current = scope.targetKey;
    mutationRequestIdRef.current += 1;
    savingFileRef.current = false;
    setSavingFile(false);
    setOperationFailure(null);
    setUploadProgress(null);
  }, [savingFileRef, scope]);

  return {
    savingFile: hasCurrentTargetState ? savingFile : false,
    operationFailure: hasCurrentTargetState ? operationFailure : null,
    uploadProgress: hasCurrentTargetState ? uploadProgress : null,
    renameSelectedNode,
    deleteSelectedNode,
    uploadFileToSelectedDirectory,
    saveCurrentFile,
    retrySaveWithOverwrite,
  };
}
