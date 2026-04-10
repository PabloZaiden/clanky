/**
 * Toast notification components.
 *
 * Provides the visual toast notifications and the ToastProvider
 * that wraps the application to enable the toast system.
 *
 * @module components/common/Toast
 */

import type { ReactNode } from "react";
import { ToastContext, useToastState, type Toast as ToastData } from "../../hooks/useToast";

/**
 * Color classes for error toasts.
 */
const TOAST_STYLES = {
  bg: "bg-neutral-900/95",
  border: "border-red-600/50",
  icon: "text-red-400",
};

/**
 * SVG path for the error toast icon.
 */
const TOAST_ICON = "M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z";

/**
 * A single toast notification item.
 */
function ToastItem({ toast, onDismiss }: { toast: ToastData; onDismiss: (id: string) => void }) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg backdrop-blur-sm max-w-sm animate-slide-in ${TOAST_STYLES.bg} ${TOAST_STYLES.border}`}
    >
      {/* Icon */}
      <svg
        className={`w-5 h-5 flex-shrink-0 mt-0.5 ${TOAST_STYLES.icon}`}
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={TOAST_ICON} />
      </svg>

      {/* Message */}
      <p className="text-sm text-white/90 flex-1 break-words">{toast.message}</p>

      {/* Dismiss button */}
      <button
        onClick={() => onDismiss(toast.id)}
        className="text-white/50 hover:text-white/80 flex-shrink-0 mt-0.5 transition-colors"
        aria-label="Dismiss notification"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Toast container that renders all active toasts.
 * Positioned fixed in the top-right corner.
 */
function ToastContainer({ toasts, onDismiss }: { toasts: ToastData[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none"
    >
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <ToastItem toast={toast} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
}

/**
 * Toast provider component. Wrap your app in this to enable the toast system.
 *
 * Usage:
 * ```tsx
 * <ToastProvider>
 *   <App />
 * </ToastProvider>
 * ```
 *
 * Then in any child component:
 * ```tsx
 * const toast = useToast();
 * toast.error("Something went wrong");
 * ```
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const toastState = useToastState();

  return (
    <ToastContext.Provider value={toastState}>
      {children}
      <ToastContainer toasts={toastState.toasts} onDismiss={toastState.dismiss} />
    </ToastContext.Provider>
  );
}
