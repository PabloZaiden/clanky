import { useCallback, useEffect, useMemo, useState } from "react";
import { createLogger } from "../lib/logger";

const log = createLogger("usePrivateItemsPreference");
const PRIVATE_ITEMS_STORAGE_KEY = "clanky.showPrivateItems";

export interface PrivateItemsPreference {
  showPrivateItems: boolean;
  setShowPrivateItems: (showPrivateItems: boolean) => void;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch (error) {
    log.warn("Private items preference storage is unavailable", { error: String(error) });
    return null;
  }
}

function loadShowPrivateItems(): boolean {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  try {
    return storage.getItem(PRIVATE_ITEMS_STORAGE_KEY) === "true";
  } catch (error) {
    log.warn("Failed to load private items preference", { error: String(error) });
    return false;
  }
}

function saveShowPrivateItems(showPrivateItems: boolean): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    if (showPrivateItems) {
      storage.setItem(PRIVATE_ITEMS_STORAGE_KEY, "true");
      return;
    }
    storage.removeItem(PRIVATE_ITEMS_STORAGE_KEY);
  } catch (error) {
    log.warn("Failed to persist private items preference", { error: String(error) });
  }
}

export function usePrivateItemsPreference(): PrivateItemsPreference {
  const [showPrivateItems, setShowPrivateItemsState] = useState(loadShowPrivateItems);

  useEffect(() => {
    saveShowPrivateItems(showPrivateItems);
  }, [showPrivateItems]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== PRIVATE_ITEMS_STORAGE_KEY) {
        return;
      }
      setShowPrivateItemsState(event.newValue === "true");
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setShowPrivateItems = useCallback((nextShowPrivateItems: boolean) => {
    setShowPrivateItemsState(nextShowPrivateItems);
  }, []);

  return useMemo(() => ({
    showPrivateItems,
    setShowPrivateItems,
  }), [setShowPrivateItems, showPrivateItems]);
}
