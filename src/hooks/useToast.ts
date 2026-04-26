/**
 * Toast notification context and hook.
 *
 * Provides a simple, app-wide toast notification system.
 * Wrap your app in <ToastProvider> and use the useToast() hook
 * to show notifications.
 *
 * @module hooks/useToast
 */

import { createContext, useCallback, useContext, useRef, useState } from "react";

/**
 * A single toast notification.
 */
export interface Toast {
  /** Unique identifier */
  id: string;
  /** The message to display */
  message: string;
  /** Visual variant for the toast */
  variant: "error" | "success";
  /** Auto-dismiss duration in ms (default: 8000) */
  duration: number;
}

/**
 * Options for showing a toast.
 */
export interface ToastOptions {
  /** Override the auto-dismiss duration in ms */
  duration?: number;
}

/**
 * The toast context value exposed via useToast().
 */
export interface ToastContextValue {
  /** Current list of active toasts */
  toasts: Toast[];
  /** Show an error toast */
  error: (message: string, options?: ToastOptions) => void;
  /** Show a success toast */
  success: (message: string, options?: ToastOptions) => void;
  /** Remove a toast by ID */
  dismiss: (id: string) => void;
}

/** Default duration for toasts */
const DEFAULT_TOAST_DURATION_MS = 8000;

/** Maximum number of toasts shown at once */
const MAX_TOASTS = 5;

/**
 * React context for the toast system.
 * Must be used within a ToastProvider.
 */
export const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Hook to access the toast notification system.
 *
 * @returns Toast context with methods to show/dismiss toasts
 * @throws Error if used outside of ToastProvider
 */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

/**
 * Hook that manages toast state. Used internally by the ToastProvider component.
 * Separated from the component for testability.
 *
 * @returns Toast state and methods
 */
export function useToastState(): ToastContextValue {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (variant: Toast["variant"], message: string, options?: ToastOptions) => {
      counterRef.current += 1;
      const id = `toast-${counterRef.current}-${Date.now()}`;
      const duration = options?.duration ?? DEFAULT_TOAST_DURATION_MS;

      const toast: Toast = { id, message, variant, duration };

      setToasts((prev) => {
        // Keep only the most recent toasts (trim oldest if over limit)
        const next = [...prev, toast];
        if (next.length > MAX_TOASTS) {
          return next.slice(next.length - MAX_TOASTS);
        }
        return next;
      });

      // Auto-dismiss after duration
      if (duration > 0) {
        setTimeout(() => {
          dismiss(id);
        }, duration);
      }
    },
    [dismiss],
  );

  const error = useCallback(
    (message: string, options?: ToastOptions) => showToast("error", message, options),
    [showToast],
  );

  const success = useCallback(
    (message: string, options?: ToastOptions) => showToast("success", message, options),
    [showToast],
  );

  return { toasts, error, success, dismiss };
}
