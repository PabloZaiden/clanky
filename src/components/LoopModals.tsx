/**
 * Shared modal components for loop actions.
 * These are used by both Dashboard and LoopDetails.
 */

import { useState } from "react";
import type { UncommittedChangesError } from "../types";
import { Modal, ConfirmModal, Button } from "./common";

// ============================================================================
// Delete Loop Modal
// ============================================================================

export interface DeleteLoopModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback to delete the loop */
  onDelete: () => Promise<void>;
}

/**
 * Modal for confirming loop deletion.
 */
export function DeleteLoopModal({
  isOpen,
  onClose,
  onDelete,
}: DeleteLoopModalProps) {
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
      title="Delete Loop"
      message="Are you sure you want to delete this loop? The loop will be marked as deleted and can be purged later to permanently remove it."
      confirmLabel="Delete"
      loading={loading}
      variant="danger"
    />
  );
}

// ============================================================================
// Purge Loop Modal
// ============================================================================

export interface PurgeLoopModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback to purge the loop */
  onPurge: () => Promise<void>;
}

/**
 * Modal for confirming loop purge (permanent deletion).
 */
export function PurgeLoopModal({
  isOpen,
  onClose,
  onPurge,
}: PurgeLoopModalProps) {
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
      title="Purge Loop"
      message="Are you sure you want to permanently delete this loop? This will remove all loop data and cannot be undone."
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
  /** Callback to mark the loop as merged */
  onMarkMerged: () => Promise<void>;
}

/**
 * Modal for confirming "mark as merged" action.
 * Used when a loop's branch was merged externally (e.g., via GitHub PR)
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
      message="Use this when the branch was merged externally (for example via a GitHub pull request) and you want Ralph to keep the loop as merged. The loop will stay visible as merged/archived, and follow-up review actions will be disabled."
      confirmLabel="Mark as Merged"
      loading={loading}
      variant="primary"
    />
  );
}

// ============================================================================
// Manual Complete Loop Modal
// ============================================================================

export interface ManualCompleteLoopModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback to manually complete the loop */
  onManualComplete: () => Promise<void>;
}

/**
 * Modal for confirming manual loop completion.
 * Used when a halted loop should be promoted to completed without resuming execution.
 */
export function ManualCompleteLoopModal({
  isOpen,
  onClose,
  onManualComplete,
}: ManualCompleteLoopModalProps) {
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
      title="Manually complete loop"
      message="Use this when the loop was stopped or failed, but you still want Ralph to treat the current branch as completed work. This will unlock the normal push and merge actions without resuming execution."
      confirmLabel="Manually complete loop"
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
 * Used when a pushed loop's working branch needs to be synced with the base branch
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
 * Modal for showing uncommitted changes error when starting a loop.
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
      title="Cannot Start Loop"
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
            Please commit or stash your changes before starting a loop.
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
// Re-export AcceptLoopModal and AddressCommentsModal for convenience
// ============================================================================

export { AcceptLoopModal, type AcceptLoopModalProps } from "./AcceptLoopModal";
export { AddressCommentsModal, type AddressCommentsModalProps } from "./AddressCommentsModal";
