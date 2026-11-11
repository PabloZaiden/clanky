import { useCallback, useState } from "react";
import { getDemoStorage } from "@/client-sdk/demo/storage";

const STORAGE_KEY = "clanky-terminal-focus-mode";

function readStoredValue(): boolean {
  try {
    return (getDemoStorage() ?? localStorage).getItem(STORAGE_KEY) !== "false";
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
        (getDemoStorage() ?? localStorage).setItem(STORAGE_KEY, String(next));
      } catch {
        // localStorage may be unavailable
      }
      return next;
    });
  }, [forcedFocusMode]);

  return { isFocusMode: forcedFocusMode || storedFocusMode, toggleFocusMode } as const;
}
