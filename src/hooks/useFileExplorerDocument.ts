import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "@/shared";
import {
  WorkspaceFileConflictError,
  getFileExplorerFileMetadataApi,
  readFileExplorerFileApi,
  readFileExplorerImagePreviewApi,
} from "./workspaceFileActions";
import type { FileExplorerRequestScope } from "./file-explorer-request-scope";
import { isFileExplorerAbortError } from "./file-explorer-request-scope";
import type {
  UseFileExplorerTreeResult,
} from "./useFileExplorerTree";
import type { FileExplorerConflictController } from "./useFileExplorerConflicts";
import { getParentDirectory } from "./file-explorer-utils";
import {
  type WorkspaceFileConflictState,
  type WorkspaceLargeFileWarningState,
} from "./file-explorer-types";
import { isBrowserRenderableImage } from "../utils/workspace-file-images";

export const LARGE_FILE_WARNING_THRESHOLD_BYTES = 1 * 1024 * 1024;

export interface UseFileExplorerDocumentOptions {
  pollIntervalMs: number;
  savingFileRef: React.MutableRefObject<boolean>;
  conflicts: FileExplorerConflictController;
  onError: (requestError: unknown) => void;
  clearError: () => void;
}

export interface UseFileExplorerDocumentResult {
  currentFile: WorkspaceFileEntry | null;
  pendingFilePath: string | null;
  editorContent: string;
  imagePreviewUrl: string | null;
  savedContent: string;
  loadingFile: boolean;
  isDirty: boolean;
  conflictState: WorkspaceFileConflictState | null;
  largeFileWarning: WorkspaceLargeFileWarningState | null;
  autoReloadedAt: string | null;
  openFile: (path: string, options?: { allowLargeFile?: boolean }) => Promise<void>;
  openLargeFileInEditor: (path?: string) => Promise<boolean>;
  setEditorContent: (value: string) => void;
  refreshCurrentFile: (options?: { force?: boolean }) => Promise<boolean>;
  discardLocalChangesAndReload: () => Promise<boolean>;
  dismissConflict: () => void;
  checkForExternalChanges: () => Promise<void>;
  applySavedFile: (file: WorkspaceFileEntry, content: string) => void;
  clearCurrentFile: () => void;
  invalidateFileLoad: () => void;
}

