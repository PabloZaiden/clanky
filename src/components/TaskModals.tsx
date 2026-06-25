/**
 * Shared modal components for task actions.
 * These are used by both Dashboard and TaskDetails.
 */

import { useState } from "react";
import type { UncommittedChangesError } from "../types";
import { ConfirmModal, Modal } from "@pablozaiden/webapp/web";
import { Button } from "./common";

// ============================================================================
// Delete Task Modal
// ============================================================================

export interface DeleteTaskModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback to delete the task */
  onDelete: () => Promise<void>;
}

/**
 * Modal for confirming task deletion.
 */
export function DeleteTaskModal({
  isOpen,
  onClose,
  onDelete,
}: DeleteTaskModalProps) {
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await onDelete();
    } finally {
      setLoading(false);
    }
  }

  return (
    <ConfirmModal
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={handleConfirm}
      title="Delete Task"
      message="Are you sure you want to delete this task? The task will be marked as deleted and can be purged later to permanently remove it."
      confirmLabel="Delete"
      loading={loading}
      variant="danger"
    />
  );
}

// ============================================================================
// Purge Task Modal
// ============================================================================

export interface PurgeTaskModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback to purge the task */
  onPurge: () => Promise<void>;
}

/**
 * Modal for confirming task purge (permanent deletion).
 */
export function PurgeTaskModal({
  isOpen,
  onClose,
  onPurge,
}: PurgeTaskModalProps) {
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await onPurge();
    } finally {
      setLoading(false);
    }
  }

  return (
    <ConfirmModal
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={handleConfirm}
      title="Purge Task"
      message="Are you sure you want to permanently delete this task? This will remove all task data and cannot be undone."
      confirmLabel="Purge"
      loading={loading}
      variant="danger"
    />
  );
}

// ============================================================================
// Mark Merged Modal
// ============================================================================

export interface MarkMergedModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback to mark the task as merged */
  onMarkMerged: () => Promise<void>;
}

/**
 * Modal for confirming "mark as merged" action.
 * Used when a task's branch was merged externally (e.g., via GitHub PR)
 * and the user wants to sync their local environment with the merged changes.
 */
export function MarkMergedModal({
  isOpen,
  onClose,
  onMarkMerged,
}: MarkMergedModalProps) {
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await onMarkMerged();
    } finally {
      setLoading(false);
    }
  }

  return (
    <ConfirmModal
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={handleConfirm}
      title="Mark as Merged"
      message="Use this when the branch was merged externally (for example via a GitHub pull request) and you want Clanky to keep the task as merged. The task will stay visible as merged/archived, and follow-up review actions will be disabled."
      confirmLabel="Mark as Merged"
      loading={loading}
      variant="primary"
    />
  );
}

// ============================================================================
// Manual Complete Task Modal
// ============================================================================

export interface ManualCompleteTaskModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback to manually complete the task */
  onManualComplete: () => Promise<void>;
}

/**
 * Modal for confirming manual task completion.
 * Used when a halted task should be promoted to completed without resuming execution.
 */
export function ManualCompleteTaskModal({
  isOpen,
  onClose,
  onManualComplete,
}: ManualCompleteTaskModalProps) {
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await onManualComplete();
    } finally {
      setLoading(false);
    }
  }

  return (
    <ConfirmModal
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={handleConfirm}
      title="Manually complete task"
      message="Use this when the task was stopped or failed, but you still want Clanky to treat the current branch as completed work. This will unlock the normal push and merge actions without resuming execution."
      confirmLabel="Manually complete task"
      loading={loading}
      variant="primary"
    />
  );
}

// ============================================================================
// Update Branch Modal
// ============================================================================

export interface UpdateBranchModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback to update the branch */
  onUpdateBranch: () => Promise<void>;
}

/**
 * Modal for confirming "update branch" action.
 * Used when a pushed task's working branch needs to be synced with the base branch
 * and re-pushed to the remote.
 */
export function UpdateBranchModal({
  isOpen,
  onClose,
  onUpdateBranch,
}: UpdateBranchModalProps) {
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await onUpdateBranch();
    } finally {
      setLoading(false);
    }
  }

  return (
    <ConfirmModal
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={handleConfirm}
      title="Update Branch"
      message="This will sync your working branch with the latest changes from the base branch and push the result to the remote. If there are merge conflicts, they will be resolved automatically."
      confirmLabel="Update Branch"
      loading={loading}
      variant="primary"
    />
  );
}

// ============================================================================
// Uncommitted Changes Modal
// ============================================================================

export interface UncommittedChangesModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** The error containing uncommitted changes info */
  error: UncommittedChangesError | null;
}

/**
 * Modal for showing uncommitted changes error when starting a task.
 * This modal only displays the error - user must manually clean their working directory.
 */
export function UncommittedChangesModal({
  isOpen,
  onClose,
  error,
}: UncommittedChangesModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Cannot Start Task"
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {error && (
        <div>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
            {error.message}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
            Please commit or stash your changes before starting a task.
          </p>
          {error.changedFiles.length > 0 && (
            <div className="bg-gray-50 dark:bg-neutral-900 rounded-md p-3">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Changed files:
              </p>
              <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                {error.changedFiles.slice(0, 10).map((file) => (
                  <li key={file} className="font-mono truncate">
                    {file}
                  </li>
                ))}
                {error.changedFiles.length > 10 && (
                  <li className="text-gray-500">
                    ...and {error.changedFiles.length - 10} more
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ============================================================================
// Re-export AcceptTaskModal and AddressCommentsModal for convenience
// ============================================================================

export { AcceptTaskModal, type AcceptTaskModalProps } from "./AcceptTaskModal";
export { AddressCommentsModal, type AddressCommentsModalProps } from "./AddressCommentsModal";
