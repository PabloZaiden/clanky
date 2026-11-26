/**
 * Library exports for Clanky frontend.
 */

export {
  clearStoredConversationComposerDraft,
  createConversationComposerDraftPersistence,
  getStoredConversationComposerDraft,
  saveStoredConversationComposerDraft,
  type ConversationComposerDraftDependencies,
  type ConversationComposerDraftPersistence,
  type ConversationComposerDraftPersistenceDependencies,
  type ConversationComposerDraftStorageLike,
} from "./conversation-composer-drafts";
export {
  clearStoredWorkspaceScratchpadDraft,
  createWorkspaceScratchpadDraftPersistence,
  getStoredWorkspaceScratchpadDraft,
  saveStoredWorkspaceScratchpadDraft,
  type WorkspaceScratchpadDraftDependencies,
  type WorkspaceScratchpadDraftPersistence,
  type WorkspaceScratchpadDraftPersistenceDependencies,
  type WorkspaceScratchpadDraftStorageLike,
} from "./workspace-scratchpad-drafts";
export { getWorkspaceServerLabel } from "./workspace-label";
