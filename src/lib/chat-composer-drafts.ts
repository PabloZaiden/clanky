import { createLogger } from "@pablozaiden/webapp/web";

const log = createLogger("chatComposerDrafts");

const CHAT_COMPOSER_DRAFT_STORAGE_PREFIX = "clanky.chatComposerDraft.v1.";
const CHAT_COMPOSER_DRAFT_VERSION = 1 as const;
const CHAT_COMPOSER_DRAFT_DEBOUNCE_MS = 400;

type DraftTimeoutHandle = number | ReturnType<typeof setTimeout>;
type DraftSetTimeout = (callback: () => void, delay: number) => DraftTimeoutHandle;
type DraftClearTimeout = (timeoutId: DraftTimeoutHandle) => void;

interface StoredChatComposerDraft {
  version: typeof CHAT_COMPOSER_DRAFT_VERSION;
  message: string;
}

export interface ChatComposerDraftStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ChatComposerDraftDependencies {
  storage?: ChatComposerDraftStorageLike;
}

export interface ChatComposerDraftPersistenceDependencies
  extends ChatComposerDraftDependencies {
  setTimeout?: DraftSetTimeout;
  clearTimeout?: DraftClearTimeout;
}

export interface ChatComposerDraftPersistence {
  schedule(message: string): void;
  flush(): void;
  clear(): void;
  cancel(): void;
}

function resolveStorage(
  storage?: ChatComposerDraftStorageLike,
): ChatComposerDraftStorageLike | null {
  if (storage) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch (error) {
    log.warn("Chat composer draft storage is unavailable", {
      error: String(error),
    });
    return null;
  }
}

function getStorageKey(chatId: string): string {
  return `${CHAT_COMPOSER_DRAFT_STORAGE_PREFIX}${encodeURIComponent(chatId)}`;
}

function isStoredChatComposerDraft(value: unknown): value is StoredChatComposerDraft {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate["version"] === CHAT_COMPOSER_DRAFT_VERSION
    && typeof candidate["message"] === "string"
  );
}

function removeStoredDraft(
  storage: ChatComposerDraftStorageLike,
  storageKey: string,
): void {
  try {
    storage.removeItem(storageKey);
  } catch (error) {
    log.warn("Failed to clear chat composer draft", {
      storageKey,
      error: String(error),
    });
  }
}

export function getStoredChatComposerDraft(
  chatId: string,
  dependencies: ChatComposerDraftDependencies = {},
): string | null {
  if (!chatId.trim()) {
    return null;
  }

  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return null;
  }

  const storageKey = getStorageKey(chatId);
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey);
  } catch (error) {
    log.warn("Failed to read chat composer draft", {
      storageKey,
      error: String(error),
    });
    return null;
  }

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredChatComposerDraft(parsed)) {
      log.warn("Removing invalid chat composer draft", {
        storageKey,
      });
      removeStoredDraft(storage, storageKey);
      return null;
    }

    if (!parsed.message.trim()) {
      removeStoredDraft(storage, storageKey);
      return null;
    }

    return parsed.message;
  } catch (error) {
    log.warn("Removing invalid chat composer draft", {
      storageKey,
      error: String(error),
    });
    removeStoredDraft(storage, storageKey);
    return null;
  }
}

export function saveStoredChatComposerDraft(
  chatId: string,
  message: string,
  dependencies: ChatComposerDraftDependencies = {},
): void {
  if (!chatId.trim()) {
    return;
  }

  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return;
  }

  const storageKey = getStorageKey(chatId);
  if (!message.trim()) {
    removeStoredDraft(storage, storageKey);
    return;
  }

  const draft: StoredChatComposerDraft = {
    version: CHAT_COMPOSER_DRAFT_VERSION,
    message,
  };

  try {
    storage.setItem(storageKey, JSON.stringify(draft));
  } catch (error) {
    log.warn("Failed to persist chat composer draft", {
      storageKey,
      error: String(error),
    });
  }
}

export function clearStoredChatComposerDraft(
  chatId: string,
  dependencies: ChatComposerDraftDependencies = {},
): void {
  if (!chatId.trim()) {
    return;
  }

  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return;
  }

  removeStoredDraft(storage, getStorageKey(chatId));
}

export function createChatComposerDraftPersistence(
  chatId: string,
  dependencies: ChatComposerDraftPersistenceDependencies = {},
): ChatComposerDraftPersistence {
  const scheduleTimeout = dependencies.setTimeout ?? globalThis.setTimeout;
  const clearTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout;
  let latestMessage = "";
  let timeoutHandle: DraftTimeoutHandle | null = null;
  let dirty = false;

  function cancelScheduledWrite(): void {
    if (timeoutHandle === null) {
      return;
    }
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }

  function flush(): void {
    cancelScheduledWrite();
    if (!dirty) {
      return;
    }

    dirty = false;
    saveStoredChatComposerDraft(chatId, latestMessage, dependencies);
  }

  return {
    schedule(message: string): void {
      latestMessage = message;
      dirty = true;
      cancelScheduledWrite();
      timeoutHandle = scheduleTimeout(() => {
        timeoutHandle = null;
        flush();
      }, CHAT_COMPOSER_DRAFT_DEBOUNCE_MS);
    },
    flush,
    clear(): void {
      cancelScheduledWrite();
      dirty = false;
      latestMessage = "";
      clearStoredChatComposerDraft(chatId, dependencies);
    },
    cancel: cancelScheduledWrite,
  };
}
