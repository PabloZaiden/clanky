import { useCallback, useEffect, useState } from "react";

export const SIDEBAR_PINNED_ITEMS_STORAGE_KEY = "clanky.sidebarPinnedItems";

export type SidebarPinnedItemKind = "workspace" | "task" | "chat" | "ssh-server" | "ssh-session";

export interface SidebarPinnedItem {
  kind: SidebarPinnedItemKind;
  id: string;
}

export interface SidebarPinningState {
  pinnedItems: SidebarPinnedItem[];
  isPinned: (item: SidebarPinnedItem) => boolean;
  pinItem: (item: SidebarPinnedItem) => void;
  unpinItem: (item: SidebarPinnedItem) => void;
  togglePinned: (item: SidebarPinnedItem) => void;
}

export const EMPTY_SIDEBAR_PINNING_STATE: SidebarPinningState = {
  pinnedItems: [],
  isPinned: () => false,
  pinItem: () => {},
  unpinItem: () => {},
  togglePinned: () => {},
};

const PINNED_ITEM_KINDS: ReadonlySet<string> = new Set([
  "workspace",
  "task",
  "chat",
  "ssh-server",
  "ssh-session",
]);

function getSidebarPinnedItemsStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getSidebarPinnedItemKey(item: SidebarPinnedItem): string {
  return `${item.kind}:${item.id}`;
}

function isSidebarPinnedItem(value: unknown): value is SidebarPinnedItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate["kind"] === "string"
    && PINNED_ITEM_KINDS.has(candidate["kind"])
    && typeof candidate["id"] === "string"
    && candidate["id"].length > 0;
}

function normalizeSidebarPinnedItems(value: unknown): SidebarPinnedItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: SidebarPinnedItem[] = [];
  for (const item of value) {
    if (!isSidebarPinnedItem(item)) {
      continue;
    }
    const normalizedItem = { kind: item.kind, id: item.id };
    const key = getSidebarPinnedItemKey(normalizedItem);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(normalizedItem);
  }
  return normalized;
}

export function loadSidebarPinnedItems(): SidebarPinnedItem[] {
  const storage = getSidebarPinnedItemsStorage();
  if (!storage) {
    return [];
  }

  const raw = storage.getItem(SIDEBAR_PINNED_ITEMS_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    return normalizeSidebarPinnedItems(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveSidebarPinnedItems(items: SidebarPinnedItem[]): void {
  const storage = getSidebarPinnedItemsStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(SIDEBAR_PINNED_ITEMS_STORAGE_KEY, JSON.stringify(normalizeSidebarPinnedItems(items)));
  } catch (error) {
    console.warn("Failed to save sidebar pinned items", error);
  }
}

export function useSidebarPinnedItems(): SidebarPinningState {
  const [pinnedItems, setPinnedItems] = useState<SidebarPinnedItem[]>(() => loadSidebarPinnedItems());

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === SIDEBAR_PINNED_ITEMS_STORAGE_KEY) {
        setPinnedItems(loadSidebarPinnedItems());
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const isPinned = useCallback((item: SidebarPinnedItem) => {
    const key = getSidebarPinnedItemKey(item);
    return pinnedItems.some((pinnedItem) => getSidebarPinnedItemKey(pinnedItem) === key);
  }, [pinnedItems]);

  const updatePinnedItems = useCallback((updater: (items: SidebarPinnedItem[]) => SidebarPinnedItem[]) => {
    setPinnedItems((current) => {
      const next = normalizeSidebarPinnedItems(updater(current));
      saveSidebarPinnedItems(next);
      return next;
    });
  }, []);

  const pinItem = useCallback((item: SidebarPinnedItem) => {
    updatePinnedItems((current) => (
      current.some((pinnedItem) => getSidebarPinnedItemKey(pinnedItem) === getSidebarPinnedItemKey(item))
        ? current
        : [...current, item]
    ));
  }, [updatePinnedItems]);

  const unpinItem = useCallback((item: SidebarPinnedItem) => {
    const key = getSidebarPinnedItemKey(item);
    updatePinnedItems((current) => current.filter((pinnedItem) => getSidebarPinnedItemKey(pinnedItem) !== key));
  }, [updatePinnedItems]);

  const togglePinned = useCallback((item: SidebarPinnedItem) => {
    if (isPinned(item)) {
      unpinItem(item);
      return;
    }
    pinItem(item);
  }, [isPinned, pinItem, unpinItem]);

  return {
    pinnedItems,
    isPinned,
    pinItem,
    unpinItem,
    togglePinned,
  };
}
