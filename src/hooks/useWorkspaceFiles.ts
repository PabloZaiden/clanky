/**
 * Hook for managing file explorer state for workspace and server targets.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileEntry } from "../types";
import {
  type FileExplorerCredentialErrorCode,
  type FileExplorerTarget,
  WorkspaceFileConflictError,
  getFileExplorerFileMetadataApi,
  loadFileExplorerTreeApi,
  listFileExplorerFilesApi,
  readFileExplorerFileApi,
  writeFileExplorerFileApi,
} from "./workspaceFileActions";

export interface WorkspaceFileConflictState {
  kind: "save_conflict" | "reload_conflict";
  message: string;
  currentFile: WorkspaceFileEntry | null;
}

export interface UseFileExplorerResult {
  directoryEntries: Record<string, WorkspaceFileEntry[]>;
  expandedDirectories: string[];
  currentDirectory: string;
  currentFile: WorkspaceFileEntry | null;
  pendingFilePath: string | null;
  showHiddenFiles: boolean;
  editorContent: string;
  savedContent: string;
  loadingTree: boolean;
  loadingFile: boolean;
  savingFile: boolean;
  error: string | null;
  errorCode: FileExplorerCredentialErrorCode | null;
  isDirty: boolean;
  conflictState: WorkspaceFileConflictState | null;
  autoReloadedAt: string | null;
  refreshTree: (path?: string) => Promise<void>;
  toggleShowHiddenFiles: () => Promise<void>;
  toggleDirectory: (path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
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

function upsertDirectoryEntry(
  directoryEntries: Record<string, WorkspaceFileEntry[]>,
  entry: WorkspaceFileEntry,
): Record<string, WorkspaceFileEntry[]> {
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

function getRequestErrorMessage(requestError: unknown): string {
  return requestError instanceof Error ? requestError.message : String(requestError);
}

function canFallbackFromFullTreeError(requestError: unknown): boolean {
  const message = getRequestErrorMessage(requestError);
  return message.includes("File tree is too large to load at once")
    || message.includes("Loading the full file tree took too long");
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
  const [directoryEntries, setDirectoryEntries] = useState<Record<string, WorkspaceFileEntry[]>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<string[]>([]);
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [currentFile, setCurrentFile] = useState<WorkspaceFileEntry | null>(null);
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  const [showHiddenFiles, setShowHiddenFiles] = useState(true);
  const [editorContent, setEditorContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loadingTree, setLoadingTree] = useState(true);
  const [savingFile, setSavingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<FileExplorerCredentialErrorCode | null>(null);
  const [conflictState, setConflictState] = useState<WorkspaceFileConflictState | null>(null);
  const [autoReloadedAt, setAutoReloadedAt] = useState<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const fileLoadAbortControllerRef = useRef<AbortController | null>(null);
  const fileLoadRequestIdRef = useRef(0);

  const isDirty = useMemo(() => editorContent !== savedContent, [editorContent, savedContent]);
  const loadingFile = pendingFilePath !== null;
  const currentFileRef = useRef<WorkspaceFileEntry | null>(currentFile);
  const isDirtyRef = useRef(isDirty);

  currentFileRef.current = currentFile;
  isDirtyRef.current = isDirty;

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
    response: { entries: WorkspaceFileEntry[] },
  ) => {
    setDirectoryEntries((currentEntries) => ({
      ...currentEntries,
      [path]: response.entries,
    }));
    setExpandedDirectories((currentPaths) => {
      if (!path || currentPaths.includes(path)) {
        return currentPaths;
      }
      return [...currentPaths, path];
    });
  }, []);

  const fallbackToDirectoryListing = useCallback(async (path: string, requestError: unknown) => {
    const response = await loadDirectory(path);
    setEffectiveLoadFullTree(false);
    applyDirectoryResponse(path, response);
    setError(`${getRequestErrorMessage(requestError)} Showing the current directory instead.`);
    setErrorCode(null);
  }, [applyDirectoryResponse, loadDirectory]);

  const refreshTree = useCallback(async (path = "") => {
    try {
      setLoadingTree(true);
      setError(null);
      setErrorCode(null);
      if (effectiveLoadFullTree) {
        try {
          const response = await loadTree();
          setDirectoryEntries(response.entriesByDirectory);
          return;
        } catch (requestError) {
          if (!canFallbackFromFullTreeError(requestError)) {
            throw requestError;
          }
          await fallbackToDirectoryListing(path, requestError);
          return;
        }
      }
      const response = await loadDirectory(path);
      applyDirectoryResponse(path, response);
    } catch (requestError) {
      applyErrorState(requestError);
    } finally {
      setLoadingTree(false);
    }
  }, [applyDirectoryResponse, applyErrorState, effectiveLoadFullTree, fallbackToDirectoryListing, loadDirectory, loadTree]);

  const toggleShowHiddenFiles = useCallback(async () => {
    setShowHiddenFiles((currentValue) => !currentValue);
  }, []);

  const invalidateFileLoad = useCallback(() => {
    fileLoadAbortControllerRef.current?.abort();
    fileLoadAbortControllerRef.current = null;
    fileLoadRequestIdRef.current += 1;
  }, []);

  const openFile = useCallback(async (path: string) => {
    invalidateFileLoad();
    const requestId = fileLoadRequestIdRef.current;
    const abortController = new AbortController();
    fileLoadAbortControllerRef.current = abortController;

    try {
      setPendingFilePath(path);
      setError(null);
      setErrorCode(null);
      setConflictState(null);
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
    } catch (requestError) {
      if (isAbortError(requestError) || abortController.signal.aborted || fileLoadRequestIdRef.current !== requestId) {
        return;
      }
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
  }, [applyErrorState, invalidateFileLoad, startDirectory, targetId, targetType]);

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

    await openFile(currentFile.path);
    return true;
  }, [currentFile, isDirty, openFile]);

  const saveCurrentFile = useCallback(async (options?: { overwrite?: boolean }) => {
    if (!currentFile) {
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
        overwrite: options?.overwrite,
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
    if (!activeFile || loadingFile || savingFile) {
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

      if (isDirtyRef.current) {
        setConflictState({
          kind: "reload_conflict",
          message: "This file changed outside the editor while you have unsaved changes.",
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
  }, [applyErrorState, loadingFile, savingFile, startDirectory, targetId, targetType]);

  const toggleDirectory = useCallback(async (path: string) => {
    const isExpanded = expandedDirectories.includes(path);
    if (isExpanded) {
      setExpandedDirectories((currentPaths) => currentPaths.filter((currentPath) => currentPath !== path));
      return;
    }

    setExpandedDirectories((currentPaths) => [...currentPaths, path]);
    if (!effectiveLoadFullTree && !directoryEntries[path]) {
      await refreshTree(path);
    }
  }, [directoryEntries, effectiveLoadFullTree, expandedDirectories, refreshTree]);

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
    setSavedContent("");
    setConflictState(null);
    setAutoReloadedAt(null);
    setEffectiveLoadFullTree(loadFullTree);
    if (!enabled) {
      setLoadingTree(false);
      return;
    }
    if (loadFullTree) {
      void loadTree()
        .then((response) => {
          setDirectoryEntries(response.entriesByDirectory);
        })
        .catch(async (requestError) => {
          if (!canFallbackFromFullTreeError(requestError)) {
            applyErrorState(requestError);
            return;
          }
          try {
            await fallbackToDirectoryListing("", requestError);
          } catch (fallbackError) {
            applyErrorState(fallbackError);
          }
        })
        .finally(() => {
          setLoadingTree(false);
        });
      return;
    }

    void loadDirectory("")
      .then((response) => {
        applyDirectoryResponse("", response);
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
    fallbackToDirectoryListing,
    invalidateFileLoad,
    loadDirectory,
    loadFullTree,
    loadTree,
    startDirectory,
    targetId,
    targetType,
  ]);

  useEffect(() => {
    return () => {
      invalidateFileLoad();
    };
  }, [invalidateFileLoad]);

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
    savedContent,
    loadingTree,
    loadingFile,
    savingFile,
    error,
    errorCode,
    isDirty,
    conflictState,
    autoReloadedAt,
    refreshTree,
    toggleShowHiddenFiles,
    toggleDirectory,
    openFile,
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
