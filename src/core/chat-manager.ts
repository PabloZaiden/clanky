/**
 * Public orchestration facade for long-lived harness-backed chats.
 */

import type {
  Chat,
  ChatSnapshot,
  ChatStatus,
  SessionInfo,
  Task,
  TranscriptSnapshotOptions,
  ToolCallRecord,
} from "@/shared";
import { shouldIncludeConversationTranscriptLog } from "@/shared";
import type { ChatEvent } from "@/shared/events";
import { chatEventEmitter, SimpleEventEmitter } from "./event-emitter";
import { ChatStateService } from "./chat-state-service";
import { ChatLifecycleService } from "./chat-lifecycle-service";
import { ChatTrashService } from "./chat-trash-service";
import type { ChatTrashQuery } from "@/contracts/schemas/chat-trash";
import { ChatWorktreeService } from "./chat-worktree-service";
import { ChatSessionService } from "./chat-session-service";
import { ChatConversationService } from "./chat-conversation-service";
import { ChatInteractionService } from "./chat-interaction-service";
import { ChatQuestionService } from "./chat-question-service";
import { ChatTaskConversionService } from "./chat-task-conversion-service";
import { ChatHistoryExportService } from "./chat-history-export-service";
import { ChatHistoryRecoveryService } from "./chat-history-recovery-service";
import { ChatAttachmentService } from "./chat-attachment-service";
import type {
  ChatConfigUpdates,
  DeleteChatOptions,
  ChatInteractionPort,
  ChatMessageOptions,
  ChatServiceBundle,
  CreateAgentRunChatOptions,
  CreateChatOptions,
  CreateExecutionHostChatOptions,
  DeleteTaskChatResult,
  ReconnectChatOptions,
} from "./chat-service-contracts";
import type { Backend } from "../backends/types";
import { includeLiveTranscript } from "./transcript-service";

export type {
  ChatConfigUpdates,
  ChatMessageOptions,
  DeleteChatOptions,
  CreateAgentRunChatOptions,
  CreateChatOptions,
  CreateExecutionHostChatOptions,
  DeleteTaskChatResult,
  ReconnectChatOptions,
} from "./chat-service-contracts";

function createChatServices(emitter: SimpleEventEmitter<ChatEvent>): ChatServiceBundle {
  const state = new ChatStateService(emitter);
  const worktree = new ChatWorktreeService({ state });
  const historyExport = new ChatHistoryExportService({ state });
  const attachments = new ChatAttachmentService(state);

  let conversation: ChatConversationService | undefined;
  let interaction: ChatInteractionService | undefined;
  let questions: ChatQuestionService | undefined;
  const session = new ChatSessionService({
    state,
    worktree,
    hasActiveStream: (chatId: string) => conversation?.hasActiveStream(chatId) ?? false,
    onNativeSession: async (chat, backend, binding, recover) => {
      if (!conversation) throw new Error("Chat conversation service is not initialized");
      await conversation.observeNativeSession({ chat, backend, binding, recover });
    },
    onNativeDisconnect: async (chatId) => {
      await conversation?.stopNativeObservation(chatId);
    },
    onHarnessEvent: async (chatId, binding, event) => {
      if (binding.adapter !== "acp") return;
      if (!questions) throw new Error("Chat question service is not initialized");
      // The active transcript consumer owns native-message segmentation.
      if (event.type === "question.asked" && event.responseMode === "message" && conversation?.hasActiveStream(chatId)) return;
      await questions.handle(chatId, binding, { event });
    },
  });
  const conversationService = new ChatConversationService({
    state,
    session,
    worktree,
    historyExport,
    attachments,
    emitter,
    scheduleQueuedMessageDrain: (chatId: string) => {
      if (!interaction) {
        throw new Error("Chat interaction service is not initialized");
      }
      interaction.scheduleQueuedMessageDrain(chatId);
    },
  });
  conversation = conversationService;
  questions = new ChatQuestionService({ state, session,
    hasActiveStream: (id: string) => conversationService.hasActiveStream(id),
    sendMessage: async (id, message, transcriptMessage, clientId) => {
      if (!interaction) throw new Error("Chat interaction service is not initialized");
      return interaction.sendMessage(id, { message, transcriptMessage, clientId });
    } });
  const questionService = questions;
  conversationService.setQuestionHandler(async (chat, event, questionMessageId) => {
    if (!chat.state.session?.binding) throw new Error("Questions require an owned conversation");
    await questionService.handle(chat.config.id, chat.state.session.binding, { event, questionMessageId });
  });

  const interactionService = new ChatInteractionService({
    state,
    conversation: conversationService,
    session,
    questions,
    attachments,
  });
  interaction = interactionService;
  conversationService.setPermissionHandler((chat, backend, request) =>
    interactionService.handlePermissionAsked(chat, backend, request)
  );

  const lifecycle = new ChatLifecycleService({
    state,
    worktree,
    session,
    conversation: conversationService,
    historyExport,
  });
  const taskConversion = new ChatTaskConversionService({
    state,
    worktree,
  });
  const historyRecovery = new ChatHistoryRecoveryService({
    state,
    session,
    conversation: conversationService,
    historyExport,
  });

  return {
    trash: new ChatTrashService(state, lifecycle, conversationService),
    state,
    lifecycle,
    worktree,
    session,
    conversation: conversationService,
    interaction: interactionService,
    historyRecovery,
    taskConversion,
  };
}

