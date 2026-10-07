import { expect, test } from "bun:test";
import {
  clearStoredWorkspaceScratchpadDraft,
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