export function useFileExplorerDocument(
  scope: FileExplorerRequestScope,
  tree: UseFileExplorerTreeResult,
  options: UseFileExplorerDocumentOptions,
): UseFileExplorerDocumentResult {
  const {
    pollIntervalMs,
    savingFileRef,
    conflicts,
    onError,
    clearError,
  } = options;
  const {
    conflictState,
    setConflictState,
    dismissConflict: dismissConflictState,
  } = conflicts;
  const [currentFile, setCurrentFile] = useState<WorkspaceFileEntry | null>(null);
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  const [editorContent, setEditorContentState] = useState("");
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState("");
  const [largeFileWarning, setLargeFileWarning] = useState<WorkspaceLargeFileWarningState | null>(null);
  const [autoReloadedAt, setAutoReloadedAt] = useState<string | null>(null);
  const fileLoadAbortControllerRef = useRef<AbortController | null>(null);
  const fileLoadRequestIdRef = useRef(0);
  const currentFileRef = useRef<WorkspaceFileEntry | null>(currentFile);
  const isDirtyRef = useRef(false);
  const largeFileWarningRef = useRef<WorkspaceLargeFileWarningState | null>(largeFileWarning);
  const imagePreviewUrlRef = useRef<string | null>(imagePreviewUrl);
  const stateTargetKeyRef = useRef(scope.targetKey);

  const isDirty = useMemo(() => editorContent !== savedContent, [editorContent, savedContent]);
  const loadingFile = pendingFilePath !== null;
  const hasCurrentTargetState = stateTargetKeyRef.current === scope.targetKey;

  currentFileRef.current = currentFile;
  isDirtyRef.current = isDirty;
  largeFileWarningRef.current = largeFileWarning;
  imagePreviewUrlRef.current = imagePreviewUrl;

  const invalidateFileLoad = useCallback(() => {
    fileLoadAbortControllerRef.current?.abort();
    fileLoadAbortControllerRef.current = null;
    fileLoadRequestIdRef.current += 1;
  }, []);

  const replaceImagePreviewUrl = useCallback((nextUrl: string | null) => {
    if (imagePreviewUrlRef.current) {
      URL.revokeObjectURL(imagePreviewUrlRef.current);
    }
    imagePreviewUrlRef.current = nextUrl;
    if (scope.isCurrent()) {
      setImagePreviewUrl(nextUrl);
    }
  }, [scope]);

  const openFile = useCallback(async (
    path: string,
    openOptions?: { allowLargeFile?: boolean },
  ) => {
    invalidateFileLoad();
    const localRequestId = fileLoadRequestIdRef.current;
    const abortController = new AbortController();
    const operation = scope.createOperation(abortController.signal);
    fileLoadAbortControllerRef.current = abortController;

    try {
      if (!operation.isCurrent()) {
        return;
      }
      setPendingFilePath(path);
      clearError();
      dismissConflictState();
      setLargeFileWarning(null);
      await tree.ensureFilePathVisible(path, operation);
      if (!operation.isCurrent() || fileLoadRequestIdRef.current !== localRequestId) {
        return;
      }

      if (!isBrowserRenderableImage(path)) {
        replaceImagePreviewUrl(null);
        const metadataResponse = await getFileExplorerFileMetadataApi(scope.target, path, {
          startDirectory: scope.target.startDirectory,
          signal: operation.signal,
        });
        if (!operation.isCurrent() || fileLoadRequestIdRef.current !== localRequestId) {
          return;
        }
        const metadata = metadataResponse.file;
        if (metadata.size > LARGE_FILE_WARNING_THRESHOLD_BYTES && !openOptions?.allowLargeFile) {
          tree.setCurrentDirectoryForOperation(getParentDirectory(metadata.path), operation.isCurrent);
          setCurrentFile(metadata);
          tree.selectNode(metadata);
          setEditorContentState("");
          setSavedContent("");
          setAutoReloadedAt(null);
          setLargeFileWarning({ file: metadata });
          return;
        }

        const response = await readFileExplorerFileApi(scope.target, path, {
          startDirectory: scope.target.startDirectory,
          signal: operation.signal,
        });
        if (!operation.isCurrent() || fileLoadRequestIdRef.current !== localRequestId) {
          return;
        }
        tree.setCurrentDirectoryForOperation(getParentDirectory(response.file.path), operation.isCurrent);
        setCurrentFile(response.file);
        tree.selectNode(response.file);
        setEditorContentState(response.content);
        setSavedContent(response.content);
        setAutoReloadedAt(null);
        setLargeFileWarning(null);
        return;
      }

      const metadataResponse = await getFileExplorerFileMetadataApi(scope.target, path, {
        startDirectory: scope.target.startDirectory,
        signal: operation.signal,
      });
      if (!operation.isCurrent() || fileLoadRequestIdRef.current !== localRequestId) {
        return;
      }
      const metadata = metadataResponse.file;
      const imageBlob = await readFileExplorerImagePreviewApi(scope.target, path, {
        startDirectory: scope.target.startDirectory,
        signal: operation.signal,
      });
      if (!operation.isCurrent() || fileLoadRequestIdRef.current !== localRequestId) {
        return;
      }
      tree.setCurrentDirectoryForOperation(getParentDirectory(metadata.path), operation.isCurrent);
      setCurrentFile(metadata);
      tree.selectNode(metadata);
      setAutoReloadedAt(null);
      setLargeFileWarning(null);
      replaceImagePreviewUrl(URL.createObjectURL(imageBlob));
      setEditorContentState("");
      setSavedContent("");
    } catch (requestError) {
      if (
        isFileExplorerAbortError(requestError)
        || !operation.isCurrent()
        || fileLoadRequestIdRef.current !== localRequestId
      ) {
        return;
      }
      replaceImagePreviewUrl(null);
      setCurrentFile(null);
      tree.clearSelectedFileState(operation.isCurrent);
      setEditorContentState("");
      setSavedContent("");
      dismissConflictState();
      setLargeFileWarning(null);
      onError(requestError);
    } finally {
      const isLatestRequest = fileLoadRequestIdRef.current === localRequestId;
      if (operation.isCurrent() && isLatestRequest && fileLoadAbortControllerRef.current === abortController) {
        fileLoadAbortControllerRef.current = null;
      }
      if (operation.isCurrent() && isLatestRequest) {
        setPendingFilePath(null);
      }
    }
  }, [
    clearError,
    dismissConflictState,
    invalidateFileLoad,
    onError,
    replaceImagePreviewUrl,
    scope,
    setConflictState,
    tree,
  ]);

  const openLargeFileInEditor = useCallback(async (path?: string) => {
    const warning = largeFileWarningRef.current;
    const pathToOpen = path ?? warning?.file.path;
    if (!pathToOpen || !scope.isCurrent()) {
      return false;
    }
    await openFile(pathToOpen, { allowLargeFile: true });
    return true;
  }, [openFile, scope]);

  const refreshCurrentFile = useCallback(async (refreshOptions?: { force?: boolean }) => {
    const activeFile = currentFileRef.current;
    if (!activeFile || !scope.isCurrent()) {
      return false;
    }

    if (isDirtyRef.current && !refreshOptions?.force) {
      setConflictState({
        kind: "reload_conflict",
        message: "This file has unsaved local changes. Reloading now would discard them.",
        currentFile: activeFile,
      });
      return false;
    }

    await openFile(activeFile.path, {
      allowLargeFile: activeFile.size > LARGE_FILE_WARNING_THRESHOLD_BYTES,
    });
    return true;
  }, [openFile, scope, setConflictState]);

  const setEditorContent = useCallback((value: string) => {
    if (scope.isCurrent()) {
      setEditorContentState(value);
    }
  }, [scope]);

  const checkForExternalChanges = useCallback(async () => {
    const activeFile = currentFileRef.current;
    if (
      !activeFile
      || loadingFile
      || savingFileRef.current
      || largeFileWarningRef.current
      || !hasCurrentTargetState
      || !scope.isCurrent()
    ) {
      return;
    }

    const localRequestId = fileLoadRequestIdRef.current;
    const operation = scope.createOperation();

    try {
      const response = await getFileExplorerFileMetadataApi(scope.target, activeFile.path, {
        startDirectory: scope.target.startDirectory,
        signal: operation.signal,
      });
      const latestCurrentFile = currentFileRef.current;
      if (
        !operation.isCurrent()
        || fileLoadRequestIdRef.current !== localRequestId
        || latestCurrentFile?.path !== activeFile.path
        || latestCurrentFile.versionToken !== activeFile.versionToken
      ) {
        return;
      }

      const metadata = response.file;
      if (metadata.versionToken === latestCurrentFile.versionToken) {
        return;
      }

      if (metadata.isImage) {
        const imageBlob = await readFileExplorerImagePreviewApi(scope.target, activeFile.path, {
          startDirectory: scope.target.startDirectory,
          signal: operation.signal,
        });
        const latestFileBeforeApply = currentFileRef.current;
        if (
          !operation.isCurrent()
          || fileLoadRequestIdRef.current !== localRequestId
          || latestFileBeforeApply?.path !== activeFile.path
          || latestFileBeforeApply.versionToken !== activeFile.versionToken
        ) {
          return;
        }

        setCurrentFile(metadata);
        replaceImagePreviewUrl(URL.createObjectURL(imageBlob));
        setEditorContentState("");
        setSavedContent("");
        tree.updateDirectoryEntry(metadata, operation.isCurrent);
        setAutoReloadedAt(new Date().toISOString());
        return;
      }

      if (isDirtyRef.current) {
        setConflictState({
          kind: "reload_conflict",
          message: "This file changed outside the code explorer while you have unsaved changes.",
          currentFile: metadata,
        });
        return;
      }

      const readResponse = await readFileExplorerFileApi(scope.target, activeFile.path, {
        startDirectory: scope.target.startDirectory,
        signal: operation.signal,
      });
      const latestFileBeforeApply = currentFileRef.current;
      if (
        !operation.isCurrent()
        || fileLoadRequestIdRef.current !== localRequestId
        || latestFileBeforeApply?.path !== activeFile.path
        || latestFileBeforeApply.versionToken !== activeFile.versionToken
        || isDirtyRef.current
      ) {
        return;
      }

      setCurrentFile(readResponse.file);
      replaceImagePreviewUrl(null);
      setEditorContentState(readResponse.content);
      setSavedContent(readResponse.content);
      tree.updateDirectoryEntry(readResponse.file, operation.isCurrent);
      setAutoReloadedAt(new Date().toISOString());
    } catch (requestError) {
      if (
        isFileExplorerAbortError(requestError)
        || !operation.isCurrent()
        || fileLoadRequestIdRef.current !== localRequestId
      ) {
        return;
      }
      if (requestError instanceof WorkspaceFileConflictError) {
        setConflictState({
          kind: "reload_conflict",
          message: requestError.message,
          currentFile: requestError.currentFile,
        });
        return;
      }
      onError(requestError);
    }
  }, [
    setConflictState,
    loadingFile,
    onError,
    replaceImagePreviewUrl,
    savingFileRef,
    scope,
    tree,
  ]);

  const applySavedFile = useCallback((file: WorkspaceFileEntry, content: string) => {
    if (!scope.isCurrent()) {
      return;
    }
    setCurrentFile(file);
    setSavedContent(content);
    tree.updateDirectoryEntry(file);
  }, [scope, tree]);

  const clearCurrentFile = useCallback(() => {
    if (!scope.isCurrent()) {
      return;
    }
    invalidateFileLoad();
    setCurrentFile(null);
    tree.clearSelectedFileState();
    replaceImagePreviewUrl(null);
    setEditorContentState("");
    setSavedContent("");
    setLargeFileWarning(null);
    setAutoReloadedAt(null);
    dismissConflictState();
  }, [dismissConflictState, invalidateFileLoad, replaceImagePreviewUrl, scope, tree]);

  const dismissConflict = useCallback(() => {
    if (scope.isCurrent()) {
      dismissConflictState();
    }
  }, [dismissConflictState, scope]);

  useEffect(() => {
    stateTargetKeyRef.current = scope.targetKey;
    invalidateFileLoad();
    setCurrentFile(null);
    setPendingFilePath(null);
    setEditorContentState("");
    replaceImagePreviewUrl(null);
    setSavedContent("");
    dismissConflictState();
    setLargeFileWarning(null);
    setAutoReloadedAt(null);
  }, [dismissConflictState, invalidateFileLoad, replaceImagePreviewUrl, scope]);

  useEffect(() => {
    return () => {
      invalidateFileLoad();
      if (imagePreviewUrlRef.current) {
        URL.revokeObjectURL(imagePreviewUrlRef.current);
        imagePreviewUrlRef.current = null;
      }
    };
  }, [invalidateFileLoad]);

  useEffect(() => {
    if (pollIntervalMs <= 0 || !currentFile || !hasCurrentTargetState || !scope.isCurrent()) {
      return;
    }
    const pollTimer = window.setInterval(() => {
      void checkForExternalChanges();
    }, pollIntervalMs);
    return () => {
      window.clearInterval(pollTimer);
    };
  }, [checkForExternalChanges, currentFile, hasCurrentTargetState, pollIntervalMs, scope]);

  return {
    currentFile: hasCurrentTargetState ? currentFile : null,
    pendingFilePath: hasCurrentTargetState ? pendingFilePath : null,
    editorContent: hasCurrentTargetState ? editorContent : "",
    imagePreviewUrl: hasCurrentTargetState ? imagePreviewUrl : null,
    savedContent: hasCurrentTargetState ? savedContent : "",
    loadingFile: hasCurrentTargetState && loadingFile,
    isDirty: hasCurrentTargetState && isDirty,
    conflictState,
    largeFileWarning: hasCurrentTargetState ? largeFileWarning : null,
    autoReloadedAt: hasCurrentTargetState ? autoReloadedAt : null,
    openFile,
    openLargeFileInEditor,
    setEditorContent,
    refreshCurrentFile,
    discardLocalChangesAndReload: async () => {
      dismissConflict();
      return await refreshCurrentFile({ force: true });
    },
    dismissConflict,
    checkForExternalChanges,
    applySavedFile,
    clearCurrentFile,
    invalidateFileLoad,
  };
}
