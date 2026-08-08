import type {
  FileExplorerRequestOperation,
  FileExplorerRequestScope,
} from "./file-explorer-request-scope";

export type FileExplorerTreeLoadKind = "full" | "directory";

export interface FileExplorerTreeLoadRequest {
  channel: string;
  kind: FileExplorerTreeLoadKind;
}

export interface FileExplorerTreeLoadCoordinator {
  begin: (
    scope: FileExplorerRequestScope,
    request: FileExplorerTreeLoadRequest,
    signal?: AbortSignal,
  ) => FileExplorerRequestOperation;
  finish: (
    scope: FileExplorerRequestScope,
    operation: FileExplorerRequestOperation,
  ) => boolean;
  dispose: () => void;
  isLoading: () => boolean;
}

export function createFileExplorerTreeLoadCoordinator(): FileExplorerTreeLoadCoordinator {
  const activeLoads = new Map<string, {
    operation: FileExplorerRequestOperation;
    kind: FileExplorerTreeLoadKind;
  }>();

  return {
    begin: (
      scope: FileExplorerRequestScope,
      request: FileExplorerTreeLoadRequest,
      signal?: AbortSignal,
    ): FileExplorerRequestOperation => {
      for (const [channel, activeLoad] of activeLoads) {
        const overlaps = request.kind === "full"
          || activeLoad.kind === "full"
          || channel === request.channel;
        if (!overlaps) {
          continue;
        }
        activeLoads.delete(channel);
        activeLoad.operation.release();
      }

      const operation = scope.createOperation(signal, request.channel);
      activeLoads.set(request.channel, {
        operation,
        kind: request.kind,
      });
      return operation;
    },
    finish: (
      scope: FileExplorerRequestScope,
      operation: FileExplorerRequestOperation,
    ): boolean => {
      const channel = operation.channel;
      const activeLoad = channel === null ? undefined : activeLoads.get(channel);
      const ownsChannel = activeLoad?.operation === operation;
      if (ownsChannel && channel !== null) {
        activeLoads.delete(channel);
      }
      const shouldClearLoading = ownsChannel
        && scope.isCurrent()
        && activeLoads.size === 0;
      operation.release();
      return shouldClearLoading;
    },
    dispose: (): void => {
      for (const activeLoad of activeLoads.values()) {
        activeLoad.operation.release();
      }
      activeLoads.clear();
    },
    isLoading: (): boolean => activeLoads.size > 0,
  };
}
