import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceFileNode } from "@/shared";
import {
  listFileExplorerFilesApi,
  loadFileExplorerTreeApi,
} from "./workspaceFileActions";
import type {
  FileExplorerRequestOperation,
  FileExplorerRequestScope,
} from "./file-explorer-request-scope";
import {
  findDirectoryNode,
  getAncestorDirectories,
  getExpandedDirectoriesForTreeResponse,
  isWithinLazySubtree,
  upsertDirectoryEntry,
} from "./file-explorer-utils";
import {
  createFileExplorerTreeLoadCoordinator,
  type FileExplorerTreeLoadCoordinator,
} from "./file-explorer-tree-load-coordinator";

const FULL_TREE_REFRESH_CHANNEL = "tree:full";

function getDirectoryRefreshChannel(path: string): string {
  return `tree:directory:${path}`;
}

export interface UseFileExplorerTreeOptions {
  enabled: boolean;
  loadFullTree: boolean;
  onError: (requestError: unknown) => void;
  clearError: () => void;
}

export interface UseFileExplorerTreeResult {
  directoryEntries: Record<string, WorkspaceFileNode[]>;
  expandedDirectories: string[];
  currentDirectory: string;
  selectedNode: WorkspaceFileNode | null;
  showHiddenFiles: boolean;
  loadingTree: boolean;
  effectiveLoadFullTree: boolean;
  refreshTree: (path?: string) => Promise<void>;
  toggleShowHiddenFiles: () => Promise<void>;
  toggleDirectory: (path: string) => Promise<void>;
  selectNode: (node: WorkspaceFileNode | null) => void;
  ensureFilePathVisible: (
    path: string,
    operation?: FileExplorerRequestOperation,
  ) => Promise<void>;
  setCurrentDirectoryForOperation: (
    directory: string,
    isCurrent?: () => boolean,
  ) => void;
  updateDirectoryEntry: (
    entry: WorkspaceFileNode,
    isCurrent?: () => boolean,
  ) => void;
  clearSelectedFileState: (isCurrent?: () => boolean) => void;
}

