import type {
  FileExplorerRequestOperation,
  FileExplorerRequestScope,
} from "./file-explorer-request-scope";
import {
  combineFileExplorerAbortSignals,
} from "./file-explorer-request-scope";
import type { FileExplorerOperation } from "./file-explorer-types";

export interface FileExplorerMutationOwner {
  kind: FileExplorerOperation;
  targetKey: string;
  controller: AbortController;
  operation: FileExplorerRequestOperation;
}

export interface FileExplorerMutationBeginResult {
  owner: FileExplorerMutationOwner | null;
  reason: "started" | "busy" | "inactive";
}

export interface FileExplorerMutationCoordinator {
  begin: (
    scope: FileExplorerRequestScope,
    kind: FileExplorerOperation,
    externalSignal?: AbortSignal,
  ) => FileExplorerMutationBeginResult;
  isCurrent: (
    scope: FileExplorerRequestScope,
    owner: FileExplorerMutationOwner,
  ) => boolean;
  finish: (owner: FileExplorerMutationOwner) => boolean;
  dispose: (scope: FileExplorerRequestScope) => void;
}

export function createFileExplorerMutationCoordinator(): FileExplorerMutationCoordinator {
  let activeOwner: FileExplorerMutationOwner | null = null;

  const releaseOwner = (owner: FileExplorerMutationOwner): void => {
    owner.controller.abort();
    owner.operation.release();
    if (activeOwner === owner) {
      activeOwner = null;
    }
  };

  return {
    begin: (
      scope: FileExplorerRequestScope,
      kind: FileExplorerOperation,
      externalSignal?: AbortSignal,
    ): FileExplorerMutationBeginResult => {
      if (!scope.isCurrent()) {
        return { owner: null, reason: "inactive" };
      }

      if (activeOwner) {
        if (activeOwner.targetKey === scope.targetKey) {
          return { owner: null, reason: "busy" };
        }
        releaseOwner(activeOwner);
      }

      const controller = new AbortController();
      const operationSignal = externalSignal
        ? combineFileExplorerAbortSignals(controller.signal, externalSignal)
        : controller.signal;
      const owner: FileExplorerMutationOwner = {
        kind,
        targetKey: scope.targetKey,
        controller,
        operation: scope.createOperation(operationSignal),
      };
      activeOwner = owner;
      return { owner, reason: "started" };
    },
    isCurrent: (
      scope: FileExplorerRequestScope,
      owner: FileExplorerMutationOwner,
    ): boolean => (
      activeOwner === owner
      && owner.targetKey === scope.targetKey
      && scope.isCurrent()
      && owner.operation.isCurrent()
    ),
    finish: (owner: FileExplorerMutationOwner): boolean => {
      if (activeOwner !== owner) {
        return false;
      }
      activeOwner = null;
      owner.operation.release();
      return true;
    },
    dispose: (scope: FileExplorerRequestScope): void => {
      if (activeOwner?.targetKey === scope.targetKey) {
        releaseOwner(activeOwner);
      }
    },
  };
}
