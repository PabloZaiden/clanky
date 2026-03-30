/**
 * Hook for managing modal visibility and action handlers in LoopDetails.
 */

import { useState } from "react";
import type { SshSession, PullRequestDestinationResponse } from "../../types";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type { ToastContextValue } from "../../hooks/useToast";
import type { AcceptPlanResult, PushLoopResult, AddressCommentsResult } from "../../hooks/loopActions";
import { log } from "../../lib/logger";

interface UseLoopActionsOptions {
  onBack?: () => void;
  onSelectSshSession?: (sshSessionId: string) => void;
  toast: ToastContextValue;
  accept: () => Promise<AcceptPlanResult | unknown>;
  push: () => Promise<PushLoopResult | unknown>;
  updateBranch: () => Promise<PushLoopResult>;
  remove: () => Promise<boolean>;
  purge: () => Promise<boolean>;
  markMerged: () => Promise<boolean>;
  addressReviewComments: (comments: string, attachments?: MessageImageAttachment[]) => Promise<AddressCommentsResult>;
  acceptPlan: (mode?: "start_loop" | "open_ssh") => Promise<AcceptPlanResult>;
  discardPlan: () => Promise<boolean>;
  connectViaSsh: () => Promise<SshSession | null>;
  update: (request: { name?: string }) => Promise<boolean>;
  fetchReviewComments: () => Promise<void>;
}

export interface UseLoopActionsResult {
  // Modal open state
  deleteModal: boolean;
  acceptModal: boolean;
  purgeModal: boolean;
  markMergedModal: boolean;
  addressCommentsModal: boolean;
  renameModal: boolean;
  updateBranchModal: boolean;
  discardPlanModal: boolean;
  planActionSubmitting: boolean;
  sshConnecting: boolean;

  // Modal open/close setters
  setDeleteModal: (open: boolean) => void;
  setAcceptModal: (open: boolean) => void;
  setPurgeModal: (open: boolean) => void;
  setMarkMergedModal: (open: boolean) => void;
  setAddressCommentsModal: (open: boolean) => void;
  setRenameModal: (open: boolean) => void;
  setUpdateBranchModal: (open: boolean) => void;
  setDiscardPlanModal: (open: boolean) => void;

  // Action handlers
  handleDelete: () => Promise<void>;
  handleAccept: () => Promise<void>;
  handlePush: () => Promise<void>;
  handlePurge: () => Promise<void>;
  handleUpdateBranch: () => Promise<void>;
  handleMarkMerged: () => Promise<void>;
  handleAddressComments: (comments: string, attachments?: MessageImageAttachment[]) => Promise<void>;
  handleOpenPullRequest: (destination: PullRequestDestinationResponse | null) => void;
  handleAcceptPlan: (mode?: "start_loop" | "open_ssh") => Promise<void>;
  handleDiscardPlan: () => Promise<void>;
  handleConnectViaSsh: () => Promise<void>;
  handleRename: (newName: string) => Promise<void>;
}

export function useLoopActions({
  onBack,
  onSelectSshSession,
  toast,
  accept,
  push,
  updateBranch,
  remove,
  purge,
  markMerged,
  addressReviewComments,
  acceptPlan,
  discardPlan,
  connectViaSsh,
  update,
  fetchReviewComments,
}: UseLoopActionsOptions): UseLoopActionsResult {
  const [deleteModal, setDeleteModal] = useState(false);
  const [acceptModal, setAcceptModal] = useState(false);
  const [purgeModal, setPurgeModal] = useState(false);
  const [markMergedModal, setMarkMergedModal] = useState(false);
  const [addressCommentsModal, setAddressCommentsModal] = useState(false);
  const [renameModal, setRenameModal] = useState(false);
  const [updateBranchModal, setUpdateBranchModal] = useState(false);
  const [discardPlanModal, setDiscardPlanModal] = useState(false);
  const [planActionSubmitting, setPlanActionSubmitting] = useState(false);
  const [sshConnecting, setSshConnecting] = useState(false);

  function navigateToSshSession(sshSessionId: string) {
    if (onSelectSshSession) {
      onSelectSshSession(sshSessionId);
    } else {
      window.location.hash = `/ssh/${sshSessionId}`;
    }
  }

  async function handleDelete() {
    const success = await remove();
    if (success) {
      onBack?.();
    }
    setDeleteModal(false);
  }

  async function handleAccept() {
    await accept();
    setAcceptModal(false);
  }

  async function handlePush() {
    await push();
    setAcceptModal(false);
  }

  async function handlePurge() {
    const success = await purge();
    if (success) {
      onBack?.();
    }
    setPurgeModal(false);
  }

  async function handleUpdateBranch() {
    const result = await updateBranch();
    if (!result.success) {
      toast.error("Failed to update branch");
      setUpdateBranchModal(false);
      return;
    }
    setUpdateBranchModal(false);
  }

  async function handleMarkMerged() {
    await markMerged();
    setMarkMergedModal(false);
  }

  async function handleAddressComments(comments: string, attachments?: MessageImageAttachment[]) {
    try {
      const result = await addressReviewComments(comments, attachments);
      if (!result.success) {
        throw new Error("Failed to address comments");
      }
      await fetchReviewComments();
    } catch (error) {
      log.error("Failed to address comments:", error);
      throw error;
    }
  }

  function handleOpenPullRequest(destination: PullRequestDestinationResponse | null) {
    if (!destination?.enabled) return;
    window.open(destination.url, "_blank", "noopener,noreferrer");
  }

  async function handleAcceptPlan(mode: "start_loop" | "open_ssh" = "start_loop") {
    setPlanActionSubmitting(true);
    try {
      const result = await acceptPlan(mode);
      if (!result.success) {
        toast.error(mode === "open_ssh" ? "Failed to accept plan and open SSH" : "Failed to accept plan");
        return;
      }
      if (result.success && result.mode === "open_ssh") {
        navigateToSshSession(result.sshSession.config.id);
      }
    } finally {
      setPlanActionSubmitting(false);
    }
  }

  async function handleDiscardPlan() {
    setPlanActionSubmitting(true);
    try {
      await discardPlan();
    } finally {
      // Clean up local state before navigating away to avoid
      // setState on unmounted component if onBack() triggers unmount
      setPlanActionSubmitting(false);
      setDiscardPlanModal(false);
    }
    // Navigate after state cleanup so we don't setState on an unmounted component
    onBack?.();
  }

  async function handleConnectViaSsh() {
    setSshConnecting(true);
    try {
      const session = await connectViaSsh();
      if (!session) {
        toast.error("Failed to connect via ssh");
        return;
      }
      navigateToSshSession(session.config.id);
    } finally {
      setSshConnecting(false);
    }
  }

  async function handleRename(newName: string) {
    await update({ name: newName });
  }

  return {
    deleteModal,
    acceptModal,
    purgeModal,
    markMergedModal,
    addressCommentsModal,
    renameModal,
    updateBranchModal,
    discardPlanModal,
    planActionSubmitting,
    sshConnecting,
    setDeleteModal,
    setAcceptModal,
    setPurgeModal,
    setMarkMergedModal,
    setAddressCommentsModal,
    setRenameModal,
    setUpdateBranchModal,
    setDiscardPlanModal,
    handleDelete,
    handleAccept,
    handlePush,
    handlePurge,
    handleUpdateBranch,
    handleMarkMerged,
    handleAddressComments,
    handleOpenPullRequest,
    handleAcceptPlan,
    handleDiscardPlan,
    handleConnectViaSsh,
    handleRename,
  };
}
