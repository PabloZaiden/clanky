/**
 * AcceptLoopModal component for finalizing a completed loop.
 * Offers choice between accepting locally or pushing to remote.
 */

import { useState } from "react";
import { Modal, Button } from "./common";
import { createLogger } from "../lib/logger";

const log = createLogger("AcceptLoopModal");

export interface AcceptLoopModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback to accept the loop locally */
  onAccept: () => Promise<void>;
  /** Callback to push the loop to remote */
  onPush: () => Promise<void>;
}

/**
 * AcceptLoopModal provides UI for finalizing a completed loop.
 * Users can choose between keeping commits local or pushing to remote for PR.
 */
export function AcceptLoopModal({
  isOpen,
  onClose,
  onAccept,
  onPush,
}: AcceptLoopModalProps) {
  const [accepting, setAccepting] = useState(false);
  const [pushing, setPushing] = useState(false);

  const isLoading = accepting || pushing;

  async function handleAccept() {
    log.debug("User chose to accept loop locally");
    setAccepting(true);
    try {
      await onAccept();
      log.info("Loop accepted locally");
    } finally {
      setAccepting(false);
    }
  }

  async function handlePush() {
    log.debug("User chose to push loop to remote");
    setPushing(true);
    try {
      await onPush();
      log.info("Loop pushed to remote successfully");
    } finally {
      setPushing(false);
    }
  }

  return (
      <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Finalize Loop"
      description="Choose whether to keep this loop committed locally or push it for PR review."
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
      <div className="space-y-2">
        <button
            onClick={handlePush}
            disabled={isLoading}
            className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-100 dark:bg-neutral-800 flex items-center justify-center">
              {pushing ? (
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-500 border-t-transparent" />
              ) : (
                <span className="text-blue-600 dark:text-blue-400 text-sm">↑</span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Push to Remote <span className="text-gray-500 dark:text-gray-400 font-normal">(recommended)</span>
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Push the working branch to remote. Create a PR for code review or update an existing one.
              </div>
            </div>
            <span className="text-gray-400 dark:text-gray-500">→</span>
        </button>

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
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Accept Local</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Keep the loop commits locally without pushing. You can still address follow-up comments later.
              </div>
            </div>
            <span className="text-gray-400 dark:text-gray-500">→</span>
        </button>
      </div>
    </Modal>
  );
}

export default AcceptLoopModal;
