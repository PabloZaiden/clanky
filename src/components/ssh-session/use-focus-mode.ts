import { useCallback, useState } from "react";

const STORAGE_KEY = "clanky-ssh-focus-mode";

function readStoredValue(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function useFocusMode(forcedFocusMode = false) {
  const [storedFocusMode, setStoredFocusMode] = useState(readStoredValue);

  const toggleFocusMode = useCallback(() => {
    if (forcedFocusMode) {
      return;
    }
    setStoredFocusMode((current) => {
      const next = !current;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // localStorage may be unavailable
      }
      return next;
    });
  }, [forcedFocusMode]);

  return { isFocusMode: forcedFocusMode || storedFocusMode, toggleFocusMode } as const;
}
