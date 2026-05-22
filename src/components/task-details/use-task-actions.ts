/**
 * Hook for managing modal visibility and action handlers in TaskDetails.
 */

import { useState } from "react";
import type { SshSession, PullRequestDestinationResponse, UpdateTaskRequest } from "../../types";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type { ToastContextValue } from "../../hooks/useToast";
import type {
  AcceptPlanResult,
  PushTaskResult,
  AddressCommentsResult,
  AutomaticPrFlowResult,
  PullRequestAutoMergeResult,
} from "../../hooks/taskActions";
import { log } from "../../lib/logger";

interface UseTaskActionsOptions {
  onBack?: () => void;
  onSelectSshSession?: (sshSessionId: string) => void;
  onOpenTaskFiles?: () => void;
  toast: ToastContextValue;
  accept: () => Promise<AcceptPlanResult | unknown>;
  push: () => Promise<PushTaskResult | unknown>;
  updateBranch: () => Promise<PushTaskResult>;
  remove: () => Promise<boolean>;
  purge: () => Promise<boolean>;
  markMerged: () => Promise<boolean>;
  closeLocalTask: () => Promise<boolean>;
  manualCompleteTask: () => Promise<boolean>;
  addressReviewComments: (comments: string, attachments?: MessageImageAttachment[]) => Promise<AddressCommentsResult>;
  enablePullRequestAutoMerge: () => Promise<PullRequestAutoMergeResult>;
  startAutomaticPrFlow: () => Promise<AutomaticPrFlowResult>;
  stopAutomaticPrFlow: () => Promise<AutomaticPrFlowResult>;
  acceptPlan: (mode?: "start_task" | "open_ssh") => Promise<AcceptPlanResult>;
  discardPlan: () => Promise<boolean>;
  connectViaSsh: () => Promise<SshSession | null>;
  update: (request: UpdateTaskRequest) => Promise<boolean>;
  fetchReviewComments: () => Promise<void>;
}

export interface UseTaskActionsResult {
  // Modal open state
  deleteModal: boolean;
  acceptModal: boolean;
  purgeModal: boolean;
  markMergedModal: boolean;
  closeLocalModal: boolean;
  manualCompleteModal: boolean;
  addressCommentsModal: boolean;
  updateBranchModal: boolean;
  discardPlanModal: boolean;
  startAutomaticPrFlowModal: boolean;
  stopAutomaticPrFlowModal: boolean;
  planActionSubmitting: boolean;
  automaticPrFlowSubmitting: boolean;
  pullRequestAutoMergeSubmitting: boolean;
  sshConnecting: boolean;
  planningSettingsSubmitting: boolean;

  // Modal open/close setters
  setDeleteModal: (open: boolean) => void;
  setAcceptModal: (open: boolean) => void;
  setPurgeModal: (open: boolean) => void;
  setMarkMergedModal: (open: boolean) => void;
  setCloseLocalModal: (open: boolean) => void;
  setManualCompleteModal: (open: boolean) => void;
  setAddressCommentsModal: (open: boolean) => void;
  setUpdateBranchModal: (open: boolean) => void;
  setDiscardPlanModal: (open: boolean) => void;
  setStartAutomaticPrFlowModal: (open: boolean) => void;
  setStopAutomaticPrFlowModal: (open: boolean) => void;

  // Action handlers
  handleDelete: () => Promise<void>;
  handleAccept: () => Promise<void>;
  handlePush: () => Promise<void>;
  handlePurge: () => Promise<void>;
  handleUpdateBranch: () => Promise<void>;
  handleMarkMerged: () => Promise<void>;
  handleCloseLocal: () => Promise<void>;
  handleManualComplete: () => Promise<void>;
  handleAddressComments: (comments: string, attachments?: MessageImageAttachment[]) => Promise<void>;
  handleOpenPullRequest: (destination: PullRequestDestinationResponse | null) => void;
  handleEnablePullRequestAutoMerge: () => Promise<void>;
  handleStartAutomaticPrFlow: () => Promise<void>;
  handleStopAutomaticPrFlow: () => Promise<void>;
  handleAcceptPlan: (mode?: "start_task" | "open_ssh") => Promise<void>;
  handleDiscardPlan: () => Promise<void>;
  handleConnectViaSsh: () => Promise<void>;
  handleOpenTaskFiles: () => void;
  handleUpdatePlanningSettings: (request: Pick<UpdateTaskRequest, "autoAcceptPlan" | "fullyAutonomous">) => Promise<boolean>;
}

