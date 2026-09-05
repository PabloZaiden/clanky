/**
 * Chat persistence layer.
 */

export {
  saveChat,
  loadChat,
  loadChatMetadata,
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
  updateChatConfig,
} from "./chats/index";
export {
  getChatTranscriptMeta,
  replaceChatTranscriptEntries,
  syncChatTranscriptEntries,
  listChatTranscriptEntries,
  getChatToolCallFromTranscript,
} from "./chats/index";
export {
  getActiveChatByDirectory,
  isStaleChatStatus,
  resetStaleChat,
  resetStaleChats,
} from "./chats/index";
