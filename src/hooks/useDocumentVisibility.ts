/**
 * Shared, event-driven document visibility for client presentation.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import { isAbortError } from "./request-lifecycle";

const listeners = new Set<() => void>();
const log = createLogger("useDocumentVisibility");
let announcedVisibility: boolean | undefined;

export function isDocumentVisible(): boolean {
  return !document.hidden;
}

function getVisibilitySnapshot(): boolean {
  return announcedVisibility ?? isDocumentVisible();
}

function notifyVisibilityChange(): void {
  announcedVisibility = isDocumentVisible();
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    announcedVisibility = isDocumentVisible();
    document.addEventListener("visibilitychange", notifyVisibilityChange);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", notifyVisibilityChange);
      announcedVisibility = undefined;
    }
  };
}

function getServerSnapshot(): boolean {
  return true;
}

export function useDocumentVisibility(): boolean {
  return useSyncExternalStore(subscribe, getVisibilitySnapshot, getServerSnapshot);
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
    void Promise.resolve()
      .then(() => refreshRef.current())
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }
        log.error("Failed to refresh on foreground", { error: String(error) });
      });
  }, [visible]);
}
