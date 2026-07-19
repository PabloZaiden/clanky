/**
 * useWorkspaceSelection — manages workspace and branch selection state.
 *
 * Handles workspace ID/directory state, the onWorkspaceChange notification
 * effect, and the branch selection state that resets when workspace changes.
 */

import { useState, useEffect, useRef } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import type { CreateTaskFormProps } from "./types";

const log = createLogger("CreateTaskForm");

type InitialTaskData = CreateTaskFormProps["initialTaskData"];

export interface UseWorkspaceSelectionReturn {
  selectedWorkspaceId: string | undefined;
  selectedWorkspaceDirectory: string;
  handleWorkspaceSelect: (workspaceId: string | null, workspaceDirectory: string) => void;
  selectedBranch: string;
  setSelectedBranch: (v: string) => void;
  setUserChangedBranch: (v: boolean) => void;
}

export function useWorkspaceSelection({
  isEditing,
  initialTaskData,
  onWorkspaceChange,
  defaultBranch,
}: {
  isEditing: boolean;
  initialTaskData: InitialTaskData;
  onWorkspaceChange: CreateTaskFormProps["onWorkspaceChange"];
  defaultBranch: string;
}): UseWorkspaceSelectionReturn {
  const isInitialMount = useRef(true);

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>(
    initialTaskData?.workspaceId
  );
  const [selectedWorkspaceDirectory, setSelectedWorkspaceDirectory] = useState<string>(
    initialTaskData?.directory ?? ""
  );
  const [selectedBranch, setSelectedBranch] = useState<string>(
    initialTaskData?.baseBranch ?? ""
  );
  const [userChangedBranch, setUserChangedBranch] = useState(!!initialTaskData?.baseBranch);

  // Sync workspace when initialTaskData changes
  useEffect(() => {
    setSelectedWorkspaceId(initialTaskData?.workspaceId);
    setSelectedWorkspaceDirectory(initialTaskData?.directory ?? "");
  }, [initialTaskData?.workspaceId, initialTaskData?.directory]);

  // Reset selected branch when default branch changes (directory changed)
  useEffect(() => {
    log.debug("useEffect 1 - branch reset", { defaultBranch, userChangedBranch, isEditing });
    if (defaultBranch && !userChangedBranch && !isEditing) {
      log.debug("Setting selected branch to:", defaultBranch);
      setSelectedBranch(defaultBranch);
    }
  }, [defaultBranch, userChangedBranch, isEditing]);

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

  // Reset branch selection flag when workspace changes
  useEffect(() => {
    log.debug("useEffect 4 - reset userChangedBranch", {
      isEditing,
      isInitialMount: isInitialMount.current,
      selectedWorkspaceId,
    });
    if (!isEditing && !isInitialMount.current) {
      log.debug("Resetting userChangedBranch to false");
      setUserChangedBranch(false);
    }
  }, [selectedWorkspaceId, isEditing]);

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
    setUserChangedBranch,
  };
}
