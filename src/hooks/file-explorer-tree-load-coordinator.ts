import type {
  FileExplorerRequestOperation,
  FileExplorerRequestScope,
} from "./file-explorer-request-scope";

export interface FileExplorerTreeLoadCoordinator {
  begin: (
    scope: FileExplorerRequestScope,
    channel: string,
  ) => FileExplorerRequestOperation;
  finish: (
    scope: FileExplorerRequestScope,
    operation: FileExplorerRequestOperation,
  ) => boolean;
  dispose: () => void;
  isLoading: () => boolean;
}

export function createFileExplorerTreeLoadCoordinator(): FileExplorerTreeLoadCoordinator {
  const activeLoads = new Map<string, FileExplorerRequestOperation>();

  return {
    begin: (
      scope: FileExplorerRequestScope,
      channel: string,
    ): FileExplorerRequestOperation => {
      const operation = scope.createOperation(undefined, channel);
      activeLoads.set(channel, operation);
      return operation;
    },
    finish: (
      scope: FileExplorerRequestScope,
      operation: FileExplorerRequestOperation,
    ): boolean => {
      const channel = operation.channel;
      const ownsChannel = channel !== null && activeLoads.get(channel) === operation;
      if (ownsChannel) {
        activeLoads.delete(channel);
      }
      const shouldClearLoading = ownsChannel
        && scope.isCurrent()
        && activeLoads.size === 0;
      operation.release();
      return shouldClearLoading;
    },
    dispose: (): void => {
      for (const operation of activeLoads.values()) {
        operation.release();
      }
      activeLoads.clear();
    },
    isLoading: (): boolean => activeLoads.size > 0,
  };
}