export function useFileExplorerTree(
  scope: FileExplorerRequestScope,
  options: UseFileExplorerTreeOptions,
): UseFileExplorerTreeResult {
  const {
    enabled,
    loadFullTree,
    onError,
    clearError,
  } = options;
  const [directoryEntries, setDirectoryEntries] = useState<Record<string, WorkspaceFileNode[]>>({});
  const [expandedDirectories, setExpandedDirectories] = useState<string[]>([]);
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [selectedNode, setSelectedNode] = useState<WorkspaceFileNode | null>(null);
  const [showHiddenFiles, setShowHiddenFiles] = useState(true);
  const [loadingTree, setLoadingTree] = useState(true);
  const [effectiveLoadFullTree, setEffectiveLoadFullTree] = useState(loadFullTree);
  const directoryEntriesRef = useRef(directoryEntries);
  const stateTargetKeyRef = useRef(scope.targetKey);
  const [lazySubtreeRoots, setLazySubtreeRoots] = useState<string[]>([]);
  const treeLoadCoordinatorRef = useRef<FileExplorerTreeLoadCoordinator | null>(null);
  if (!treeLoadCoordinatorRef.current) {
    treeLoadCoordinatorRef.current = createFileExplorerTreeLoadCoordinator();
  }

  const hasCurrentTargetState = stateTargetKeyRef.current === scope.targetKey;
  directoryEntriesRef.current = hasCurrentTargetState ? directoryEntries : {};

  const applyDirectoryResponse = useCallback((
    path: string,
    response: { entries: WorkspaceFileNode[] },
    operation: FileExplorerRequestOperation,
    applyOptions?: { markAsLazySubtreeRoot?: boolean },
  ) => {
    if (!operation.isCurrent()) {
      return;
    }
    setDirectoryEntries((currentEntries) => ({
      ...currentEntries,
      [path]: response.entries,
    }));
    if (applyOptions?.markAsLazySubtreeRoot) {
      setLazySubtreeRoots((currentPaths) =>
        currentPaths.includes(path) ? currentPaths : [...currentPaths, path]
      );
    }
    setExpandedDirectories((currentPaths) => {
      if (!path || currentPaths.includes(path)) {
        return currentPaths;
      }
      return [...currentPaths, path];
    });
  }, []);

  const loadDirectory = useCallback(async (
    path: string,
    signal: AbortSignal,
  ) => {
    return await listFileExplorerFilesApi(scope.target, path, {
      startDirectory: scope.target.startDirectory,
      signal,
    });
  }, [scope]);

  const loadTree = useCallback(async (signal: AbortSignal) => {
    return await loadFileExplorerTreeApi(scope.target, {
      startDirectory: scope.target.startDirectory,
      signal,
    });
  }, [scope]);

  const beginTreeLoad = useCallback((channel: string): FileExplorerRequestOperation => {
    const operation = treeLoadCoordinatorRef.current!.begin(scope, channel);
    if (scope.isCurrent()) {
      setLoadingTree(true);
    }
    return operation;
  }, [scope]);

  const finishTreeLoad = useCallback((operation: FileExplorerRequestOperation): void => {
    if (treeLoadCoordinatorRef.current!.finish(scope, operation)) {
      setLoadingTree(false);
    }
  }, [scope]);

  const refreshTree = useCallback(async (path = "") => {
    if (!scope.isCurrent()) {
      return;
    }
    const directoryNode = path ? findDirectoryNode(directoryEntriesRef.current, path) : null;
    const shouldLoadDirectory = path.length > 0 && (
      !effectiveLoadFullTree
      || Boolean(directoryNode?.loadOnExpand)
      || isWithinLazySubtree(path, lazySubtreeRoots)
    );
    const channel = effectiveLoadFullTree && !shouldLoadDirectory
      ? FULL_TREE_REFRESH_CHANNEL
      : getDirectoryRefreshChannel(path);
    const operation = beginTreeLoad(channel);
    clearError();

    try {
      if (effectiveLoadFullTree && !shouldLoadDirectory) {
        const response = await loadTree(operation.signal);
        if (!operation.isCurrent()) {
          return;
        }
        setDirectoryEntries(response.entriesByDirectory);
        setLazySubtreeRoots([]);
        setExpandedDirectories((currentPaths) =>
          getExpandedDirectoriesForTreeResponse(currentPaths, response.entriesByDirectory)
        );
        return;
      }

      const response = await loadDirectory(path, operation.signal);
      applyDirectoryResponse(path, response, operation, {
        markAsLazySubtreeRoot: effectiveLoadFullTree && path.length > 0,
      });
    } catch (requestError) {
      if (operation.isCurrent()) {
        onError(requestError);
      }
    } finally {
      finishTreeLoad(operation);
    }
  }, [
    applyDirectoryResponse,
    beginTreeLoad,
    effectiveLoadFullTree,
    finishTreeLoad,
    lazySubtreeRoots,
    loadDirectory,
    loadTree,
    clearError,
    onError,
    scope,
  ]);

  const toggleShowHiddenFiles = useCallback(async () => {
    if (!scope.isCurrent()) {
      return;
    }
    setShowHiddenFiles((currentValue) => !currentValue);
  }, [scope]);

  const selectNode = useCallback((node: WorkspaceFileNode | null) => {
    if (!scope.isCurrent()) {
      return;
    }
    setSelectedNode(node);
  }, [scope]);

  const ensureFilePathVisible = useCallback(async (
    path: string,
    providedOperation?: FileExplorerRequestOperation,
  ) => {
    const operation = providedOperation ?? scope.createOperation();
    const ancestorDirectories = getAncestorDirectories(path);
    if (ancestorDirectories.length === 0 || !operation.isCurrent()) {
      return;
    }

    setExpandedDirectories((currentPaths) => {
      if (!operation.isCurrent()) {
        return currentPaths;
      }
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
      if (!operation.isCurrent()) {
        return;
      }
      if (directoryEntriesRef.current[directory] !== undefined) {
        continue;
      }
      const response = await loadDirectory(directory, operation.signal);
      applyDirectoryResponse(directory, response, operation, {
        markAsLazySubtreeRoot: false,
      });
    }
  }, [applyDirectoryResponse, effectiveLoadFullTree, loadDirectory, scope]);

  const toggleDirectory = useCallback(async (path: string) => {
    if (!scope.isCurrent()) {
      return;
    }
    const directoryNode = findDirectoryNode(directoryEntriesRef.current, path);
    if (directoryNode) {
      setSelectedNode(directoryNode);
    }
    const isExpanded = expandedDirectories.includes(path);
    setExpandedDirectories((currentPaths) => {
      const currentIsExpanded = currentPaths.includes(path);
      return currentIsExpanded
        ? currentPaths.filter((currentPath) => currentPath !== path)
        : [...currentPaths, path];
    });
    if (isExpanded) {
      return;
    }

    const shouldLoadDirectory = directoryEntriesRef.current[path] === undefined && (
      !effectiveLoadFullTree
      || Boolean(directoryNode?.loadOnExpand)
      || isWithinLazySubtree(path, lazySubtreeRoots)
    );
    if (shouldLoadDirectory) {
      await refreshTree(path);
    }
  }, [
    effectiveLoadFullTree,
    expandedDirectories,
    lazySubtreeRoots,
    refreshTree,
    scope,
  ]);

  const setCurrentDirectoryForOperation = useCallback((
    directory: string,
    isCurrent: () => boolean = scope.isCurrent,
  ) => {
    if (isCurrent()) {
      setCurrentDirectory(directory);
    }
  }, [scope]);

  const updateDirectoryEntry = useCallback((
    entry: WorkspaceFileNode,
    isCurrent: () => boolean = scope.isCurrent,
  ) => {
    if (isCurrent()) {
      setDirectoryEntries((currentEntries) => upsertDirectoryEntry(currentEntries, entry));
    }
  }, [scope]);

  const clearSelectedFileState = useCallback((
    isCurrent: () => boolean = scope.isCurrent,
  ) => {
    if (isCurrent()) {
      setSelectedNode(null);
    }
  }, [scope]);

  useEffect(() => {
    stateTargetKeyRef.current = scope.targetKey;
    setDirectoryEntries({});
    setExpandedDirectories([]);
    setCurrentDirectory("");
    setSelectedNode(null);
    setShowHiddenFiles(true);
    setLoadingTree(enabled);
    setLazySubtreeRoots([]);
    setEffectiveLoadFullTree(loadFullTree);
    clearError();

    if (!enabled) {
      return;
    }

    const operation = beginTreeLoad(
      loadFullTree ? FULL_TREE_REFRESH_CHANNEL : getDirectoryRefreshChannel(""),
    );
    const loadInitialTree = async (): Promise<void> => {
      try {
        if (loadFullTree) {
          const response = await loadTree(operation.signal);
          if (!operation.isCurrent()) {
            return;
          }
          setDirectoryEntries(response.entriesByDirectory);
          setLazySubtreeRoots([]);
        } else {
          const response = await loadDirectory("", operation.signal);
          applyDirectoryResponse("", response, operation);
          if (operation.isCurrent()) {
            setLazySubtreeRoots([]);
          }
        }
      } catch (requestError) {
        if (operation.isCurrent()) {
          onError(requestError);
        }
      } finally {
        finishTreeLoad(operation);
      }
    };

    void loadInitialTree();
    return () => {
      treeLoadCoordinatorRef.current!.dispose();
    };
  }, [
    applyDirectoryResponse,
    beginTreeLoad,
    clearError,
    enabled,
    finishTreeLoad,
    loadDirectory,
    loadFullTree,
    onError,
    scope,
  ]);

  return {
    directoryEntries: hasCurrentTargetState ? directoryEntries : {},
    expandedDirectories: hasCurrentTargetState ? expandedDirectories : [],
    currentDirectory: hasCurrentTargetState ? currentDirectory : "",
    selectedNode: hasCurrentTargetState ? selectedNode : null,
    showHiddenFiles: hasCurrentTargetState ? showHiddenFiles : true,
    loadingTree: hasCurrentTargetState ? loadingTree : enabled,
    effectiveLoadFullTree,
    refreshTree,
    toggleShowHiddenFiles,
    toggleDirectory,
    selectNode,
    ensureFilePathVisible,
    setCurrentDirectoryForOperation,
    updateDirectoryEntry,
    clearSelectedFileState,
  };
}
