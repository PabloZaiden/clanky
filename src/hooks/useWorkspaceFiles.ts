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

export function useFileExplorer(
  target: FileExplorerTarget,
  options?: {
    enabled?: boolean;
    pollIntervalMs?: number;
  },
): UseFileExplorerResult {
  const targetType = target.type;
  const targetId = target.id;
  const startDirectory = target.startDirectory;
  const enabled = options?.enabled ?? true;
  const pollIntervalMs = options?.pollIntervalMs ?? 5000;
  const [directoryEntries, setDirectoryEntries] = useState<Record<string, WorkspaceFileEntry[]>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<string[]>([]);
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [currentFile, setCurrentFile] = useState<WorkspaceFileEntry | null>(null);
  const [showHiddenFiles, setShowHiddenFiles] = useState(true);
  const [editorContent, setEditorContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loadingTree, setLoadingTree] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<FileExplorerCredentialErrorCode | null>(null);
  const [conflictState, setConflictState] = useState<WorkspaceFileConflictState | null>(null);
  const [autoReloadedAt, setAutoReloadedAt] = useState<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const isDirty = useMemo(() => editorContent !== savedContent, [editorContent, savedContent]);

  const applyErrorState = useCallback((requestError: unknown) => {
    setError(requestError instanceof Error ? requestError.message : String(requestError));
    setErrorCode(getFileExplorerCredentialErrorCode(requestError));
  }, []);

  const loadDirectory = useCallback(async (path: string) => {
    return await listFileExplorerFilesApi({ type: targetType, id: targetId }, path, { startDirectory });
  }, [startDirectory, targetId, targetType]);

  const refreshTree = useCallback(async (path = "") => {
    try {
      setLoadingTree(true);
      setError(null);
      setErrorCode(null);
      const response = await loadDirectory(path);
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
    } catch (requestError) {
      applyErrorState(requestError);
    } finally {
      setLoadingTree(false);
    }
  }, [applyErrorState, loadDirectory]);

  const toggleShowHiddenFiles = useCallback(async () => {
    setShowHiddenFiles((currentValue) => !currentValue);
  }, []);

  const openFile = useCallback(async (path: string) => {
    try {
      setLoadingFile(true);
      setError(null);
      setErrorCode(null);
      setConflictState(null);
      const response = await readFileExplorerFileApi({ type: targetType, id: targetId }, path, { startDirectory });
      setCurrentDirectory(getParentDirectory(response.file.path));
      setCurrentFile(response.file);
      setEditorContent(response.content);
      setSavedContent(response.content);
      setAutoReloadedAt(null);
    } catch (requestError) {
      applyErrorState(requestError);
    } finally {
      setLoadingFile(false);
    }
  }, [applyErrorState, startDirectory, targetId, targetType]);

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
    if (!currentFile || loadingFile || savingFile) {
      return;
    }

    try {
      const response = await getFileExplorerFileMetadataApi(
        { type: targetType, id: targetId },
        currentFile.path,
        { startDirectory },
      );
      const metadata = response.file;
      if (metadata.versionToken === currentFile.versionToken) {
        return;
      }

      if (isDirty) {
        setConflictState({
          kind: "reload_conflict",
          message: "This file changed outside the editor while you have unsaved changes.",
          currentFile: metadata,
        });
        return;
      }

      const readResponse = await readFileExplorerFileApi(
        { type: targetType, id: targetId },
        currentFile.path,
        { startDirectory },
      );
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
  }, [applyErrorState, currentFile, isDirty, loadingFile, savingFile, startDirectory, targetId, targetType]);

  const toggleDirectory = useCallback(async (path: string) => {
    const isExpanded = expandedDirectories.includes(path);
    if (isExpanded) {
      setExpandedDirectories((currentPaths) => currentPaths.filter((currentPath) => currentPath !== path));
      return;
    }

    setExpandedDirectories((currentPaths) => [...currentPaths, path]);
    if (!directoryEntries[path]) {
      await refreshTree(path);
    }
  }, [directoryEntries, expandedDirectories, refreshTree]);

  const dismissConflict = useCallback(() => {
    setConflictState(null);
  }, []);

  useEffect(() => {
    setLoadingTree(true);
    setError(null);
    setErrorCode(null);
    setDirectoryEntries({});
    setExpandedDirectories([]);
    setCurrentDirectory("");
    setCurrentFile(null);
    setShowHiddenFiles(true);
    setEditorContent("");
    setSavedContent("");
    setConflictState(null);
    setAutoReloadedAt(null);
    if (!enabled) {
      setLoadingTree(false);
      return;
    }
    void loadDirectory("")
      .then((response) => {
        setDirectoryEntries({ "": response.entries });
      })
      .catch((requestError) => {
        applyErrorState(requestError);
      })
      .finally(() => {
        setLoadingTree(false);
      });
  }, [applyErrorState, enabled, loadDirectory, startDirectory, targetId, targetType]);

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
    pollIntervalMs?: number;
  },
): UseWorkspaceFilesResult {
  return useFileExplorer({ type: "workspace", id: workspaceId }, options);
}

export function useServerFiles(
  serverId: string,
  options?: {
    pollIntervalMs?: number;
  },
): UseFileExplorerResult {
  return useFileExplorer({ type: "server", id: serverId }, options);
}
