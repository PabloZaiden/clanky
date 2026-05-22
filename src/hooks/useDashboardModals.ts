/**
 * Custom hook for Dashboard modal state management.
 * Centralizes all modal open/close state and action handlers.
 */

import { useState, useCallback } from "react";
import type { UncommittedChangesError } from "../types";
import type { CreateTaskFormActionState } from "../components/CreateTaskForm";

export interface ModalState<T = string | null> {
  open: boolean;
  taskId: T;
}

export interface UncommittedModalState {
  open: boolean;
  taskId: string | null;
  error: UncommittedChangesError | null;
}

export interface UseDashboardModalsResult {
  // Modal states
  showCreateModal: boolean;
  setShowCreateModal: (show: boolean) => void;
  editDraftId: string | null;
  setEditDraftId: (id: string | null) => void;
  uncommittedModal: UncommittedModalState;
  setUncommittedModal: (state: UncommittedModalState) => void;
  sshSessionRenameModal: { open: boolean; sessionId: string | null };
  setSshSessionRenameModal: (state: { open: boolean; sessionId: string | null }) => void;
  showServerSettingsModal: boolean;
  setShowServerSettingsModal: (show: boolean) => void;
  showCreateWorkspaceModal: boolean;
  setShowCreateWorkspaceModal: (show: boolean) => void;
  workspaceSettingsModal: { open: boolean; workspaceId: string | null };
  setWorkspaceSettingsModal: (state: { open: boolean; workspaceId: string | null }) => void;

  // Form action state
  formActionState: CreateTaskFormActionState | null;
  setFormActionState: (state: CreateTaskFormActionState | null) => void;

  // Handler functions
  handleCloseCreateModal: () => void;
  handleEditDraft: (taskId: string) => void;
  handleOpenCreateTask: () => void;
}

export function useDashboardModals(
  resetCreateModalState: () => void,
): UseDashboardModalsResult {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editDraftId, setEditDraftId] = useState<string | null>(null);
  const [uncommittedModal, setUncommittedModal] = useState<UncommittedModalState>({
    open: false,
    taskId: null,
    error: null,
  });
  const [sshSessionRenameModal, setSshSessionRenameModal] = useState<{ open: boolean; sessionId: string | null }>({
    open: false,
    sessionId: null,
  });
  const [showServerSettingsModal, setShowServerSettingsModal] = useState(false);
  const [showCreateWorkspaceModal, setShowCreateWorkspaceModal] = useState(false);
  const [workspaceSettingsModal, setWorkspaceSettingsModal] = useState<{ open: boolean; workspaceId: string | null }>({
    open: false,
    workspaceId: null,
  });
  const [formActionState, setFormActionState] = useState<CreateTaskFormActionState | null>(null);

  const handleCloseCreateModal = useCallback(() => {
    setShowCreateModal(false);
    setEditDraftId(null);
    resetCreateModalState();
  }, [resetCreateModalState]);

  const handleEditDraft = useCallback((taskId: string) => {
    setEditDraftId(taskId);
    setShowCreateModal(true);
  }, []);

  const handleOpenCreateTask = useCallback(() => {
    setEditDraftId(null);
    setShowCreateModal(true);
  }, []);

  return {
    showCreateModal,
    setShowCreateModal,
    editDraftId,
    setEditDraftId,
    uncommittedModal,
    setUncommittedModal,
    sshSessionRenameModal,
    setSshSessionRenameModal,
    showServerSettingsModal,
    setShowServerSettingsModal,
    showCreateWorkspaceModal,
    setShowCreateWorkspaceModal,
    workspaceSettingsModal,
    setWorkspaceSettingsModal,
    formActionState,
    setFormActionState,
    handleCloseCreateModal,
    handleEditDraft,
    handleOpenCreateTask,
  };
}
