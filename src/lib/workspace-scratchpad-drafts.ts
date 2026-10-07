import { createLogger } from "@pablozaiden/webapp/web";

const log = createLogger("workspaceScratchpadDrafts");

const WORKSPACE_SCRATCHPAD_DRAFT_STORAGE_PREFIX = "clanky.workspaceScratchpadDraft.v1.";
const WORKSPACE_SCRATCHPAD_DRAFT_VERSION = 1 as const;

interface StoredWorkspaceScratchpadDraft {
  version: typeof WORKSPACE_SCRATCHPAD_DRAFT_VERSION;
  content: string;
}

export interface WorkspaceScratchpadDraftStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WorkspaceScratchpadDraftDependencies {
  storage?: WorkspaceScratchpadDraftStorageLike;
}

function resolveStorage(
  storage?: WorkspaceScratchpadDraftStorageLike,
): WorkspaceScratchpadDraftStorageLike | null {
  if (storage) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch (error) {
    log.warn("Workspace Scratchpad draft storage is unavailable", {
      error: String(error),
    });
    return null;
  }
}

function getStorageKey(workspaceId: string): string {
  return `${WORKSPACE_SCRATCHPAD_DRAFT_STORAGE_PREFIX}${encodeURIComponent(workspaceId)}`;
}

function isStoredWorkspaceScratchpadDraft(
  value: unknown,
): value is StoredWorkspaceScratchpadDraft {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate["version"] === WORKSPACE_SCRATCHPAD_DRAFT_VERSION
    && typeof candidate["content"] === "string";
}

function removeStoredDraft(
  storage: WorkspaceScratchpadDraftStorageLike,
  storageKey: string,
): void {
  try {
    storage.removeItem(storageKey);
  } catch (error) {
    log.warn("Failed to clear workspace Scratchpad draft", {
      storageKey,
      error: String(error),
    });
  }
}

export function getStoredWorkspaceScratchpadDraft(
  workspaceId: string,
  dependencies: WorkspaceScratchpadDraftDependencies = {},
): string | null {
  if (!workspaceId.trim()) {
    return null;
  }

  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return null;
  }

  const storageKey = getStorageKey(workspaceId);
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey);
  } catch (error) {
    log.warn("Failed to read workspace Scratchpad draft", {
      storageKey,
      error: String(error),
    });
    return null;
  }

  if (raw === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredWorkspaceScratchpadDraft(parsed)) {
      log.warn("Removing invalid workspace Scratchpad draft", { storageKey });
      removeStoredDraft(storage, storageKey);
      return null;
    }
    return parsed.content;
  } catch (error) {
    log.warn("Removing invalid workspace Scratchpad draft", {
      storageKey,
      error: String(error),
    });
    removeStoredDraft(storage, storageKey);
    return null;
  }
}

export function saveStoredWorkspaceScratchpadDraft(
  workspaceId: string,
  content: string,
  dependencies: WorkspaceScratchpadDraftDependencies = {},
): void {
  if (!workspaceId.trim()) {
    return;
  }

  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return;
  }

  const draft: StoredWorkspaceScratchpadDraft = {
    version: WORKSPACE_SCRATCHPAD_DRAFT_VERSION,
    content,
  };

  try {
    storage.setItem(getStorageKey(workspaceId), JSON.stringify(draft));
  } catch (error) {
    log.warn("Failed to persist workspace Scratchpad draft", {
      workspaceId,
      error: String(error),
    });
  }
}

export function clearStoredWorkspaceScratchpadDraft(
  workspaceId: string,
  dependencies: WorkspaceScratchpadDraftDependencies = {},
): void {
  if (!workspaceId.trim()) {
    return;
  }

  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return;
  }

  removeStoredDraft(storage, getStorageKey(workspaceId));
}
