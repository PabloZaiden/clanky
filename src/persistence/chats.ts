/**
 * Chat persistence layer.
 */

export {
  saveChat,
  loadChat,
  loadChatMetadata,
  loadChatStreamControlState,
  loadTaskChat,
  deleteChat,
  deleteChatsByTaskId,
  listChats,
  listChatsByWorkspace,
  listChatSummaries,
  listChatSummariesByWorkspace,
  createChatListSnapshot,
  getWorkspaceChatNameStats,
  chatExists,
} from "./chats/index";
export {
  updateChatState,
  updateChatStreamState,
  updateChatConfig,
} from "./chats/index";
export {
  getChatTranscriptMeta,
  replaceChatTranscriptEntries,
  syncChatTranscriptEntries,
  listChatTranscriptEntries,
  listChatTranscriptEntriesAfter,
  listChatTranscriptEntriesPage,
  getChatMessageFromTranscript,
  getChatToolCallFromTranscript,
} from "./chats/index";
export {
  getActiveChatByDirectory,
  isStaleChatStatus,
  resetStaleChat,
  resetStaleChats,
} from "./chats/index";
export { listChatTrash, loadTrashedChat, markChatTrashed, restoreTrashedChat, deleteTrashedChat, saveTrashedChatWorktree, listTrashCleanupCandidates } from "./chats/index";
