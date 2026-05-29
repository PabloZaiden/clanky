/**
 * AcceptTaskModal component for finalizing a completed task.
 * Offers choice between accepting locally or pushing to remote.
 */

import { useState } from "react";
import { Modal, Button } from "./common";
import { createLogger } from "../lib/logger";

const log = createLogger("AcceptTaskModal");

export interface AcceptTaskModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Branch containing the committed task changes */
  acceptedBranch?: string;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback to accept the task locally */
  onAccept: () => Promise<void>;
  /** Callback to push the task to remote */
  onPush: () => Promise<void>;
  /** Whether pushing to the origin remote is available */
  canPushToRemote?: boolean;
  /** Whether remote availability is still being checked */
  remoteStatusLoading?: boolean;
}

/**
 * AcceptTaskModal provides UI for finalizing a completed task.
 * Users can choose between keeping commits local or pushing to remote for PR.
 */
export function AcceptTaskModal({
  isOpen,
  acceptedBranch,
  onClose,
  onAccept,
  onPush,
  canPushToRemote = true,
  remoteStatusLoading = false,
}: AcceptTaskModalProps) {
  const [accepting, setAccepting] = useState(false);
  const [pushing, setPushing] = useState(false);

  const isLoading = accepting || pushing;
  const showPushOption = canPushToRemote || remoteStatusLoading;

  async function handleAccept() {
    log.debug("User chose to accept task locally");
    setAccepting(true);
    try {
      await onAccept();
      log.info("Task accepted locally");
    } finally {
      setAccepting(false);
    }
  }

  async function handlePush() {
    log.debug("User chose to push task to remote");
    setPushing(true);
    try {
      await onPush();
      log.info("Task pushed to remote successfully");
    } finally {
      setPushing(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Finalize Task"
      description="Choose whether to keep this task committed locally or push it for PR review."
      size="md"
      footer={
        <Button
          variant="ghost"
          onClick={onClose}
          disabled={isLoading}
        >
          Cancel
        </Button>
      }
    >
      <div className="space-y-3">
        {acceptedBranch && (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            The committed changes are on branch <code className="font-mono">{acceptedBranch}</code>.
          </p>
        )}

        {showPushOption ? (
          <button
            onClick={handlePush}
            disabled={isLoading || remoteStatusLoading}
            className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-100 dark:bg-neutral-800 flex items-center justify-center">
              {pushing || remoteStatusLoading ? (
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-500 border-t-transparent" />
              ) : (
                <span className="text-blue-600 dark:text-blue-400 text-sm">↑</span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {remoteStatusLoading ? (
                  "Checking Remote..."
                ) : (
                  <>
                    Push to Remote <span className="text-gray-500 dark:text-gray-400 font-normal">(recommended)</span>
                  </>
                )}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {remoteStatusLoading
                  ? "Checking whether an origin remote is configured for this repository."
                  : "Push the working branch to remote. Create a PR for code review or update an existing one."}
              </div>
            </div>
            {!remoteStatusLoading && <span className="text-gray-400 dark:text-gray-500">→</span>}
          </button>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
            No origin remote is configured for this repository, so this task can only be accepted locally.
          </div>
        )}

        <button
          onClick={handleAccept}
          disabled={isLoading}
          className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
            {accepting ? (
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-green-500 border-t-transparent" />
            ) : (
              <span className="text-green-600 dark:text-green-400 text-sm">✓</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Accept Locally</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Keep the task commits locally without pushing. You can still address follow-up comments later.
            </div>
          </div>
          <span className="text-gray-400 dark:text-gray-500">→</span>
        </button>
      </div>
    </Modal>
  );
}

export default AcceptTaskModal;
