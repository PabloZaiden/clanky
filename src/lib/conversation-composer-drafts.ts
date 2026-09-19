import { createLogger } from "@pablozaiden/webapp/web";

const log = createLogger("conversationComposerDrafts");

const CONVERSATION_COMPOSER_DRAFT_STORAGE_PREFIX = "clanky.conversationComposerDraft.v1.";
const CONVERSATION_COMPOSER_DRAFT_VERSION = 1 as const;
const CONVERSATION_COMPOSER_DRAFT_DEBOUNCE_MS = 400;

type DraftTimeoutHandle = number | ReturnType<typeof setTimeout>;
type DraftSetTimeout = (callback: () => void, delay: number) => DraftTimeoutHandle;
type DraftClearTimeout = (timeoutId: DraftTimeoutHandle) => void;

interface StoredConversationComposerDraft {
  version: typeof CONVERSATION_COMPOSER_DRAFT_VERSION;
  message: string;
}

export interface ConversationComposerDraftStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ConversationComposerDraftDependencies {
  storage?: ConversationComposerDraftStorageLike;
}

export interface ConversationComposerDraftPersistenceDependencies
  extends ConversationComposerDraftDependencies {
  setTimeout?: DraftSetTimeout;
  clearTimeout?: DraftClearTimeout;
}

export interface ConversationComposerDraftPersistence {
  schedule(message: string): void;
  flush(): void;
  clear(): void;
  cancel(): void;
}

function resolveStorage(
  storage?: ConversationComposerDraftStorageLike,
): ConversationComposerDraftStorageLike | null {
  if (storage) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch (error) {
    log.warn("Conversation composer draft storage is unavailable", {
      error: String(error),
    });
    return null;
  }
}

function getStorageKey(conversationId: string): string {
  return `${CONVERSATION_COMPOSER_DRAFT_STORAGE_PREFIX}${encodeURIComponent(conversationId)}`;
}

function isStoredConversationComposerDraft(
  value: unknown,
): value is StoredConversationComposerDraft {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate["version"] === CONVERSATION_COMPOSER_DRAFT_VERSION
    && typeof candidate["message"] === "string"
  );
}

function removeStoredDraft(
  storage: ConversationComposerDraftStorageLike,
  storageKey: string,
): void {
  try {
    storage.removeItem(storageKey);
  } catch (error) {
    log.warn("Failed to clear conversation composer draft", {
      storageKey,
      error: String(error),
    });
  }
}

export function getStoredConversationComposerDraft(
  conversationId: string,
  dependencies: ConversationComposerDraftDependencies = {},
): string | null {
  if (!conversationId.trim()) {
    return null;
  }

  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return null;
  }

  const storageKey = getStorageKey(conversationId);
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey);
  } catch (error) {
    log.warn("Failed to read conversation composer draft", {
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
    if (!isStoredConversationComposerDraft(parsed)) {
      log.warn("Removing invalid conversation composer draft", {
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
    log.warn("Removing invalid conversation composer draft", {
      storageKey,
      error: String(error),
    });
    removeStoredDraft(storage, storageKey);
    return null;
  }
}

export function saveStoredConversationComposerDraft(
  conversationId: string,
  message: string,
  dependencies: ConversationComposerDraftDependencies = {},
): void {
  if (!conversationId.trim()) {
    return;
  }

  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return;
  }

  const storageKey = getStorageKey(conversationId);
  if (!message.trim()) {
    removeStoredDraft(storage, storageKey);
    return;
  }

  const draft: StoredConversationComposerDraft = {
    version: CONVERSATION_COMPOSER_DRAFT_VERSION,
    message,
  };

  try {
    storage.setItem(storageKey, JSON.stringify(draft));
  } catch (error) {
    log.warn("Failed to persist conversation composer draft", {
      storageKey,
      error: String(error),
    });
  }
}

export function clearStoredConversationComposerDraft(
  conversationId: string,
  dependencies: ConversationComposerDraftDependencies = {},
): void {
  if (!conversationId.trim()) {
    return;
  }

  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return;
  }

  removeStoredDraft(storage, getStorageKey(conversationId));
}

export function createConversationComposerDraftPersistence(
  conversationId: string,
  dependencies: ConversationComposerDraftPersistenceDependencies = {},
): ConversationComposerDraftPersistence {
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
    saveStoredConversationComposerDraft(conversationId, latestMessage, dependencies);
  }

  return {
    schedule(message: string): void {
      latestMessage = message;
      dirty = true;
      cancelScheduledWrite();
      timeoutHandle = scheduleTimeout(() => {
        timeoutHandle = null;
        flush();
      }, CONVERSATION_COMPOSER_DRAFT_DEBOUNCE_MS);
    },
    flush,
    clear(): void {
      cancelScheduledWrite();
      dirty = false;
      latestMessage = "";
      clearStoredConversationComposerDraft(conversationId, dependencies);
    },
    cancel: cancelScheduledWrite,
  };
}
