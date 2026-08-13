import { describe, expect, test } from "bun:test";
import {
  clearStoredChatComposerDraft,
  createChatComposerDraftPersistence,
  getStoredChatComposerDraft,
  saveStoredChatComposerDraft,
  type ChatComposerDraftStorageLike,
} from "../../src/lib/chat-composer-drafts";

class MemoryStorage implements ChatComposerDraftStorageLike {
  private readonly values = new Map<string, string>();
  setCalls = 0;
  removeCalls = 0;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.setCalls += 1;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.removeCalls += 1;
    this.values.delete(key);
  }
}

describe("chat composer drafts", () => {
  test("round-trips a non-empty draft for one chat", () => {
    const storage = new MemoryStorage();
    const message = "  Keep this message\nwith its formatting.  ";

    saveStoredChatComposerDraft("chat-1", message, { storage });

    expect(getStoredChatComposerDraft("chat-1", { storage })).toBe(message);
    expect(getStoredChatComposerDraft("chat-2", { storage })).toBeNull();
  });

  test("removes drafts when the message becomes empty", () => {
    const storage = new MemoryStorage();
    saveStoredChatComposerDraft("chat-1", "draft", { storage });

    saveStoredChatComposerDraft("chat-1", " \n ", { storage });

    expect(getStoredChatComposerDraft("chat-1", { storage })).toBeNull();
    expect(storage.removeCalls).toBe(1);
  });

  test("removes malformed stored data instead of throwing", () => {
    const storage: ChatComposerDraftStorageLike = {
      getItem: () => "{not valid json",
      setItem: () => {},
      removeItem: () => {},
    };

    expect(() => getStoredChatComposerDraft("chat-1", { storage })).not.toThrow();
    expect(getStoredChatComposerDraft("chat-1", { storage })).toBeNull();
  });

  test("does not write on schedule until the debounce is flushed", () => {
    const storage = new MemoryStorage();
    const persistence = createChatComposerDraftPersistence("chat-1", {
      storage,
      setTimeout: () => 1,
      clearTimeout: () => {},
    });

    persistence.schedule("first");
    persistence.schedule("latest");

    expect(storage.setCalls).toBe(0);

    persistence.flush();

    expect(storage.setCalls).toBe(1);
    expect(getStoredChatComposerDraft("chat-1", { storage })).toBe("latest");
  });

  test("clears the stored draft without waiting for a timer", () => {
    const storage = new MemoryStorage();
    saveStoredChatComposerDraft("chat-1", "draft", { storage });
    const persistence = createChatComposerDraftPersistence("chat-1", {
      storage,
      setTimeout: () => 1,
      clearTimeout: () => {},
    });

    persistence.schedule("draft");
    persistence.clear();

    expect(getStoredChatComposerDraft("chat-1", { storage })).toBeNull();
  });

  test("tolerates storage failures", () => {
    const storage: ChatComposerDraftStorageLike = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
      removeItem: () => {
        throw new Error("storage unavailable");
      },
    };

    expect(() => getStoredChatComposerDraft("chat-1", { storage })).not.toThrow();
    expect(() => saveStoredChatComposerDraft("chat-1", "draft", { storage })).not.toThrow();
    expect(() => clearStoredChatComposerDraft("chat-1", { storage })).not.toThrow();
  });
});
