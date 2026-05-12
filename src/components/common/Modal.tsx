/**
 * Modal component for overlays and dialogs.
 */

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./Button";

/** Selector for all focusable elements within a container. */
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Modal title */
  title: string;
  /** Modal description */
  description?: string;
  /** Modal content */
  children: ReactNode;
  /** Footer content (buttons, etc.) */
  footer?: ReactNode;
  /** Size of the modal */
  size?: "sm" | "md" | "lg" | "xl";
  /** Whether to show close button */
  showCloseButton?: boolean;
  /** Whether clicking overlay closes modal */
  closeOnOverlayClick?: boolean;
}

const sizeClasses = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
};

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  showCloseButton = true,
  closeOnOverlayClick = true,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);
  const titleId = useId();

  // Handle keyboard events (escape + focus trap).
  // Uses a ref to always read the latest onClose, avoiding effect re-runs
  // when the onClose reference changes on re-render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const currentModal = modalRef.current;
      const openModals = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']"));
      const topmostModal = openModals[openModals.length - 1];
      if (!currentModal || currentModal !== topmostModal) {
        return;
      }

      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }

      // Focus trap: cycle Tab/Shift+Tab within modal
      if (e.key === "Tab") {
        const focusable = currentModal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (focusable.length === 0) return;

        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    },
    [] // Stable reference — reads onClose from ref
  );

  // Add/remove keyboard listener, manage focus
  useEffect(() => {
    if (isOpen) {
      // Save the currently focused element to restore later
      previousFocusRef.current = document.activeElement;

      document.addEventListener("keydown", handleKeyDown);
      // Prevent body scroll
      document.body.style.overflow = "hidden";

      // Auto-focus the modal container so keyboard navigation works
      // immediately. Individual modal consumers can override focus.
      if (modalRef.current) {
        modalRef.current.focus();
      }
    }

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";

      // Restore focus to the previously focused element
      if (previousFocusRef.current instanceof HTMLElement) {
        previousFocusRef.current.focus();
      }
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex min-w-0 items-center justify-center overflow-x-hidden overflow-y-auto p-2 sm:p-4">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={closeOnOverlayClick ? onClose : undefined}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        ref={modalRef}
        tabIndex={-1}
        className={`relative flex w-full min-w-0 ${sizeClasses[size]} max-h-[calc(100vh-1.5rem)] max-h-[calc(100dvh-1.5rem)] flex-col overflow-hidden rounded-lg bg-white shadow-xl sm:max-h-[calc(100vh-2.5rem)] sm:max-h-[calc(100dvh-2.5rem)] dark:bg-neutral-800`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-gray-200 px-4 sm:px-6 py-3 sm:py-4 dark:border-gray-700 flex-shrink-0">
          <div className="flex-1 min-w-0 pr-2">
            <h2
              id={titleId}
              className="text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100"
            >
              {title}
            </h2>
            {description && (
              <p className="mt-1 text-xs sm:text-sm text-gray-500 dark:text-gray-400">
                {description}
              </p>
            )}
          </div>
          {showCloseButton && (
            <button
              type="button"
              onClick={onClose}
              className="flex-shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-500 dark:hover:bg-neutral-700 dark:hover:text-gray-300"
              aria-label="Close"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>

        {/* Content - scrollable */}
        <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-3 sm:px-6 sm:py-4">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2 sm:gap-3 border-t border-gray-200 px-4 sm:px-6 py-3 sm:py-4 dark:border-gray-700 flex-shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Confirmation modal for destructive actions.
 */
export interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  variant?: "danger" | "primary";
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  loading = false,
  variant = "danger",
}: ConfirmModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-gray-600 dark:text-gray-300">{message}</p>
    </Modal>
  );
}

export default Modal;
