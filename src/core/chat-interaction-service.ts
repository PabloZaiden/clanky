/**
 * Queued-message and permission-request workflows for chats.
 */

import type { Backend } from "../backends/types";
import type {
  Chat,
  ChatPermissionDecision,
  ChatPermissionRequest,
} from "@/shared";
import {
  ChatPermissionReplyError,
  ChatPermissionRequestNotFoundError,
  isChatBusyStatus,
} from "@/shared/chat";
import { createTimestamp } from "@/shared/events";
import { createLogger } from "./logger";
import type {
  ChatConversationPort,
  ChatInteractionPort,
  ChatMessageOptions,
  ChatSessionPort,
  ChatStatePort,
  NormalizedChatMessageInput,
} from "./chat-service-contracts";

const log = createLogger("chat-interaction-service");

export class ChatInteractionService implements ChatInteractionPort {
  private readonly queuedMessageDrains = new Set<string>();
  private readonly state: ChatStatePort;
  private readonly conversation: ChatConversationPort;
  private readonly session: ChatSessionPort;

  constructor(dependencies: {
    state: ChatStatePort;
    conversation: ChatConversationPort;
    session: ChatSessionPort;
  }) {
    this.state = dependencies.state;
    this.conversation = dependencies.conversation;
    this.session = dependencies.session;
  }

  async sendMessage(chatId: string, options: ChatMessageOptions): Promise<Chat> {
    const chat = await this.state.getChat(chatId);
    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }

    const input = this.normalizeMessageInput(options);
    if (this.shouldQueueMessage(chat)) {
      return this.enqueueMessage(chat, input);
    }

