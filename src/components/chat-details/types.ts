import type {
  Chat,
  ChatEvent,
  ChatPermissionRequest,
  QueuedChatMessage,
} from "@/shared";
import type { TranscriptFileLinkContext } from "../LogViewer";

export type ChatStreamEvent = Extract<
  ChatEvent,
  {
    type:
      | "chat.status"
      | "chat.message"
      | "chat.message.delta"
      | "chat.tool_call"
      | "chat.tool_call.extra"
      | "chat.log"
      | "chat.log.delta";
  }
>;

export interface ChatRefreshOptions {
  showLoading?: boolean;
}

export interface ChatLifecycleResult {
  chat: Chat | null;
  loading: boolean;
  error: string | null;
  isActive: boolean;
  needsSshCredentials: boolean;
  refreshChat: (options?: ChatRefreshOptions) => Promise<void>;
  applyChatSnapshot: (nextChat: Chat) => void;
  markChatStarting: () => void;
  handleReconnect: () => Promise<void>;
}

export interface ChatTranscriptProps {
  chat: Chat;
  lifecycleError: string | null;
  isActive: boolean;
  toolPathDisplayRoot: string;
  fileLinkContext?: TranscriptFileLinkContext;
}

export interface ChatPermissionPanelProps {
  chatId: string;
  requests: ChatPermissionRequest[];
  onChatSnapshot: (nextChat: Chat) => void;
}

export interface ChatQueuedMessagesPanelProps {
  chatId: string;
  messages: QueuedChatMessage[];
  onChatSnapshot: (nextChat: Chat) => void;
}

export interface ChatComposerProps {
  chat: Chat;
  chatId: string;
  isEmbedded: boolean;
  isActive: boolean;
  needsSshCredentials: boolean;
  onChatSnapshot: (nextChat: Chat) => void;
  markChatStarting: () => void;
  refreshChat: (options?: ChatRefreshOptions) => Promise<void>;
  handleReconnect: () => Promise<void>;
}
