import { useCallback, useState } from "react";

const STORAGE_KEY = "clanky-task-log-focus-mode";

function readStoredValue(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function useLogFocusMode() {
  const [isFocusMode, setIsFocusMode] = useState(readStoredValue);

  const toggleFocusMode = useCallback(() => {
    setIsFocusMode((current) => {
      const next = !current;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // localStorage may be unavailable
      }
      return next;
    });
  }, []);

  return { isFocusMode, toggleFocusMode } as const;
}
