import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { FileExplorerRequestScope } from "./file-explorer-request-scope";
import type { WorkspaceFileConflictState } from "./file-explorer-types";

export interface FileExplorerConflictController {
  conflictState: WorkspaceFileConflictState | null;
  setConflictState: Dispatch<SetStateAction<WorkspaceFileConflictState | null>>;
  dismissConflict: () => void;
}

export function useFileExplorerConflicts(
  scope: FileExplorerRequestScope,
): FileExplorerConflictController {
  const [conflictState, setConflictStateState] = useState<WorkspaceFileConflictState | null>(null);
  const stateTargetKeyRef = useRef(scope.targetKey);
  const hasCurrentTargetState = stateTargetKeyRef.current === scope.targetKey;

  const setConflictState = useCallback<Dispatch<SetStateAction<WorkspaceFileConflictState | null>>>(
    (nextState) => {
      if (scope.isCurrent()) {
        setConflictStateState(nextState);
      }
    },
    [scope],
  );

  const dismissConflict = useCallback(() => {
    setConflictState(null);
  }, [setConflictState]);

  useEffect(() => {
    stateTargetKeyRef.current = scope.targetKey;
    setConflictStateState(null);
  }, [scope]);

  return {
    conflictState: hasCurrentTargetState ? conflictState : null,
    setConflictState,
    dismissConflict,
  };
}

