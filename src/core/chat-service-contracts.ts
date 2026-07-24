/**
 * Contracts shared by the focused chat domain services.
 *
 * These ports keep ChatManager as a composition boundary and prevent
 * extracted services from reaching into one another's private state.
 */

import type {
  Backend,
  BackendConnectionConfig,
  ImportableSession,
  SessionReplayEvent,
} from "../backends/types";
import type {
  Chat,
  ChatConfig,
  ChatPermissionDecision,
  ChatSnapshot,
  ChatState,
  ChatStatus,
  ChatTranscriptPage,
  ChatWorktreeState,
  SessionInfo,
  Task,
  TaskLogEntry,
  ToolCallRecord,
} from "@/shared";
import type { ChatEvent } from "@/shared/events";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import type { Workspace } from "@/shared/workspace";
import type { EventStream } from "../utils/event-stream";
import type { SimpleEventEmitter } from "./event-emitter";

export interface CreateChatOptions {
  name?: string;
  workspaceId: string;
  scope?: ChatConfig["scope"];
  taskId?: string;
  modelProviderID: string;
  modelID: string;
  modelVariant?: string;
  useWorktree?: boolean;
  autoApprovePermissions?: boolean;
  baseBranch?: string;
  directory?: string;
  syncBaseBranch?: boolean;
  prepareWorktreeOnCreate?: boolean;
}

export interface CreateAgentRunChatOptions extends Omit<CreateChatOptions, "scope" | "taskId" | "autoApprovePermissions"> {}

export interface CreateSshServerChatOptions {
  name?: string;
  sshServerId: string;
  directory: string;
  modelProviderID: string;
  modelID: string;
  modelVariant?: string;
  autoApprovePermissions?: boolean;
  credentialToken?: string | null;
}

export interface ImportExistingSessionOptions {
  name?: string;
  workspaceId: string;
  modelProviderID: string;
  modelID: string;
  modelVariant?: string;
  sessionId: string;
  cwd?: string;
  autoApprovePermissions?: boolean;
}

export interface ReconnectChatOptions {
  credentialToken?: string | null;
}

export type ChatConfigUpdates = Partial<
  Omit<ChatConfig, "id" | "createdAt" | "workspaceId" | "mode" | "scope" | "taskId">
>;

export interface ChatMessageOptions {
  message?: string;
  attachments?: MessageImageAttachment[];
}

export interface NormalizedChatMessageInput {
  message: string;
  attachments: MessageImageAttachment[];
}

export interface ChatDirectoryResolution {
  chat: Chat;
  directory: string;
}

export interface ChatStatePort {
  getChat(chatId: string): Promise<Chat | null>;
  getChatSnapshot(chatId: string): Promise<ChatSnapshot | null>;
  getChatTranscriptPage(chatId: string, limit: number, before?: string): Promise<ChatTranscriptPage | null>;
  getChatToolCall(chatId: string, toolCallId: string): Promise<ToolCallRecord | null>;
  getTaskChat(taskId: string): Promise<Chat | null>;
  getAllChats(): Promise<Chat[]>;
  getChatSummaries(): Promise<Chat[]>;
  getChatsByWorkspace(workspaceId: string): Promise<Chat[]>;
  getChatSummariesByWorkspace(workspaceId: string): Promise<Chat[]>;
  getChatSummariesBySshServer(sshServerId: string): Promise<Chat[]>;
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  touchWorkspace(workspaceId: string): Promise<void>;
  getWorkspaceChatNameStats(workspaceId: string, namePrefix: string): Promise<{
    standaloneChatCount: number;
    maxGeneratedSuffix: number;
  }>;
  saveNewChat(chat: Chat): Promise<void>;
  updateConfig(chatId: string, config: ChatConfig): Promise<Chat | null>;
  updateState(chat: Chat, state: ChatState): Promise<Chat>;
  markChatError(chat: Chat, message: string, code?: string): Promise<Chat>;
  deletePersistedChat(chatId: string): Promise<boolean>;
  emitChatCreated(chat: Chat, timestamp: string): void;
  emitChatUpdated(chat: Chat, timestamp?: string): void;
  emitChatDeleted(chat: Chat, timestamp: string): void;
  emit(event: ChatEvent): void;
}

