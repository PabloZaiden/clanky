/**
 * Contracts shared by the focused chat domain services.
 *
 * These ports keep ChatManager as a composition boundary and prevent
 * extracted services from reaching into one another's private state.
 */

import type {
  Backend,
} from "../backends/types";
import type {
  Chat,
  ChatMetadata,
  ChatMetadataState,
  ChatConfig,
  ChatPermissionDecision,
  ChatSnapshot,
  ChatState,
  ChatStatus,
  ChatTranscriptStorageEntry,
  ChatStreamControlState,
  ChatStartupStage,
  ChatWorktreeState,
  ExecutionHostBinding,
  SessionInfo,
  Task,
  TaskLogEntry,
  TranscriptChangeSet,
  TranscriptSnapshotOptions,
  ToolCallRecord,
  MessageData,
} from "@/shared";
import type { ChatEvent } from "@/shared/events";
import type { MessageAttachment } from "@/shared/message-attachments";
import type { Workspace } from "@/shared/workspace";
import type { EventStream } from "../utils/event-stream";
import type { SimpleEventEmitter } from "./event-emitter";
import type { HarnessActivitySnapshot, HarnessActivityStopResult, HarnessCapabilities, HarnessInputAdmission } from "@/shared/harness-control";
import type { QueuedChatMessage } from "@/shared/chat";
import type { ChatTrashService } from "./chat-trash-service";
import type { LiveTranscriptState } from "./transcript-stream-projection";
import type { ReplyToChatQuestionRequest } from "@/contracts/api";

export interface CreateChatOptions {
  name?: string;
  workspaceId: string;
  scope?: ChatConfig["scope"];
  taskId?: string;
  modelProviderID: string;
  modelID: string;
  modelVariant?: string;
  useWorktree?: boolean;
  useSelectedBranchForWorktree?: boolean;
  useChatNameAsBranch?: boolean;
  baseBranch?: string;
  directory?: string;
  expectedExecutionHostBinding?: ExecutionHostBinding;
  syncBaseBranch?: boolean;
  prepareWorktreeOnCreate?: boolean;
}

export interface CreateAgentRunChatOptions extends Omit<CreateChatOptions, "scope" | "taskId"> {}

export interface CreateExecutionHostChatOptions {
  name?: string;
  executionHost: ExecutionHostBinding;
  directory: string;
  modelProviderID: string;
  modelID: string;
  modelVariant?: string;
}

export interface ReconnectChatOptions {
  signal?: AbortSignal;
}

export interface DeleteChatOptions {
  /**
   * Remove the persisted chat before running remote resource cleanup.
   * Internal callers keep the synchronous cleanup behavior by default.
   */
  deferCleanup?: boolean;
}

export interface DeleteTaskChatResult {
  deleted: boolean;
  cleanup: Promise<boolean>;
}

export type ChatConfigUpdates = Partial<
  Omit<ChatConfig, "id" | "createdAt" | "workspaceId" | "mode" | "scope" | "taskId" | "deletedAt">
>;

export interface ChatMessageOptions {
  message?: string;
  attachments?: MessageAttachment[];
  transcriptMessage?: MessageData;
  clientId?: string;
}

export interface NormalizedChatMessageInput {
  message: string;
  attachments: MessageAttachment[];
  transcriptMessage?: MessageData;
  clientId?: string;
}

export interface ChatDirectoryResolution {
  chat: Chat;
  directory: string;
}

