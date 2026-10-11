/**
 * useWorkspaceSelection — manages workspace and branch selection state.
 *
 * Handles workspace ID/directory state, branch selections scoped to their
 * workspace, and the onWorkspaceChange notification effect.
 */

import { useCallback, useState, useEffect, useRef } from "react";
import type { BranchInfo } from "@/contracts";
import { createLogger } from "@pablozaiden/webapp/web";
import { resolveWorkspaceBranchSelection } from "../../lib/workspace-branch-selection";
import type { CreateTaskFormProps } from "./types";

const log = createLogger("CreateTaskForm");

type InitialTaskData = CreateTaskFormProps["initialTaskData"];

export interface UseWorkspaceSelectionReturn {
  selectedWorkspaceId: string | undefined;
  selectedWorkspaceDirectory: string;
  handleWorkspaceSelect: (workspaceId: string | null, workspaceDirectory: string) => void;
  selectedBranch: string;
  setSelectedBranch: (v: string) => void;
  branchesReady: boolean;
}

export function useWorkspaceSelection({
  initialTaskData,
  onWorkspaceChange,
  branches,
  branchesLoading,
  branchesWorkspaceId,
  currentBranch,
  defaultBranch,
}: {
  initialTaskData: InitialTaskData;
  onWorkspaceChange: CreateTaskFormProps["onWorkspaceChange"];
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesWorkspaceId: string | null;
  currentBranch: string;
  defaultBranch: string;
}): UseWorkspaceSelectionReturn {
  const isInitialMount = useRef(true);

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>(
    initialTaskData?.workspaceId
  );
  const [selectedWorkspaceDirectory, setSelectedWorkspaceDirectory] = useState<string>(
    initialTaskData?.directory ?? ""
  );
  const [branchSelection, setBranchSelection] = useState({
    workspaceId: initialTaskData?.workspaceId,
    branch: initialTaskData?.baseBranch ?? "",
  });
  const selectedBranch = branchSelection.workspaceId === selectedWorkspaceId
    ? branchSelection.branch
    : "";
  const branchesReady = Boolean(
    selectedWorkspaceId
      && branchesWorkspaceId === selectedWorkspaceId
      && !branchesLoading,
  );

  const setSelectedBranch = useCallback((branch: string): void => {
    setBranchSelection({ workspaceId: selectedWorkspaceId, branch });
  }, [selectedWorkspaceId]);

  // Sync workspace when initialTaskData changes
  useEffect(() => {
    setSelectedWorkspaceId(initialTaskData?.workspaceId);
    setSelectedWorkspaceDirectory(initialTaskData?.directory ?? "");
    setBranchSelection({
      workspaceId: initialTaskData?.workspaceId,
      branch: initialTaskData?.baseBranch ?? "",
    });
  }, [
    initialTaskData?.baseBranch,
    initialTaskData?.workspaceId,
    initialTaskData?.directory,
  ]);

  useEffect(() => {
    if (!branchesReady) {
      return;
    }
    const nextBranch = resolveWorkspaceBranchSelection(
      selectedBranch,
      branches,
      currentBranch,
      defaultBranch,
    );
    if (selectedBranch !== nextBranch) {
      setSelectedBranch(nextBranch);
    }
  }, [
    branches,
    branchesReady,
    currentBranch,
    defaultBranch,
    selectedBranch,
    setSelectedBranch,
  ]);

  // Notify parent when workspace changes
  useEffect(() => {
    log.debug("useEffect 3 - workspace change", {
      selectedWorkspaceId,
      selectedWorkspaceDirectory,
      isInitialMount: isInitialMount.current,
      hasOnWorkspaceChange: !!onWorkspaceChange,
    });
    if (isInitialMount.current) {
      isInitialMount.current = false;
      if (initialTaskData?.workspaceId && initialTaskData?.directory && onWorkspaceChange) {
        log.debug(
          "Initial call to onWorkspaceChange:",
          initialTaskData.workspaceId,
          initialTaskData.directory
        );
        onWorkspaceChange(initialTaskData.workspaceId, initialTaskData.directory);
      }
      return;
    }

    if (!onWorkspaceChange) return;

    log.debug("Calling onWorkspaceChange:", selectedWorkspaceId, selectedWorkspaceDirectory);
    onWorkspaceChange(selectedWorkspaceId ?? null, selectedWorkspaceDirectory);
    // Note: onWorkspaceChange is intentionally NOT in deps array to prevent infinite task
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedWorkspaceId,
    selectedWorkspaceDirectory,
    initialTaskData?.workspaceId,
    initialTaskData?.directory,
  ]);

  function handleWorkspaceSelect(workspaceId: string | null, workspaceDirectory: string) {
    setSelectedWorkspaceId(workspaceId || undefined);
    setSelectedWorkspaceDirectory(workspaceDirectory);
  }

  return {
    selectedWorkspaceId,
    selectedWorkspaceDirectory,
    handleWorkspaceSelect,
    selectedBranch,
    setSelectedBranch,
    branchesReady,
  };
}
