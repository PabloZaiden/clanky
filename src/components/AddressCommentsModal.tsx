/**
 * AddressCommentsModal component for submitting reviewer comments to a pushed/merged loop.
 * Allows users to provide feedback that the loop will address.
 */

import { useRef, useState, type ClipboardEvent } from "react";
import { Modal, Button } from "./common";
import { log } from "../lib/logger";
import type { ComposerImageAttachment, MessageImageAttachment } from "../types/message-attachments";
import {
  ImageAttachmentControl,
  type ImageAttachmentControlHandle,
} from "./ImageAttachmentControl";
import { toMessageImageAttachments } from "../lib/image-attachments";

const ADDRESS_UNRESOLVED_PR_COMMENTS_PROMPT =
  "Find the PR associated to this branch and address the unresolved comments";

export interface AddressCommentsModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback to submit comments */
  onSubmit: (comments: string, attachments?: MessageImageAttachment[]) => Promise<void>;
  /** Name of the loop */
  loopName: string;
  /** Current review cycle number */
  reviewCycle: number;
}

/**
 * AddressCommentsModal provides UI for submitting reviewer comments.
 */
export function AddressCommentsModal({
  isOpen,
  onClose,
  onSubmit,
  loopName,
  reviewCycle,
}: AddressCommentsModalProps) {
  const [comments, setComments] = useState("");
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const attachmentControlRef = useRef<ImageAttachmentControlHandle>(null);

  function handleInsertPrPrompt() {
    setComments((current) => {
      if (current.includes(ADDRESS_UNRESOLVED_PR_COMMENTS_PROMPT)) {
        return current;
      }
      if (!current.trim()) {
        return ADDRESS_UNRESOLVED_PR_COMMENTS_PROMPT;
      }
      return `${current.trim()}\n\n${ADDRESS_UNRESOLVED_PR_COMMENTS_PROMPT}`;
    });
  }

  async function handleSubmit() {
    if (!comments.trim()) {
      return;
    }

    setSubmitting(true);
    try {
      if (attachments.length > 0) {
        await onSubmit(comments, toMessageImageAttachments(attachments));
      } else {
        await onSubmit(comments);
      }
      // Clear comments and close modal on success
      setComments("");
      setAttachments([]);
      onClose();
    } catch (error) {
      // Keep modal open on error so user can retry
      log.error("Failed to submit comments:", error);
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose() {
    if (!submitting) {
      setComments("");
      setAttachments([]);
      onClose();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    attachmentControlRef.current?.handlePaste(event);
  }

  const isValid = comments.trim().length > 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Address Reviewer Comments"
      description={`Submit feedback for "${loopName}" (Review Cycle ${reviewCycle})`}
      size="lg"
      closeOnOverlayClick={!submitting}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={handleClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={!isValid}
          >
            Submit Comments
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label
            htmlFor="reviewer-comments"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
          >
            Reviewer Comments
          </label>
          <div className="mb-2 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleInsertPrPrompt}
              disabled={submitting}
            >
              Insert PR review prompt
            </Button>
          </div>
          <textarea
            id="reviewer-comments"
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            onPaste={handlePaste}
            placeholder="Enter your review comments here. Be specific about what needs to be changed or improved..."
            rows={10}
            disabled={submitting}
            className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-neutral-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            The loop will restart and address these comments by making targeted changes to the code.
          </p>
          <div className="mt-3">
            <ImageAttachmentControl
              ref={attachmentControlRef}
              attachments={attachments}
              onChange={setAttachments}
              disabled={submitting}
              iconOnly
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default AddressCommentsModal;
