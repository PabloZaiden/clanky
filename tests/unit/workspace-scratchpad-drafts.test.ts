import { expect, test } from "bun:test";
import {
  clearStoredWorkspaceScratchpadDraft,
  createWorkspaceScratchpadDraftPersistence,
  getStoredWorkspaceScratchpadDraft,
  saveStoredWorkspaceScratchpadDraft,
  type WorkspaceScratchpadDraftStorageLike,
} from "../../src/lib/workspace-scratchpad-drafts";

test("restores drafts per workspace and clears only the saved workspace draft", () => {
  // Unsaved Markdown recovery is a data-safety contract not covered by UI tests.
  const entries = new Map<string, string>();
  const storage: WorkspaceScratchpadDraftStorageLike = {
    getItem(key) {
      return entries.get(key) ?? null;
    },
    setItem(key, value) {
      entries.set(key, value);
    },
    removeItem(key) {
      entries.delete(key);
    },
  };
  const workspaceDraft = "# Workspace notes\n";

  saveStoredWorkspaceScratchpadDraft("workspace-a", workspaceDraft, { storage });
  saveStoredWorkspaceScratchpadDraft("workspace-b", "", { storage });

  expect(getStoredWorkspaceScratchpadDraft("workspace-a", { storage })).toBe(workspaceDraft);
  expect(getStoredWorkspaceScratchpadDraft("workspace-b", { storage })).toBe("");

  clearStoredWorkspaceScratchpadDraft("workspace-a", { storage });

  expect(getStoredWorkspaceScratchpadDraft("workspace-a", { storage })).toBeNull();
  expect(getStoredWorkspaceScratchpadDraft("workspace-b", { storage })).toBe("");
});

test("debounces draft writes and flushes the latest content when requested", () => {
  const entries = new Map<string, string>();
  const storage: WorkspaceScratchpadDraftStorageLike = {
    getItem(key) {
      return entries.get(key) ?? null;
    },
    setItem(key, value) {
      entries.set(key, value);
    },
    removeItem(key) {
      entries.delete(key);
    },
  };
  const timers = new Map<number, () => void>();
  let nextTimerId = 0;
  const persistence = createWorkspaceScratchpadDraftPersistence("workspace-a", {
    storage,
    setTimeout(callback) {
      const timerId = ++nextTimerId;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout(timerId) {
      if (typeof timerId === "number") {
        timers.delete(timerId);
      }
    },
  });

  persistence.schedule("# First edit");
  persistence.schedule("# Latest edit");
  expect(getStoredWorkspaceScratchpadDraft("workspace-a", { storage })).toBeNull();

  const pendingWrite = [...timers.values()][0];
  if (!pendingWrite) {
    throw new Error("Debounced Scratchpad write was not scheduled");
  }
  pendingWrite();
  expect(getStoredWorkspaceScratchpadDraft("workspace-a", { storage })).toBe("# Latest edit");

  persistence.schedule("# Flush before navigation");
  persistence.flush();
  expect(getStoredWorkspaceScratchpadDraft("workspace-a", { storage })).toBe("# Flush before navigation");
});
