import { useEffect, useMemo, useRef } from "react";
import type { FileExplorerTarget } from "./workspaceFileActions";

export interface FileExplorerRequestOperation {
  requestId: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface FileExplorerRequestScope {
  target: FileExplorerTarget;
  targetKey: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  createOperation: (signal?: AbortSignal) => FileExplorerRequestOperation;
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

  const isCurrent = (): boolean => (
    isTargetCurrent()
    && !controller.signal.aborted
  );

  return {
    target,
    targetKey,
    signal: controller.signal,
    isCurrent,
    dispose: () => {
      controller.abort();
    },
    createOperation: (operationSignal?: AbortSignal): FileExplorerRequestOperation => {
      const requestId = nextRequestId + 1;
      nextRequestId = requestId;
      const signal = combineAbortSignals(controller.signal, operationSignal);
      return {
        requestId,
        signal,
        isCurrent: () => isCurrent() && !signal.aborted,
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

function combineAbortSignals(
  targetSignal: AbortSignal,
  operationSignal?: AbortSignal,
): AbortSignal {
  if (!operationSignal || operationSignal === targetSignal) {
    return targetSignal;
  }
  return AbortSignal.any([targetSignal, operationSignal]);
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
