import type {
  Chat,
  ChatEvent,
  ChatPermissionRequest,
  ChatTranscript,
  MessageData,
  QueuedChatMessage,
  ToolCallData,
} from "@/shared";
import type { VoiceRecorderStatus } from "../../hooks";
import type { MessageAttachment } from "@/shared/message-attachments";
import type {
  ConversationComposerVoice,
} from "../conversation-composer";
import type { TranscriptFileLinkContext } from "../log-viewer";

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
  transcript: ChatTranscript;
  loading: boolean;
  error: string | null;
  isActive: boolean;
  needsSshCredentials: boolean;
  refreshChat: (options?: ChatRefreshOptions) => Promise<void>;
  loadToolCallDetails: (toolCallId: string) => Promise<ToolCallData | null>;
  loadMoreTranscript: () => Promise<void>;
  loadFullTranscript: () => Promise<void>;
  loadingTranscript: boolean;
  applyChatSnapshot: (nextChat: Chat) => void;
  markChatStarting: () => void;
  handleReconnect: () => Promise<void>;
}

export interface ChatTranscriptProps {
  chat: Chat;
  transcript: ChatTranscript;
  lifecycleError: string | null;
  isActive: boolean;
  toolPathDisplayRoot: string;
  fileLinkContext?: TranscriptFileLinkContext;
  onLoadToolDetails: (toolCallId: string) => Promise<ToolCallData | null>;
  onLoadMoreTranscript: () => Promise<void>;
  onLoadFullTranscript: () => Promise<void>;
  loadingTranscript: boolean;
  voiceInput: {
    available: boolean;
    status: VoiceRecorderStatus;
    elapsedMs: number;
    error: string | null;
  };
  onStartVoice: () => Promise<void>;
  onStopVoice: () => void;
  onCancelVoice: () => void;
  onDismissVoiceError: () => void;
  onReadAloud: (message: MessageData, mode: "full" | "summary") => void;
  readAloudAvailable: boolean;
  readAloudSummaryAvailable: boolean;
  playingReadAloudKey: string | null;
  readAloudStatus: "generating" | "playing" | null;
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

export type ChatSendMessageHandler = (options: {
  message?: string;
  attachments: MessageAttachment[];
}) => Promise<Chat>;

export interface ChatComposerAdapterOptions {
  chat: Chat | null;
  chatId: string;
  isEmbedded: boolean;
  isActive: boolean;
  isExternallyBusy?: boolean;
  needsSshCredentials: boolean;
  onChatSnapshot: (nextChat: Chat) => void;
  markChatStarting: () => void;
  refreshChat: (options?: ChatRefreshOptions) => Promise<void>;
  handleReconnect: () => Promise<void>;
  onSendMessage?: ChatSendMessageHandler;
  voice: ConversationComposerVoice;
}