    return this.conversation.dispatchMessage(chat, input);
  }

  async removeQueuedMessage(chatId: string, queuedMessageId: string): Promise<Chat | null> {
    const chat = await this.state.getChat(chatId);
    if (!chat) {
      return null;
    }

    const queuedMessages = chat.state.queuedMessages ?? [];
    const nextQueuedMessages = queuedMessages.filter((queuedMessage) => queuedMessage.id !== queuedMessageId);
    if (nextQueuedMessages.length === queuedMessages.length) {
      return chat;
    }

    const updated = await this.state.updateState(chat, {
      ...chat.state,
      queuedMessages: nextQueuedMessages,
      lastActivityAt: createTimestamp(),
    });
    this.state.emitChatUpdated(updated);
    return updated;
  }

  async replyToPermission(
    chatId: string,
    requestId: string,
    decision: ChatPermissionDecision,
  ): Promise<Chat | null> {
    const chat = await this.state.getChat(chatId);
    if (!chat) {
      return null;
    }

    const request = (chat.state.pendingPermissionRequests ?? []).find(
      (permissionRequest) => permissionRequest.requestId === requestId && permissionRequest.status === "pending",
    );
    if (!request) {
      throw new ChatPermissionRequestNotFoundError(requestId);
    }

    const backend = this.session.getChatBackend(chat.config.id, chat.config.workspaceId);
    if (!backend.isConnected()) {
      throw new ChatPermissionReplyError(`Cannot reply to permission request ${requestId}: chat backend is not connected`);
    }

    const reply = decision === "allow" ? "once" : "deny";
    try {
      await backend.replyToPermission(requestId, reply);
    } catch (error) {
      const failed = await this.updatePermissionRequest(chat, requestId, {
        status: "pending",
        error: String(error),
      });
      this.state.emitChatUpdated(failed);
      throw new ChatPermissionReplyError(`Failed to reply to permission request ${requestId}: ${String(error)}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }

    const updated = await this.updatePermissionRequest(chat, requestId, {
      status: decision === "allow" ? "approved" : "denied",
      decision,
      resolvedAt: createTimestamp(),
      error: undefined,
    });
    this.state.emitChatUpdated(updated);
    await this.conversation.emitChatLog(
      updated,
      "info",
      decision === "allow" ? "Permission request approved" : "Permission request denied",
      { requestId, permission: request.permission, patterns: request.patterns },
    );
    return await this.state.getChat(chatId) ?? updated;
  }

  async handlePermissionAsked(
    chat: Chat,
    backend: Backend,
    request: ChatPermissionRequest,
  ): Promise<Chat> {
    if (chat.config.autoApprovePermissions !== false) {
      const logged = await this.conversation.emitChatLog(
        chat,
        "info",
        `Auto-approving permission request: ${request.permission}`,
        {
          requestId: request.requestId,
          patterns: request.patterns,
        },
      );
      try {
        await backend.replyToPermission(request.requestId, "always");
      } catch (error) {
        const message = `Failed to approve permission request ${request.permission}: ${String(error)}`;
        log.error(message, { chatId: chat.config.id, requestId: request.requestId });
        return this.state.markChatError(logged, message);
      }
      return this.conversation.emitChatLog(logged, "info", "Permission approved successfully", {
        requestId: request.requestId,
      });
    }

    const updated = await this.upsertPermissionRequest(chat, request);
    this.state.emitChatUpdated(updated);
    return this.conversation.emitChatLog(
      updated,
      "info",
      `Permission approval required: ${request.permission}`,
      {
        requestId: request.requestId,
        patterns: request.patterns,
      },
    );
  }

  scheduleQueuedMessageDrain(chatId: string): void {
    if (this.queuedMessageDrains.has(chatId)) {
      return;
    }

    this.queuedMessageDrains.add(chatId);
    void (async () => {
      try {
        await this.drainQueuedMessages(chatId);
      } catch (error) {
        log.error("Failed to drain queued chat messages", { chatId, error: String(error) });
      } finally {
        this.queuedMessageDrains.delete(chatId);
      }
    })();
  }

  private normalizeMessageInput(options: ChatMessageOptions): NormalizedChatMessageInput {
    const message = options.message?.trim() ?? "";
    const attachments = options.attachments ?? [];
    if (!message && attachments.length === 0) {
      throw new Error("Message or attachments are required");
    }
    return { message, attachments };
  }

  private shouldQueueMessage(chat: Chat): boolean {
    return isChatBusyStatus(chat.state.status) || chat.state.status === "reconnecting";
  }

  private async enqueueMessage(chat: Chat, input: NormalizedChatMessageInput): Promise<Chat> {
    const now = createTimestamp();
    const queuedMessage = {
      id: `chat-queued-${crypto.randomUUID()}`,
      content: input.message,
      attachments: input.attachments.length > 0 ? input.attachments : undefined,
      createdAt: now,
    };
    const updated = await this.state.updateState(chat, {
      ...chat.state,
      queuedMessages: [...(chat.state.queuedMessages ?? []), queuedMessage],
      lastActivityAt: now,
    });
    this.state.emitChatUpdated(updated);
    return updated;
  }

  private async drainQueuedMessages(chatId: string): Promise<void> {
    if (this.conversation.hasActiveStream(chatId)) {
      return;
    }

    const chat = await this.state.getChat(chatId);
    if (!chat || this.shouldQueueMessage(chat)) {
      return;
    }

    const queuedMessages = chat.state.queuedMessages ?? [];
    if (queuedMessages.length === 0) {
      return;
    }

    const message = queuedMessages
      .map((queuedMessage) => queuedMessage.content.trim())
      .filter((content) => content.length > 0)
      .join("\n");
    const attachments = queuedMessages.flatMap((queuedMessage) => queuedMessage.attachments ?? []);
    if (!message && attachments.length === 0) {
      const updated = await this.state.updateState(chat, {
        ...chat.state,
        queuedMessages: [],
        lastActivityAt: createTimestamp(),
      });
      this.state.emitChatUpdated(updated);
      return;
    }

    try {
      await this.conversation.dispatchMessage(chat, { message, attachments }, { clearQueuedMessages: true });
    } catch (error) {
      const latestChat = await this.state.getChat(chatId);
      if (latestChat) {
        const message = `Failed to send queued chat messages: ${String(error)}`;
        log.error(message, { chatId });
        await this.state.markChatError(latestChat, message);
      }
    }
  }

  private async upsertPermissionRequest(chat: Chat, request: ChatPermissionRequest): Promise<Chat> {
    const existingRequests = chat.state.pendingPermissionRequests ?? [];
    const existingIndex = existingRequests.findIndex(
      (permissionRequest) => permissionRequest.requestId === request.requestId,
    );
    const requests = existingIndex >= 0
      ? existingRequests.map((permissionRequest, index) =>
        index === existingIndex ? { ...permissionRequest, ...request } : permissionRequest
      )
      : [...existingRequests, request];

    return this.state.updateState(chat, {
      ...chat.state,
      pendingPermissionRequests: requests,
      lastActivityAt: request.createdAt,
    });
  }

  private async updatePermissionRequest(
    chat: Chat,
    requestId: string,
    updates: Partial<ChatPermissionRequest>,
  ): Promise<Chat> {
    const requests = (chat.state.pendingPermissionRequests ?? []).map((request) =>
      request.requestId === requestId ? { ...request, ...updates } : request
    );
    return this.state.updateState(chat, {
      ...chat.state,
      pendingPermissionRequests: requests,
      lastActivityAt: createTimestamp(),
    });
  }
}
