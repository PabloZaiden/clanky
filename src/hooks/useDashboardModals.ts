/**
 * Custom hook for Dashboard modal state management.
 * Centralizes all modal open/close state and action handlers.
 */

import { useState, useCallback } from "react";
import type { UncommittedChangesError } from "../types";
import type { CreateLoopFormActionState } from "../components/CreateLoopForm";

export interface ModalState<T = string | null> {
  open: boolean;
  loopId: T;
}

export interface UncommittedModalState {
  open: boolean;
  loopId: string | null;
  error: UncommittedChangesError | null;
}

export interface UseDashboardModalsResult {
  // Modal states
  showCreateModal: boolean;
  setShowCreateModal: (show: boolean) => void;
  editDraftId: string | null;
  setEditDraftId: (id: string | null) => void;
  createMode: "loop" | "chat";
  setCreateMode: (mode: "loop" | "chat") => void;
  uncommittedModal: UncommittedModalState;
  setUncommittedModal: (state: UncommittedModalState) => void;
  renameModal: ModalState;
  setRenameModal: (state: ModalState) => void;
  sshSessionRenameModal: { open: boolean; sessionId: string | null };
  setSshSessionRenameModal: (state: { open: boolean; sessionId: string | null }) => void;
  showServerSettingsModal: boolean;
  setShowServerSettingsModal: (show: boolean) => void;
  showCreateWorkspaceModal: boolean;
  setShowCreateWorkspaceModal: (show: boolean) => void;
  workspaceSettingsModal: { open: boolean; workspaceId: string | null };
  setWorkspaceSettingsModal: (state: { open: boolean; workspaceId: string | null }) => void;

  // Form action state
  formActionState: CreateLoopFormActionState | null;
  setFormActionState: (state: CreateLoopFormActionState | null) => void;

  // Handler functions
  handleCloseCreateModal: () => void;
  handleEditDraft: (loopId: string) => void;
  handleOpenCreateChat: () => void;
  handleOpenCreateLoop: () => void;
}

export function useDashboardModals(
  resetCreateModalState: () => void,
): UseDashboardModalsResult {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editDraftId, setEditDraftId] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<"loop" | "chat">("loop");
  const [uncommittedModal, setUncommittedModal] = useState<UncommittedModalState>({
    open: false,
    loopId: null,
    error: null,
  });
  const [renameModal, setRenameModal] = useState<ModalState>({ open: false, loopId: null });
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
  const [formActionState, setFormActionState] = useState<CreateLoopFormActionState | null>(null);

  const handleCloseCreateModal = useCallback(() => {
    setShowCreateModal(false);
    setEditDraftId(null);
    resetCreateModalState();
  }, [resetCreateModalState]);

  const handleEditDraft = useCallback((loopId: string) => {
    setEditDraftId(loopId);
    setCreateMode("loop");
    setShowCreateModal(true);
  }, []);

  const handleOpenCreateChat = useCallback(() => {
    setCreateMode("chat");
    setEditDraftId(null);
    setShowCreateModal(true);
  }, []);

  const handleOpenCreateLoop = useCallback(() => {
    setCreateMode("loop");
    setEditDraftId(null);
    setShowCreateModal(true);
  }, []);

  return {
    showCreateModal,
    setShowCreateModal,
    editDraftId,
    setEditDraftId,
    createMode,
    setCreateMode,
    uncommittedModal,
    setUncommittedModal,
    renameModal,
    setRenameModal,
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
    handleOpenCreateChat,
    handleOpenCreateLoop,
  };
}