export interface ChatStatePort {
  getChat(chatId: string): Promise<Chat | null>;
  getChatSummary(chatId: string): Promise<Chat | null>;
  hasSingleUserMessage(chatId: string): Promise<boolean>;
  getChatMessage(chatId: string, messageId: string): Promise<MessageData | null>;
  getChatStreamControlState(chatId: string): Promise<ChatStreamControlState | null>;
  getChatSnapshot(
    chatId: string,
    options?: TranscriptSnapshotOptions,
  ): Promise<ChatSnapshot | null>;
  getChatTranscriptExportMeta(
    chatId: string,
  ): Promise<{ revision: string; entryCount: number } | null>;
  iterateChatTranscriptEntries(
    chatId: string,
    options?: { fileAttachmentsOnly?: boolean },
  ): AsyncIterable<ChatTranscriptStorageEntry>;
  getChatToolCall(chatId: string, toolCallId: string): Promise<ToolCallRecord | null>;
  getTaskChat(taskId: string): Promise<Chat | null>;
  getAllChats(): Promise<Chat[]>;
  getChatSummaries(): Promise<Chat[]>;
  getChatsByWorkspace(workspaceId: string, options?: { includeTaskChats?: boolean }): Promise<Chat[]>;
  getChatSummariesByWorkspace(workspaceId: string): Promise<Chat[]>;
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  touchWorkspace(workspaceId: string): Promise<void>;
  getWorkspaceChatNameStats(workspaceId: string, namePrefix: string): Promise<{
    standaloneChatCount: number;
    maxGeneratedSuffix: number;
  }>;
  saveNewChat(chat: Chat): Promise<void>;
  updateConfig(chatId: string, config: ChatConfig, options?: { expectedName?: string }): Promise<Chat | null>;
  updateState(
    chat: Chat,
    state: ChatState,
    options?: {
      transcriptChanges?: TranscriptChangeSet;
      expectedStatus?: ChatStatus;
      streaming?: boolean;
    },
  ): Promise<Chat>;
  mutateState(
    chatId: string,
    update: (current: Chat) => ChatState | undefined,
  ): Promise<Chat>;
  mutateMetadata(
    chatId: string,
    update: (current: ChatMetadata) => ChatMetadataState | undefined,
  ): Promise<ChatMetadata>;
  updateStartupStage(
    chat: Chat,
    startupStage: ChatStartupStage | undefined,
    options?: { expectedStatus?: ChatStatus },
  ): Promise<Chat>;
  markChatError(chat: Chat, message: string, code?: string): Promise<Chat>;
  deletePersistedChat(chatId: string): Promise<boolean>;
  emitChatCreated(chat: Chat, timestamp: string): void;
  emitChatUpdated(chat: ChatMetadata, timestamp?: string): void;
  emitChatDeleted(chat: Chat, timestamp: string): void;
  emit(event: ChatEvent): void;
}

export interface ChatWorktreePort {
  hasEstablishedWorkspaceContext(chat: Chat): boolean;
  assertWorktreeBranchAvailable(chat: Chat): Promise<void>;
  resolveWorkingDirectory(
    chat: Chat,
    options: { prepareWorkspace: boolean; signal?: AbortSignal },
  ): Promise<ChatDirectoryResolution>;
  prepareWorktreeState(
    chat: Chat,
    options?: { syncBaseBranch?: boolean; signal?: AbortSignal },
  ): Promise<ChatWorktreeState>;
  ensureWorktree(chat: Chat, options?: { signal?: AbortSignal }): Promise<Chat>;
  prepareWorktreeInBackground(chat: Chat): void;
  waitForPreparation(chatId: string): Promise<void>;
  cleanupWorktree(chat: Chat): Promise<void>;
}

export interface ChatSessionPort {
  getChatAdapter(chat: Chat): Promise<HarnessCapabilities["adapter"]>;
  getActivity(chatId: string): Promise<HarnessActivitySnapshot>;
  stopActivity(chatId: string, activityId: string): Promise<HarnessActivityStopResult>;
  getChatBackend(chatId: string, workspaceId?: string): Backend;
  ensureBackendConnected(
    chat: Chat,
    options?: ReconnectChatOptions,
    workingDirectory?: ChatDirectoryResolution,
  ): Promise<Backend>;
  ensureSession(
    chat: Chat,
    backend: Backend,
    options?: {
      workingDirectory?: ChatDirectoryResolution;
      signal?: AbortSignal;
    },
  ): Promise<Chat>;
  createSessionFromHistory(
    chat: Chat,
    options: ReconnectChatOptions & { directory: string },
  ): Promise<Chat>;
  createSession(
    chat: Chat,
    backend: Backend,
    options: {
      prepareWorkspace: boolean;
      workingDirectory?: ChatDirectoryResolution;
      signal?: AbortSignal;
    },
  ): Promise<Chat>;
  configureSessionModel(backend: Backend, sessionId: string, desiredModel: string): Promise<void>;
  reconnectSession(chat: Chat, options?: ReconnectChatOptions): Promise<Chat>;
  disconnectChat(chatId: string): Promise<boolean>;
}

