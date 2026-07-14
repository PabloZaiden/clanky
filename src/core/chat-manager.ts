/**
 * Public orchestration facade for long-lived ACP-backed chats.
 */

import type { Chat, ChatStatus, SessionInfo, Task } from "@/shared";
import type { ChatEvent } from "@/shared/events";
import { chatEventEmitter, SimpleEventEmitter } from "./event-emitter";
import { ChatStateService } from "./chat-state-service";
import { ChatLifecycleService } from "./chat-lifecycle-service";
import { ChatWorktreeService } from "./chat-worktree-service";
import { ChatSessionService } from "./chat-session-service";
import { ChatConversationService } from "./chat-conversation-service";
import { ChatInteractionService } from "./chat-interaction-service";
import { ChatTaskConversionService } from "./chat-task-conversion-service";
import type {
  ChatConfigUpdates,
  ChatInteractionPort,
  ChatMessageOptions,
  ChatServiceBundle,
  CreateAgentRunChatOptions,
  CreateChatOptions,
  CreateSshServerChatOptions,
  ImportExistingSessionOptions,
  ReconnectChatOptions,
} from "./chat-service-contracts";
import type { Backend, ImportableSession } from "../backends/types";

export type {
  ChatConfigUpdates,
  ChatMessageOptions,
  CreateAgentRunChatOptions,
  CreateChatOptions,
  CreateSshServerChatOptions,
  ImportExistingSessionOptions,
  ReconnectChatOptions,
} from "./chat-service-contracts";

function createChatServices(emitter: SimpleEventEmitter<ChatEvent>): ChatServiceBundle {
  const state = new ChatStateService(emitter);
  const worktree = new ChatWorktreeService({ state });

  let conversation: ChatConversationService | undefined;
  let interaction: ChatInteractionService | undefined;
  const session = new ChatSessionService({
    state,
    worktree,
    hasActiveStream: (chatId: string) => conversation?.hasActiveStream(chatId) ?? false,
  });
  const conversationService = new ChatConversationService({
    state,
    session,
    emitter,
    scheduleQueuedMessageDrain: (chatId: string) => {
      if (!interaction) {
        throw new Error("Chat interaction service is not initialized");
      }
      interaction.scheduleQueuedMessageDrain(chatId);
    },
  });
  conversation = conversationService;

  const interactionService = new ChatInteractionService({
    state,
    conversation: conversationService,
    session,
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
  });
  const taskConversion = new ChatTaskConversionService({
    state,
    worktree,
  });

  return {
    state,
    lifecycle,
    worktree,
    session,
    conversation: conversationService,
    interaction: interactionService,
    taskConversion,
  };
}

function isChatServiceBundle(
  value: ChatServiceBundle | SimpleEventEmitter<ChatEvent>,
): value is ChatServiceBundle {
  return "state" in value;
}

export class ChatManager {
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

  async createAgentRunChat(options: CreateAgentRunChatOptions): Promise<Chat> {
    return this.services.lifecycle.createAgentRunChat(options);
  }

  async createSshServerChat(options: CreateSshServerChatOptions): Promise<Chat> {
    return this.services.lifecycle.createSshServerChat(options);
  }

  async listImportableSessions(workspaceId: string): Promise<ImportableSession[]> {
    return this.services.lifecycle.listImportableSessions(workspaceId);
  }

  async importExistingSession(options: ImportExistingSessionOptions): Promise<Chat> {
    return this.services.lifecycle.importExistingSession(options);
  }

  async getChat(chatId: string): Promise<Chat | null> {
    return this.services.state.getChat(chatId);
  }

  async getAllChats(): Promise<Chat[]> {
    return this.services.state.getAllChats();
  }

  async getChatSummaries(): Promise<Chat[]> {
    return this.services.state.getChatSummaries();
  }

  async getChatsByWorkspace(workspaceId: string): Promise<Chat[]> {
    return this.services.state.getChatsByWorkspace(workspaceId);
  }

  async getChatSummariesByWorkspace(workspaceId: string): Promise<Chat[]> {
    return this.services.state.getChatSummariesByWorkspace(workspaceId);
  }

  async getChatSummariesBySshServer(sshServerId: string): Promise<Chat[]> {
    return this.services.state.getChatSummariesBySshServer(sshServerId);
  }

  async getTaskChat(taskId: string): Promise<Chat | null> {
    return this.services.state.getTaskChat(taskId);
  }

  async getOrCreateTaskChat(taskId: string, task?: Task): Promise<{ chat: Chat; created: boolean }> {
    return this.services.lifecycle.getOrCreateTaskChat(taskId, task);
  }

  async deleteTaskChat(taskId: string): Promise<boolean> {
    return this.services.lifecycle.deleteTaskChat(taskId);
  }

  async updateChat(chatId: string, updates: ChatConfigUpdates): Promise<Chat | null> {
    return this.services.lifecycle.updateChat(chatId, updates);
  }

  async updateChatStatus(chatId: string, status: ChatStatus): Promise<Chat | null> {
    return this.services.lifecycle.updateChatStatus(chatId, status);
  }

  async attachSession(chatId: string, session: SessionInfo): Promise<Chat | null> {
    return this.services.lifecycle.attachSession(chatId, session);
  }

  async reconnectSession(chatId: string, options: ReconnectChatOptions = {}): Promise<Chat | null> {
    const chat = await this.services.state.getChat(chatId);
    if (!chat) {
      return null;
    }

    const reconnected = await this.services.session.reconnectSession(chat, options);
    if (reconnected.state.status === "idle") {
      this.services.interaction.scheduleQueuedMessageDrain(chatId);
    }
    return reconnected;
  }

  async sendMessage(chatId: string, options: ChatMessageOptions): Promise<Chat> {
    return this.services.interaction.sendMessage(chatId, options);
  }

  async removeQueuedMessage(chatId: string, queuedMessageId: string): Promise<Chat | null> {
    return this.services.interaction.removeQueuedMessage(chatId, queuedMessageId);
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

  async deleteChat(chatId: string): Promise<boolean> {
    return this.services.lifecycle.deleteChat(chatId);
  }

  async spawnTaskFromChat(chatId: string): Promise<Task> {
    return this.services.taskConversion.spawnTaskFromChat(chatId);
  }

  async spawnTaskFromCurrentPlan(chatId: string, planFilePath?: string): Promise<Task> {
    return this.services.taskConversion.spawnTaskFromCurrentPlan(chatId, planFilePath);
  }

  getChatBackend(chatId: string, workspaceId: string): Backend {
    return this.services.session.getChatBackend(chatId, workspaceId);
  }

  async disconnectChat(chatId: string): Promise<void> {
    return this.services.session.disconnectChat(chatId);
  }
}

export const chatManager = new ChatManager();