export function useTaskActions({
  onBack,
  onSelectSshSession,
  onOpenTaskFiles,
  toast,
  accept,
  push,
  updateBranch,
  remove,
  purge,
  markMerged,
  closeLocalTask,
  manualCompleteTask,
  addressReviewComments,
  enablePullRequestAutoMerge,
  startAutomaticPrFlow,
  stopAutomaticPrFlow,
  acceptPlan,
  discardPlan,
  connectViaSsh,
  update,
  fetchReviewComments,
}: UseTaskActionsOptions): UseTaskActionsResult {
  const [deleteModal, setDeleteModal] = useState(false);
  const [acceptModal, setAcceptModal] = useState(false);
  const [purgeModal, setPurgeModal] = useState(false);
  const [markMergedModal, setMarkMergedModal] = useState(false);
  const [closeLocalModal, setCloseLocalModal] = useState(false);
  const [manualCompleteModal, setManualCompleteModal] = useState(false);
  const [addressCommentsModal, setAddressCommentsModal] = useState(false);
  const [updateBranchModal, setUpdateBranchModal] = useState(false);
  const [discardPlanModal, setDiscardPlanModal] = useState(false);
  const [planActionSubmitting, setPlanActionSubmitting] = useState(false);
  const [startAutomaticPrFlowModal, setStartAutomaticPrFlowModal] = useState(false);
  const [stopAutomaticPrFlowModal, setStopAutomaticPrFlowModal] = useState(false);
  const [automaticPrFlowSubmitting, setAutomaticPrFlowSubmitting] = useState(false);
  const [pullRequestAutoMergeSubmitting, setPullRequestAutoMergeSubmitting] = useState(false);
  const [sshConnecting, setSshConnecting] = useState(false);
  const [planningSettingsSubmitting, setPlanningSettingsSubmitting] = useState(false);

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

  async function handleCloseLocal() {
    await closeLocalTask();
    setCloseLocalModal(false);
  }

  async function handleManualComplete() {
    await manualCompleteTask();
    setManualCompleteModal(false);
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

  async function handleEnablePullRequestAutoMerge() {
    setPullRequestAutoMergeSubmitting(true);
    try {
      const result = await enablePullRequestAutoMerge();
      if (!result.success) {
        toast.error("Failed to enable pull request auto-merge");
      }
    } finally {
      setPullRequestAutoMergeSubmitting(false);
    }
  }

  async function handleStartAutomaticPrFlow() {
    setAutomaticPrFlowSubmitting(true);
    try {
      const result = await startAutomaticPrFlow();
      if (!result.success) {
        toast.error("Failed to start automatic PR flow");
        return;
      }
      setStartAutomaticPrFlowModal(false);
    } finally {
      setAutomaticPrFlowSubmitting(false);
    }
  }

  async function handleStopAutomaticPrFlow() {
    setAutomaticPrFlowSubmitting(true);
    try {
      const result = await stopAutomaticPrFlow();
      if (!result.success) {
        toast.error("Failed to stop automatic PR flow");
        return;
      }
      setStopAutomaticPrFlowModal(false);
    } finally {
      setAutomaticPrFlowSubmitting(false);
    }
  }

  async function handleAcceptPlan(mode: "start_task" | "open_ssh" = "start_task") {
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

  function handleOpenTaskFiles() {
    onOpenTaskFiles?.();
  }

  async function handleUpdatePlanningSettings(
    request: Pick<UpdateTaskRequest, "autoAcceptPlan" | "fullyAutonomous">,
  ): Promise<boolean> {
    setPlanningSettingsSubmitting(true);
    try {
      return await update(request);
    } finally {
      setPlanningSettingsSubmitting(false);
    }
  }

  return {
    deleteModal,
    acceptModal,
    purgeModal,
    markMergedModal,
    closeLocalModal,
    manualCompleteModal,
    addressCommentsModal,
    updateBranchModal,
    discardPlanModal,
    startAutomaticPrFlowModal,
    stopAutomaticPrFlowModal,
    planActionSubmitting,
    automaticPrFlowSubmitting,
    pullRequestAutoMergeSubmitting,
    sshConnecting,
    planningSettingsSubmitting,
    setDeleteModal,
    setAcceptModal,
    setPurgeModal,
    setMarkMergedModal,
    setCloseLocalModal,
    setManualCompleteModal,
    setAddressCommentsModal,
    setUpdateBranchModal,
    setDiscardPlanModal,
    setStartAutomaticPrFlowModal,
    setStopAutomaticPrFlowModal,
    handleDelete,
    handleAccept,
    handlePush,
    handlePurge,
    handleUpdateBranch,
    handleMarkMerged,
    handleCloseLocal,
    handleManualComplete,
    handleAddressComments,
    handleOpenPullRequest,
    handleEnablePullRequestAutoMerge,
    handleStartAutomaticPrFlow,
    handleStopAutomaticPrFlow,
    handleAcceptPlan,
    handleDiscardPlan,
    handleConnectViaSsh,
    handleOpenTaskFiles,
    handleUpdatePlanningSettings,
  };
}