export interface ChatConversationPort {
  beginShutdown(): void;
  shutdown(): Promise<void>;
  withLiveActivity(chat: Chat): Chat;
  getLiveTranscript(chatId: string): LiveTranscriptState | undefined;
  runStartupOperation<T>(
    chatId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  getAssistantMessage(chatId: string, messageId: string): Promise<MessageData | null>;
  recordSteeredMessage(chat: Chat, message: QueuedChatMessage, admission: HarnessInputAdmission): Promise<Chat>;
  dispatchMessage(
    chat: Chat,
    input: NormalizedChatMessageInput,
    options?: {
      clearQueuedMessageIds?: readonly string[];
    },
  ): Promise<Chat>;
  interruptChat(chatId: string, reason?: string): Promise<Chat | null>;
  waitForChatIdle(chatId: string, timeoutMs?: number): Promise<Chat>;
  closeActiveStream(chatId: string): void;
  checkpointForDeletion(
    chatId: string,
    markDeleted: (chatId: string, checkpoint?: TranscriptChangeSet) => Chat | null,
  ): Chat | null;
  stopForDeletion(chatId: string): Promise<void>;
  hasActiveStream(chatId: string): boolean;
  emitChatLog(
    chat: Chat,
    level: TaskLogEntry["level"],
    message: string,
    details?: Record<string, unknown>,
  ): Promise<Chat>;
}

export interface ChatInteractionPort {
  beginShutdown(): void;
  shutdown(): Promise<void>;
  replyToQuestion(chatId: string, requestId: string, reply: ReplyToChatQuestionRequest): Promise<Chat>;
  replyToSecret(chatId: string, requestId: string, value: string | null): Promise<Chat>;
  reconcileQueuedMessage(chatId: string, queuedMessageId: string): Promise<{ chat: Chat; admission: HarnessInputAdmission }>;
  steerQueuedMessage(chatId: string, queuedMessageId: string): Promise<{ chat: Chat; admission: HarnessInputAdmission }>;
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
  createChatHere(sourceChatId: string): Promise<Chat>;
  createAgentRunChat(options: CreateAgentRunChatOptions): Promise<Chat>;
  createExecutionHostChat(options: CreateExecutionHostChatOptions): Promise<Chat>;
  updateChat(chatId: string, updates: ChatConfigUpdates): Promise<Chat | null>;
  updateChatStatus(chatId: string, status: ChatStatus): Promise<Chat | null>;
  markChatDone(chatId: string): Promise<Chat | null>;
  attachSession(chatId: string, session: SessionInfo): Promise<Chat | null>;
  getOrCreateTaskChat(taskId: string, task?: Task): Promise<{ chat: Chat; created: boolean }>;
  deleteTaskChat(taskId: string): Promise<DeleteTaskChatResult>;
  deleteChat(chatId: string, options?: DeleteChatOptions): Promise<boolean>;
}

export interface ChatHistoryRecoveryPort {
  continueFromHistory(
    chatId: string,
    options?: ReconnectChatOptions,
  ): Promise<Chat | null>;
}

export interface ChatServiceBundle {
  trash: ChatTrashService;
  state: ChatStatePort;
  lifecycle: ChatLifecyclePort;
  worktree: ChatWorktreePort;
  session: ChatSessionPort;
  conversation: ChatConversationPort;
  interaction: ChatInteractionPort;
  historyRecovery: ChatHistoryRecoveryPort;
}

export type ChatEventStream = EventStream<import("@/shared/harness-events").HarnessEvent>;
export type ChatEventEmitter = SimpleEventEmitter<ChatEvent>;
