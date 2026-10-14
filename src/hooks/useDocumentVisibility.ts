/**
 * Shared, event-driven document visibility for client presentation.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

export function isDocumentVisible(): boolean {
  return !document.hidden;
}

function notifyVisibilityChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    document.addEventListener("visibilitychange", notifyVisibilityChange);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", notifyVisibilityChange);
    }
  };
}

function getServerSnapshot(): boolean {
  return true;
}

export function useDocumentVisibility(): boolean {
  return useSyncExternalStore(subscribe, isDocumentVisible, getServerSnapshot);
}

export function useRefreshOnForeground(refresh: () => void | Promise<void>): void {
  const visible = useDocumentVisibility();
  const refreshRef = useRef(refresh);
  const wasVisibleRef = useRef(visible);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!visible) {
      wasVisibleRef.current = false;
      return;
    }
    if (wasVisibleRef.current) {
      return;
    }

    wasVisibleRef.current = true;
    void refreshRef.current();
  }, [visible]);
}
