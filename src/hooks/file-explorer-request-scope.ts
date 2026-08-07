import { useEffect, useMemo, useRef } from "react";
import type { FileExplorerTarget } from "./workspaceFileActions";

export interface FileExplorerRequestOperation {
  requestId: number;
  channel: string | null;
  signal: AbortSignal;
  isCurrent: () => boolean;
  release: () => void;
}

export interface FileExplorerRequestScope {
  target: FileExplorerTarget;
  targetKey: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  createOperation: (
    signal?: AbortSignal,
    channel?: string,
  ) => FileExplorerRequestOperation;
  dispose: () => void;
}

export function getFileExplorerTargetKey(target: FileExplorerTarget): string {
  return JSON.stringify([target.type, target.id, target.startDirectory ?? ""]);
}

export function createFileExplorerRequestScope(
  target: FileExplorerTarget,
  targetKey = getFileExplorerTargetKey(target),
  isTargetCurrent: () => boolean = () => true,
): FileExplorerRequestScope {
  const controller = new AbortController();
  let nextRequestId = 0;
  const channelOwners = new Map<string, {
    requestId: number;
    controller: AbortController;
  }>();

  const isCurrent = (): boolean => (
    isTargetCurrent()
    && !controller.signal.aborted
  );

  const dispose = (): void => {
    controller.abort();
    for (const owner of channelOwners.values()) {
      owner.controller.abort();
    }
    channelOwners.clear();
  };

  return {
    target,
    targetKey,
    signal: controller.signal,
    isCurrent,
    dispose,
    createOperation: (
      operationSignal?: AbortSignal,
      channel?: string,
    ): FileExplorerRequestOperation => {
      const requestId = nextRequestId + 1;
      nextRequestId = requestId;
      const channelController = channel ? new AbortController() : null;
      if (channelController && channel) {
        channelOwners.get(channel)?.controller.abort();
        channelOwners.set(channel, {
          requestId,
          controller: channelController,
        });
      }
      const operationSignalWithChannel = channelController
        ? combineFileExplorerAbortSignals(channelController.signal, operationSignal)
        : operationSignal;
      const signal = operationSignalWithChannel
        ? combineFileExplorerAbortSignals(controller.signal, operationSignalWithChannel)
        : controller.signal;
      let released = false;
      return {
        requestId,
        channel: channel ?? null,
        signal,
        isCurrent: () => (
          !released
          && isCurrent()
          && !signal.aborted
          && (
            !channel
            || channelOwners.get(channel)?.requestId === requestId
          )
        ),
        release: () => {
          if (released) {
            return;
          }
          released = true;
          if (channel && channelOwners.get(channel)?.requestId === requestId) {
            channelOwners.delete(channel);
            channelController?.abort();
          }
        },
      };
    },
  };
}

export function isFileExplorerAbortError(requestError: unknown): boolean {
  return (
    (requestError instanceof DOMException && requestError.name === "AbortError")
    || (requestError instanceof Error && requestError.name === "AbortError")
  );
}

export function combineFileExplorerAbortSignals(
  primarySignal: AbortSignal,
  secondarySignal?: AbortSignal,
): AbortSignal {
  if (!secondarySignal || secondarySignal === primarySignal) {
    return primarySignal;
  }
  return AbortSignal.any([primarySignal, secondarySignal]);
}

export function useFileExplorerRequestScope(
  target: FileExplorerTarget,
  lifecycleKey = "",
): FileExplorerRequestScope {
  const targetKey = JSON.stringify([getFileExplorerTargetKey(target), lifecycleKey]);
  const activeTargetKeyRef = useRef(targetKey);
  const targetGenerationRef = useRef(0);

  if (activeTargetKeyRef.current !== targetKey) {
    activeTargetKeyRef.current = targetKey;
    targetGenerationRef.current += 1;
  }

  const scope = useMemo<FileExplorerRequestScope>(() => {
    const targetGeneration = targetGenerationRef.current;
    return createFileExplorerRequestScope(
      target,
      targetKey,
      () => (
        activeTargetKeyRef.current === targetKey
        && targetGenerationRef.current === targetGeneration
      ),
    );
  }, [targetKey]);

  useEffect(() => {
    return () => {
      scope.dispose();
    };
  }, [scope]);

  return scope;
}
