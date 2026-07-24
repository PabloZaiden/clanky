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
  listChatsBySshServer,
  listChatSummaries,
  listChatSummariesByWorkspace,
  listChatSummariesBySshServer,
  createChatListSnapshot,
  getWorkspaceChatNameStats,
  chatExists,
} from "./chats/index";
export {
  updateChatState,
  updateChatConfig,
} from "./chats/index";
export {
  countChatTranscriptEntries,
  getChatTranscriptMeta,
  migrateLegacyChatTranscripts,
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