export interface ChatWorktreePort {
  hasEstablishedWorkspaceContext(chat: Chat): boolean;
  resolveWorkingDirectory(
    chat: Chat,
    options: { prepareWorkspace: boolean },
  ): Promise<ChatDirectoryResolution>;
  prepareWorktreeState(chat: Chat, options?: { syncBaseBranch?: boolean }): Promise<ChatWorktreeState>;
  ensureWorktree(chat: Chat): Promise<Chat>;
  prepareWorktreeInBackground(chat: Chat): void;
  cleanupWorktree(chat: Chat): Promise<void>;
}

export interface ChatSessionPort {
  getChatBackend(chatId: string, workspaceId: string): Backend;
  getWorkspaceBackend(workspaceId: string, directory: string): Promise<Backend>;
  listImportableSessions(workspaceId: string): Promise<ImportableSession[]>;
  ensureBackendConnected(chat: Chat, options?: ReconnectChatOptions): Promise<Backend>;
  ensureSession(
    chat: Chat,
    backend: Backend,
    options?: { recreateIfMissing?: boolean },
  ): Promise<Chat>;
  createSession(chat: Chat, backend: Backend, options: { prepareWorkspace: boolean }): Promise<Chat>;
  configureSessionModel(backend: Backend, sessionId: string, desiredModel: string): Promise<void>;
  reconnectSession(chat: Chat, options?: ReconnectChatOptions): Promise<Chat>;
  disconnectChat(chatId: string): Promise<void>;
  buildSshChatConnectionConfig(chat: Chat, password: string): Promise<BackendConnectionConfig>;
}

export interface ChatConversationPort {
  dispatchMessage(
    chat: Chat,
    input: NormalizedChatMessageInput,
    options?: { clearQueuedMessages?: boolean },
  ): Promise<Chat>;
  buildImportedReplayState(chat: Chat, events: SessionReplayEvent[], sessionId: string): ChatState;
  interruptChat(chatId: string, reason?: string): Promise<Chat | null>;
  waitForChatIdle(chatId: string, timeoutMs?: number): Promise<Chat>;
  closeActiveStream(chatId: string): void;
  hasActiveStream(chatId: string): boolean;
  emitChatLog(
    chat: Chat,
    level: TaskLogEntry["level"],
    message: string,
    details?: Record<string, unknown>,
  ): Promise<Chat>;
}

export interface ChatInteractionPort {
  sendMessage(chatId: string, options: ChatMessageOptions): Promise<Chat>;
  removeQueuedMessage(chatId: string, queuedMessageId: string): Promise<Chat | null>;
  replyToPermission(
    chatId: string,
    requestId: string,
    decision: ChatPermissionDecision,
  ): Promise<Chat | null>;
  scheduleQueuedMessageDrain(chatId: string): void;
}

export interface ChatLifecyclePort {
  createChat(options: CreateChatOptions): Promise<Chat>;
  createAgentRunChat(options: CreateAgentRunChatOptions): Promise<Chat>;
  createSshServerChat(options: CreateSshServerChatOptions): Promise<Chat>;
  listImportableSessions(workspaceId: string): Promise<ImportableSession[]>;
  importExistingSession(options: ImportExistingSessionOptions): Promise<Chat>;
  updateChat(chatId: string, updates: ChatConfigUpdates): Promise<Chat | null>;
  updateChatStatus(chatId: string, status: ChatStatus): Promise<Chat | null>;
  attachSession(chatId: string, session: SessionInfo): Promise<Chat | null>;
  getOrCreateTaskChat(taskId: string, task?: Task): Promise<{ chat: Chat; created: boolean }>;
  deleteTaskChat(taskId: string): Promise<boolean>;
  deleteChat(chatId: string): Promise<boolean>;
}

export interface ChatTaskConversionPort {
  spawnTaskFromChat(chatId: string): Promise<Task>;
  spawnTaskFromCurrentPlan(chatId: string, planFilePath?: string): Promise<Task>;
}

export interface ChatServiceBundle {
  state: ChatStatePort;
  lifecycle: ChatLifecyclePort;
  worktree: ChatWorktreePort;
  session: ChatSessionPort;
  conversation: ChatConversationPort;
  interaction: ChatInteractionPort;
  taskConversion: ChatTaskConversionPort;
}

export type ChatEventStream = EventStream<import("../backends/types").AgentEvent>;
export type ChatEventEmitter = SimpleEventEmitter<ChatEvent>;