function isChatServiceBundle(
  value: ChatServiceBundle | SimpleEventEmitter<ChatEvent>,
): value is ChatServiceBundle {
  return "state" in value;
}

export class ChatManager {
  beginShutdown(): void {
    this.services.interaction.beginShutdown();
    this.services.conversation.beginShutdown();
  }

  async shutdown(): Promise<void> {
    this.beginShutdown();
    const failures: unknown[] = [];
    for (const shutdown of [
      () => this.services.interaction.shutdown(),
      () => this.services.conversation.shutdown(),
    ]) {
      try {
        await shutdown();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Chat shutdown failed.");
  }
  private readonly services: ChatServiceBundle;

  constructor(emitter?: SimpleEventEmitter<ChatEvent>);
  constructor(services: ChatServiceBundle);
  constructor(
    servicesOrEmitter: ChatServiceBundle | SimpleEventEmitter<ChatEvent> = chatEventEmitter,
  ) {
    this.services = isChatServiceBundle(servicesOrEmitter)
      ? servicesOrEmitter
      : createChatServices(servicesOrEmitter);
  }

  async createChat(options: CreateChatOptions): Promise<Chat> {
    return this.services.lifecycle.createChat(options);
  }

  async createChatHere(sourceChatId: string): Promise<Chat> {
    return this.services.lifecycle.createChatHere(sourceChatId);
  }

  async createAgentRunChat(options: CreateAgentRunChatOptions): Promise<Chat> {
    return this.services.lifecycle.createAgentRunChat(options);
  }

  async createExecutionHostChat(options: CreateExecutionHostChatOptions): Promise<Chat> {
    return this.services.lifecycle.createExecutionHostChat(options);
  }

  async getChat(chatId: string): Promise<Chat | null> {
    return this.services.state.getChat(chatId);
  }

  async getAssistantMessage(chatId: string, messageId: string) {
    return this.services.conversation.getAssistantMessage(chatId, messageId);
  }

  async getChatSummary(chatId: string): Promise<Chat | null> {
    const chat = await this.services.state.getChatSummary(chatId);
    return chat ? this.services.conversation.withLiveActivity(chat) : null;
  }

  getChatAdapter(chat: Chat) { return this.services.session.getChatAdapter(chat); }

  getActivity(chatId: string) { return this.services.session.getActivity(chatId); }

  stopActivity(chatId: string, activityId: string) { return this.services.session.stopActivity(chatId, activityId); }

  async getAllChats(): Promise<Chat[]> {
    return this.services.state.getAllChats();
  }

  async getChatSummaries(): Promise<Chat[]> {
    return (await this.services.state.getChatSummaries())
      .map((chat) => this.services.conversation.withLiveActivity(chat));
  }

  async getChatsByWorkspace(workspaceId: string, options?: { includeTaskChats?: boolean }): Promise<Chat[]> {
    return this.services.state.getChatsByWorkspace(workspaceId, options);
  }

  async getWorkingDirectory(chat: Chat): Promise<string> {
    return (await this.services.worktree.resolveWorkingDirectory(chat, { prepareWorkspace: false })).directory;
  }

  async getChatSummariesByWorkspace(workspaceId: string): Promise<Chat[]> {
    return (await this.services.state.getChatSummariesByWorkspace(workspaceId))
      .map((chat) => this.services.conversation.withLiveActivity(chat));
  }

  async getTaskChat(taskId: string): Promise<Chat | null> {
    return this.services.state.getTaskChat(taskId);
  }

  async getChatSnapshot(
    chatId: string,
    options?: TranscriptSnapshotOptions,
  ): Promise<ChatSnapshot | null> {
    const snapshot = await this.services.state.getChatSnapshot(chatId, options);
    if (!snapshot) return null;
    return {
      ...snapshot,
      transcript: includeLiveTranscript(
        snapshot.transcript,
        this.services.conversation.getLiveTranscript(chatId),
        { window: options ?? {}, shouldIncludeLog: shouldIncludeConversationTranscriptLog },
      ),
    };
  }

  async getChatToolCall(chatId: string, toolCallId: string): Promise<ToolCallRecord | null> {
    return this.services.state.getChatToolCall(chatId, toolCallId);
  }

  async getOrCreateTaskChat(taskId: string, task?: Task): Promise<{ chat: Chat; created: boolean }> {
    return this.services.lifecycle.getOrCreateTaskChat(taskId, task);
  }

  async deleteTaskChat(taskId: string): Promise<DeleteTaskChatResult> {
    return this.services.lifecycle.deleteTaskChat(taskId);
  }

  async updateChat(chatId: string, updates: ChatConfigUpdates): Promise<Chat | null> {
    return this.services.lifecycle.updateChat(chatId, updates);
  }

  async updateChatStatus(chatId: string, status: ChatStatus): Promise<Chat | null> {
    return this.services.lifecycle.updateChatStatus(chatId, status);
  }

  async markChatDone(chatId: string): Promise<Chat | null> {
    return this.services.lifecycle.markChatDone(chatId);
  }

  async attachSession(chatId: string, session: SessionInfo): Promise<Chat | null> {
    return this.services.lifecycle.attachSession(chatId, session);
  }

  async reconnectSession(chatId: string, options: ReconnectChatOptions = {}): Promise<Chat | null> {
    return await this.services.trash.runLiveOperation(chatId, () => this.services.conversation.runStartupOperation(chatId, async (signal) => {
      const chat = await this.services.state.getChat(chatId);
      if (!chat) return null;
      const reconnected = await this.services.session.reconnectSession(chat, { ...options, signal });
      if (reconnected.state.status === "idle") {
        this.services.interaction.scheduleQueuedMessageDrain(chatId);
      }
      return reconnected;
    }, options.signal));
  }

  async continueFromHistory(
    chatId: string,
    options: ReconnectChatOptions = {},
  ): Promise<Chat | null> {
    return this.services.trash.runLiveOperation(chatId, () =>
      this.services.historyRecovery.continueFromHistory(chatId, options));
  }

  async sendMessage(chatId: string, options: ChatMessageOptions): Promise<Chat> {
    return this.services.interaction.sendMessage(chatId, options);
  }

  async removeQueuedMessage(chatId: string, queuedMessageId: string): Promise<Chat | null> {
    return this.services.interaction.removeQueuedMessage(chatId, queuedMessageId);
  }

  steerQueuedMessage(chatId: string, queuedMessageId: string) {
    return this.services.interaction.steerQueuedMessage(chatId, queuedMessageId);
  }

  reconcileQueuedMessage(chatId: string, queuedMessageId: string) {
    return this.services.interaction.reconcileQueuedMessage(chatId, queuedMessageId);
  }

  async waitForChatIdle(chatId: string, timeoutMs?: number): Promise<Chat> {
    return this.services.conversation.waitForChatIdle(chatId, timeoutMs);
  }

  async interruptChat(chatId: string, reason?: string): Promise<Chat | null> {
    return this.services.conversation.interruptChat(chatId, reason);
  }

  async replyToPermission(
    chatId: string,
    requestId: string,
    decision: Parameters<ChatInteractionPort["replyToPermission"]>[2],
  ): Promise<Chat | null> {
    return this.services.interaction.replyToPermission(chatId, requestId, decision);
  }

  replyToQuestion(chatId: string, requestId: string, answers: string[][], clientId?: string): Promise<Chat> {
    return this.services.interaction.replyToQuestion(chatId, requestId, answers, clientId);
  }

  async deleteChat(chatId: string, options?: DeleteChatOptions): Promise<boolean> {
    return this.services.lifecycle.deleteChat(chatId, options);
  }

  listTrash(options: ChatTrashQuery) { return this.services.trash.list(options); }
  trashChat(chatId: string, credentialToken?: string | null) { return this.services.trash.move(chatId, credentialToken); }
  restoreChat(chatId: string) { return this.services.trash.restore(chatId); }
  purgeTrashedChat(chatId: string, options: Parameters<ChatTrashService["purge"]>[1] = {}) {
    return this.services.trash.purge(chatId, options);
  }
  getTrashCredentialTargets(chatId?: string) { return this.services.trash.credentialTargets(chatId); }
  emptyTrash(options: Parameters<ChatTrashService["empty"]>[0] = {}) { return this.services.trash.empty(options); }
  expireTrash() { return this.services.trash.expire(); }

  async spawnTaskFromChat(chatId: string): Promise<Task> {
    return this.services.taskConversion.spawnTaskFromChat(chatId);
  }

  async spawnTaskFromCurrentPlan(chatId: string, planFilePath?: string): Promise<Task> {
    return this.services.taskConversion.spawnTaskFromCurrentPlan(chatId, planFilePath);
  }

  getChatBackend(chatId: string, workspaceId?: string): Backend {
    return this.services.session.getChatBackend(chatId, workspaceId);
  }

  async disconnectChat(chatId: string): Promise<boolean> {
    return this.services.session.disconnectChat(chatId);
  }
}

export const chatManager = new ChatManager();
