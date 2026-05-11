/**
 * Hook for managing file explorer state for workspace and server targets.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileEntry, WorkspaceFileNode } from "../types";
import {
  type FileExplorerCredentialErrorCode,
  type FileExplorerTarget,
  WorkspaceFileConflictError,
  getFileExplorerFileMetadataApi,
  loadFileExplorerTreeApi,
  listFileExplorerFilesApi,
  readFileExplorerFileApi,
  readFileExplorerImagePreviewApi,
  writeFileExplorerFileApi,
} from "./workspaceFileActions";
import { isBrowserRenderableImage } from "../utils/workspace-file-images";

export interface WorkspaceFileConflictState {
  kind: "save_conflict" | "reload_conflict";
  message: string;
  currentFile: WorkspaceFileEntry | null;
}

export interface WorkspaceLargeFileWarningState {
  file: WorkspaceFileEntry;
}

export const LARGE_FILE_WARNING_THRESHOLD_BYTES = 20 * 1024;

export interface UseFileExplorerResult {
  directoryEntries: Record<string, WorkspaceFileNode[]>;
  expandedDirectories: string[];
  currentDirectory: string;
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
  isDirty: boolean;
  conflictState: WorkspaceFileConflictState | null;
  largeFileWarning: WorkspaceLargeFileWarningState | null;
  autoReloadedAt: string | null;
  refreshTree: (path?: string) => Promise<void>;
  toggleShowHiddenFiles: () => Promise<void>;
  toggleDirectory: (path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
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

function getParentDirectory(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash >= 0 ? path.slice(0, lastSlash) : "";
}

function getAncestorDirectories(path: string): string[] {
  const directories: string[] = [];
  let currentDirectory = getParentDirectory(path);
  while (currentDirectory) {
    directories.unshift(currentDirectory);
    currentDirectory = getParentDirectory(currentDirectory);
  }
  return directories;
}

function upsertDirectoryEntry(
  directoryEntries: Record<string, WorkspaceFileNode[]>,
  entry: WorkspaceFileNode,
): Record<string, WorkspaceFileNode[]> {
  const parentDirectory = getParentDirectory(entry.path);
  const currentEntries = directoryEntries[parentDirectory] ?? [];
  const nextEntries = currentEntries.some((currentEntry) => currentEntry.path === entry.path)
    ? currentEntries.map((currentEntry) => currentEntry.path === entry.path ? entry : currentEntry)
    : [...currentEntries, entry];

  return {
    ...directoryEntries,
    [parentDirectory]: nextEntries.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    }),
  };
}

function getFileExplorerCredentialErrorCode(requestError: unknown): FileExplorerCredentialErrorCode | null {
  const errorCode = (requestError as { code?: unknown } | null)?.code;
  if (errorCode === "missing_ssh_credential") {
    return "missing_ssh_credential";
  }
  if (
    errorCode === "invalid_ssh_credential"
    || errorCode === "invalid_credential_token"
    || errorCode === "invalid_encrypted_credential"
  ) {
    return "invalid_ssh_credential";
  }
  return null;
}

function isAbortError(requestError: unknown): boolean {
  return requestError instanceof DOMException && requestError.name === "AbortError";
}

function findDirectoryNode(
  directoryEntries: Record<string, WorkspaceFileNode[]>,
  path: string,
): WorkspaceFileNode | null {
  const parentDirectory = getParentDirectory(path);
  return directoryEntries[parentDirectory]?.find((entry) => entry.path === path) ?? null;
}

function isWithinLazySubtree(path: string, lazySubtreeRoots: string[]): boolean {
  return lazySubtreeRoots.some((rootPath) => path === rootPath || path.startsWith(`${rootPath}/`));
}

function getExpandedDirectoriesForTreeResponse(
  expandedDirectories: string[],
  entriesByDirectory: Record<string, WorkspaceFileNode[]>,
): string[] {
  return expandedDirectories.filter((expandedPath) =>
    Object.prototype.hasOwnProperty.call(entriesByDirectory, expandedPath)
  );
}

export function useFileExplorer(
  target: FileExplorerTarget,
  options?: {
    enabled?: boolean;
    loadFullTree?: boolean;
    pollIntervalMs?: number;
  },
): UseFileExplorerResult {
  const targetType = target.type;
  const targetId = target.id;
  const startDirectory = target.startDirectory;
  const enabled = options?.enabled ?? true;
  const loadFullTree = options?.loadFullTree ?? true;
  const pollIntervalMs = options?.pollIntervalMs ?? 5000;
  const [effectiveLoadFullTree, setEffectiveLoadFullTree] = useState(loadFullTree);
  const [directoryEntries, setDirectoryEntries] = useState<Record<string, WorkspaceFileNode[]>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<string[]>([]);
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [currentFile, setCurrentFile] = useState<WorkspaceFileEntry | null>(null);
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  const [showHiddenFiles, setShowHiddenFiles] = useState(true);
  const [editorContent, setEditorContent] = useState("");
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState("");
  const [loadingTree, setLoadingTree] = useState(true);
  const [savingFile, setSavingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<FileExplorerCredentialErrorCode | null>(null);
  const [conflictState, setConflictState] = useState<WorkspaceFileConflictState | null>(null);
  const [largeFileWarning, setLargeFileWarning] = useState<WorkspaceLargeFileWarningState | null>(null);
  const [autoReloadedAt, setAutoReloadedAt] = useState<string | null>(null);
  const [lazySubtreeRoots, setLazySubtreeRoots] = useState<string[]>([]);
  const pollTimerRef = useRef<number | null>(null);
  const fileLoadAbortControllerRef = useRef<AbortController | null>(null);
  const fileLoadRequestIdRef = useRef(0);
  const directoryEntriesRef = useRef(directoryEntries);
  const imagePreviewUrlRef = useRef<string | null>(null);

  directoryEntriesRef.current = directoryEntries;

  const isDirty = useMemo(() => editorContent !== savedContent, [editorContent, savedContent]);
  const loadingFile = pendingFilePath !== null;
  const currentFileRef = useRef<WorkspaceFileEntry | null>(currentFile);
  const isDirtyRef = useRef(isDirty);
  const largeFileWarningRef = useRef<WorkspaceLargeFileWarningState | null>(largeFileWarning);

  currentFileRef.current = currentFile;
  isDirtyRef.current = isDirty;
  largeFileWarningRef.current = largeFileWarning;

  const applyErrorState = useCallback((requestError: unknown) => {
    setError(requestError instanceof Error ? requestError.message : String(requestError));
    setErrorCode(getFileExplorerCredentialErrorCode(requestError));
  }, []);

  const loadDirectory = useCallback(async (path: string) => {
    return await listFileExplorerFilesApi({ type: targetType, id: targetId }, path, { startDirectory });
  }, [startDirectory, targetId, targetType]);

  const loadTree = useCallback(async () => {
    return await loadFileExplorerTreeApi({ type: targetType, id: targetId }, { startDirectory });
  }, [startDirectory, targetId, targetType]);

  const applyDirectoryResponse = useCallback((
    path: string,
    response: { entries: WorkspaceFileNode[] },
    options?: { markAsLazySubtreeRoot?: boolean },
  ) => {
    setDirectoryEntries((currentEntries) => ({
      ...currentEntries,
      [path]: response.entries,
    }));
    if (options?.markAsLazySubtreeRoot) {
      setLazySubtreeRoots((currentPaths) => currentPaths.includes(path) ? currentPaths : [...currentPaths, path]);
    }
    setExpandedDirectories((currentPaths) => {
      if (!path || currentPaths.includes(path)) {
        return currentPaths;
      }
      return [...currentPaths, path];
    });
  }, []);

  const refreshTree = useCallback(async (path = "") => {
    try {
      setLoadingTree(true);
      setError(null);
      setErrorCode(null);
      const directoryNode = path ? findDirectoryNode(directoryEntries, path) : null;
      const shouldLoadDirectory = path.length > 0 && (
        !effectiveLoadFullTree
        || Boolean(directoryNode?.loadOnExpand)
        || isWithinLazySubtree(path, lazySubtreeRoots)
      );
      if (effectiveLoadFullTree && !shouldLoadDirectory) {
        const response = await loadTree();
        setDirectoryEntries(response.entriesByDirectory);
        setLazySubtreeRoots([]);
        setExpandedDirectories((currentPaths) =>
          getExpandedDirectoriesForTreeResponse(currentPaths, response.entriesByDirectory)
        );
        return;
      }
      const response = await loadDirectory(path);
      applyDirectoryResponse(path, response, {
        markAsLazySubtreeRoot: effectiveLoadFullTree && path.length > 0,
      });
    } catch (requestError) {
      applyErrorState(requestError);
    } finally {
      setLoadingTree(false);
    }
  }, [applyDirectoryResponse, applyErrorState, directoryEntries, effectiveLoadFullTree, lazySubtreeRoots, loadDirectory, loadTree]);

  const toggleShowHiddenFiles = useCallback(async () => {
    setShowHiddenFiles((currentValue) => !currentValue);
  }, []);

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
    setImagePreviewUrl(nextUrl);
  }, []);

  const ensureFilePathVisible = useCallback(async (path: string) => {
    const ancestorDirectories = getAncestorDirectories(path);
    if (ancestorDirectories.length === 0) {
      return;
    }

    setExpandedDirectories((currentPaths) => {
      const nextPaths = [...currentPaths];
      for (const directory of ancestorDirectories) {
        if (!nextPaths.includes(directory)) {
          nextPaths.push(directory);
        }
      }
      return nextPaths;
    });

    if (effectiveLoadFullTree) {
      return;
    }

    for (const directory of ancestorDirectories) {
      if (directoryEntriesRef.current[directory] !== undefined) {
        continue;
      }
      const response = await loadDirectory(directory);
      applyDirectoryResponse(directory, response, {
        markAsLazySubtreeRoot: false,
      });
    }
  }, [applyDirectoryResponse, effectiveLoadFullTree, loadDirectory]);

  const openFile = useCallback(async (path: string, options?: { allowLargeFile?: boolean }) => {
    invalidateFileLoad();
    const requestId = fileLoadRequestIdRef.current;
    const abortController = new AbortController();
    fileLoadAbortControllerRef.current = abortController;

    try {
      setPendingFilePath(path);
      setError(null);
      setErrorCode(null);
      setConflictState(null);
      setLargeFileWarning(null);
      await ensureFilePathVisible(path);
      if (!isBrowserRenderableImage(path)) {
        replaceImagePreviewUrl(null);
        const metadataResponse = await getFileExplorerFileMetadataApi({ type: targetType, id: targetId }, path, {
          startDirectory,
          signal: abortController.signal,
        });
        if (abortController.signal.aborted || fileLoadRequestIdRef.current !== requestId) {
          return;
        }
        const metadata = metadataResponse.file;
        if (metadata.size > LARGE_FILE_WARNING_THRESHOLD_BYTES && !options?.allowLargeFile) {
          setCurrentDirectory(getParentDirectory(metadata.path));
          setCurrentFile(metadata);
          setEditorContent("");
          setSavedContent("");
          setAutoReloadedAt(null);
          setLargeFileWarning({ file: metadata });
          return;
        }

        const response = await readFileExplorerFileApi({ type: targetType, id: targetId }, path, {
          startDirectory,
          signal: abortController.signal,
        });
        if (abortController.signal.aborted || fileLoadRequestIdRef.current !== requestId) {
          return;
        }
        setCurrentDirectory(getParentDirectory(response.file.path));
        setCurrentFile(response.file);
        setEditorContent(response.content);
        setSavedContent(response.content);
        setAutoReloadedAt(null);
        setLargeFileWarning(null);
        return;
      }

      const metadataResponse = await getFileExplorerFileMetadataApi({ type: targetType, id: targetId }, path, {
        startDirectory,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted || fileLoadRequestIdRef.current !== requestId) {
        return;
      }
      const metadata = metadataResponse.file;

      const imageBlob = await readFileExplorerImagePreviewApi({ type: targetType, id: targetId }, path, {
        startDirectory,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted || fileLoadRequestIdRef.current !== requestId) {
        return;
      }
      setCurrentDirectory(getParentDirectory(metadata.path));
      setCurrentFile(metadata);
      setAutoReloadedAt(null);
      setLargeFileWarning(null);
      replaceImagePreviewUrl(URL.createObjectURL(imageBlob));
      setEditorContent("");
      setSavedContent("");
    } catch (requestError) {
      if (isAbortError(requestError) || abortController.signal.aborted || fileLoadRequestIdRef.current !== requestId) {
        return;
      }
      replaceImagePreviewUrl(null);
      setCurrentFile(null);
      setEditorContent("");
      setSavedContent("");
      setConflictState(null);
      setLargeFileWarning(null);
      applyErrorState(requestError);
    } finally {
      const isLatestRequest = fileLoadRequestIdRef.current === requestId;
      const isActiveRequest = !abortController.signal.aborted;

      if (isActiveRequest && isLatestRequest && fileLoadAbortControllerRef.current === abortController) {
        fileLoadAbortControllerRef.current = null;
      }
      if (isActiveRequest && isLatestRequest) {
        setPendingFilePath(null);
      }
    }
  }, [applyErrorState, ensureFilePathVisible, invalidateFileLoad, replaceImagePreviewUrl, startDirectory, targetId, targetType]);

  const openLargeFileInEditor = useCallback(async (path?: string) => {
    const warning = largeFileWarningRef.current;
    const pathToOpen = path ?? warning?.file.path;
    if (!pathToOpen) {
      return false;
    }

    await openFile(pathToOpen, { allowLargeFile: true });
    return true;
  }, [openFile]);

  const refreshCurrentFile = useCallback(async (options?: { force?: boolean }) => {
    if (!currentFile) {
      return false;
    }

    if (isDirty && !options?.force) {
      setConflictState({
        kind: "reload_conflict",
        message: "This file has unsaved local changes. Reloading now would discard them.",
        currentFile,
      });
      return false;
    }

    await openFile(currentFile.path, {
      allowLargeFile: currentFile.size > LARGE_FILE_WARNING_THRESHOLD_BYTES,
    });
    return true;
  }, [currentFile, isDirty, openFile]);

  const saveCurrentFile = useCallback(async (options?: { overwrite?: boolean }) => {
    if (!currentFile) {
      return false;
    }
    if (currentFile.isImage) {
      return false;
    }

    try {
      setSavingFile(true);
      setError(null);
      setErrorCode(null);
      setConflictState(null);
      const response = await writeFileExplorerFileApi({ type: targetType, id: targetId }, {
        path: currentFile.path,
        content: editorContent,
        expectedVersionToken: currentFile.versionToken,
        overwrite: options?.overwrite ?? false,
        startDirectory: startDirectory ?? null,
      }, { startDirectory });
      setCurrentFile(response.file);
      setSavedContent(editorContent);
      setDirectoryEntries((currentEntries) => upsertDirectoryEntry(currentEntries, response.file));
      return true;
    } catch (requestError) {
      if (requestError instanceof WorkspaceFileConflictError) {
        setConflictState({
          kind: "save_conflict",
          message: requestError.message,
          currentFile: requestError.currentFile,
        });
        return false;
      }
      applyErrorState(requestError);
      return false;
    } finally {
      setSavingFile(false);
    }
  }, [applyErrorState, currentFile, editorContent, startDirectory, targetId, targetType]);

  const discardLocalChangesAndReload = useCallback(async () => {
    setConflictState(null);
    return await refreshCurrentFile({ force: true });
  }, [refreshCurrentFile]);

  const retrySaveWithOverwrite = useCallback(async () => {
    setConflictState(null);
    return await saveCurrentFile({ overwrite: true });
  }, [saveCurrentFile]);

  const checkForExternalChanges = useCallback(async () => {
    const activeFile = currentFileRef.current;
    if (!activeFile || loadingFile || savingFile || largeFileWarningRef.current) {
      return;
    }

    const pollRequestId = fileLoadRequestIdRef.current;

    try {
      const response = await getFileExplorerFileMetadataApi(
        { type: targetType, id: targetId },
        activeFile.path,
        { startDirectory },
      );
      const latestCurrentFile = currentFileRef.current;
      if (
        fileLoadRequestIdRef.current !== pollRequestId
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
        const imageBlob = await readFileExplorerImagePreviewApi(
          { type: targetType, id: targetId },
          activeFile.path,
          { startDirectory },
        );
        const latestFileBeforeApply = currentFileRef.current;
        if (
          fileLoadRequestIdRef.current !== pollRequestId
          || latestFileBeforeApply?.path !== activeFile.path
          || latestFileBeforeApply.versionToken !== activeFile.versionToken
        ) {
          return;
        }

        setCurrentFile(metadata);
        replaceImagePreviewUrl(URL.createObjectURL(imageBlob));
        setEditorContent("");
        setSavedContent("");
        setDirectoryEntries((currentEntries) => upsertDirectoryEntry(currentEntries, metadata));
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

      const readResponse = await readFileExplorerFileApi(
        { type: targetType, id: targetId },
        activeFile.path,
        { startDirectory },
      );
      const latestFileBeforeApply = currentFileRef.current;
      if (
        fileLoadRequestIdRef.current !== pollRequestId
        || latestFileBeforeApply?.path !== activeFile.path
        || latestFileBeforeApply.versionToken !== activeFile.versionToken
        || isDirtyRef.current
      ) {
        return;
      }

      setCurrentFile(readResponse.file);
      replaceImagePreviewUrl(null);
      setEditorContent(readResponse.content);
      setSavedContent(readResponse.content);
      setDirectoryEntries((currentEntries) => upsertDirectoryEntry(currentEntries, readResponse.file));
      setAutoReloadedAt(new Date().toISOString());
    } catch (requestError) {
      if (requestError instanceof WorkspaceFileConflictError) {
        setConflictState({
          kind: "reload_conflict",
          message: requestError.message,
          currentFile: requestError.currentFile,
        });
        return;
      }
      applyErrorState(requestError);
    }
  }, [applyErrorState, loadingFile, replaceImagePreviewUrl, savingFile, startDirectory, targetId, targetType]);

  const toggleDirectory = useCallback(async (path: string) => {
    const isExpanded = expandedDirectories.includes(path);
    if (isExpanded) {
      setExpandedDirectories((currentPaths) => currentPaths.filter((currentPath) => currentPath !== path));
      return;
    }

    setExpandedDirectories((currentPaths) => [...currentPaths, path]);
    const directoryNode = findDirectoryNode(directoryEntries, path);
    const shouldLoadDirectory = directoryEntries[path] === undefined && (
      !effectiveLoadFullTree
      || Boolean(directoryNode?.loadOnExpand)
      || isWithinLazySubtree(path, lazySubtreeRoots)
    );
    if (shouldLoadDirectory) {
      await refreshTree(path);
    }
  }, [directoryEntries, effectiveLoadFullTree, expandedDirectories, lazySubtreeRoots, refreshTree]);

  const dismissConflict = useCallback(() => {
    setConflictState(null);
  }, []);

  useEffect(() => {
    invalidateFileLoad();
    setLoadingTree(true);
    setError(null);
    setErrorCode(null);
    setDirectoryEntries({});
    setExpandedDirectories([]);
    setCurrentDirectory("");
    setCurrentFile(null);
    setPendingFilePath(null);
    setShowHiddenFiles(true);
    setEditorContent("");
    replaceImagePreviewUrl(null);
    setSavedContent("");
    setConflictState(null);
    setLargeFileWarning(null);
    setAutoReloadedAt(null);
    setLazySubtreeRoots([]);
    setEffectiveLoadFullTree(loadFullTree);
    if (!enabled) {
      setLoadingTree(false);
      return;
    }
    if (loadFullTree) {
      void loadTree()
        .then((response) => {
          setDirectoryEntries(response.entriesByDirectory);
          setLazySubtreeRoots([]);
        })
        .catch((requestError) => {
          applyErrorState(requestError);
        })
        .finally(() => {
          setLoadingTree(false);
        });
      return;
    }

    void loadDirectory("")
      .then((response) => {
        applyDirectoryResponse("", response);
        setLazySubtreeRoots([]);
      })
      .catch((requestError) => {
        applyErrorState(requestError);
      })
      .finally(() => {
        setLoadingTree(false);
      });
  }, [
    applyDirectoryResponse,
    applyErrorState,
    enabled,
    invalidateFileLoad,
    loadDirectory,
    loadFullTree,
    loadTree,
    replaceImagePreviewUrl,
    startDirectory,
    targetId,
    targetType,
  ]);

  useEffect(() => {
    return () => {
      invalidateFileLoad();
      replaceImagePreviewUrl(null);
    };
  }, [invalidateFileLoad, replaceImagePreviewUrl]);

  useEffect(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    if (!currentFile) {
      return;
    }

    pollTimerRef.current = window.setInterval(() => {
      void checkForExternalChanges();
    }, pollIntervalMs);

    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [checkForExternalChanges, currentFile, pollIntervalMs]);

  return {
    directoryEntries,
    expandedDirectories,
    currentDirectory,
    currentFile,
    pendingFilePath,
    showHiddenFiles,
    editorContent,
    imagePreviewUrl,
    savedContent,
    loadingTree,
    loadingFile,
    savingFile,
    error,
    errorCode,
    isDirty,
    conflictState,
    largeFileWarning,
    autoReloadedAt,
    refreshTree,
    toggleShowHiddenFiles,
    toggleDirectory,
    openFile,
    openLargeFileInEditor,
    setEditorContent,
    saveCurrentFile,
    refreshCurrentFile,
    discardLocalChangesAndReload,
    retrySaveWithOverwrite,
    dismissConflict,
    checkForExternalChanges,
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

export function useServerFiles(
  serverId: string,
  options?: {
    loadFullTree?: boolean;
    pollIntervalMs?: number;
  },
): UseFileExplorerResult {
  return useFileExplorer({ type: "server", id: serverId }, options);
}
