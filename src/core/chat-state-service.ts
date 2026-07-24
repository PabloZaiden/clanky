/**
 * Persistence and state-event boundary for chat workflows.
 */

import {
  deleteChat,
  getWorkspaceChatNameStats,
  listChatSummaries,
  listChatSummariesBySshServer,
  listChatSummariesByWorkspace,
  listChats,
  listChatsByWorkspace,
  loadChat,
  loadChatMetadata,
  loadTaskChat,
  getChatTranscriptMeta,
  getChatToolCallFromTranscript,
  listChatTranscriptEntries,
  saveChat,
  updateChatConfig,
  updateChatState,
  countChatTranscriptEntries,
} from "../persistence/chats";
import {
  createTranscriptPageFromStorageEntries,
  isTranscriptStorageEntryVisible,
  parseTranscriptCursor,
} from "./transcript-service";
import { getWorkspace, touchWorkspace } from "../persistence/workspaces";
import type {
  Chat,
  ChatConfig,
  ChatState,
  ChatTranscriptCursor,
  ChatTranscriptStorageEntry,
  Workspace,
} from "@/shared";
import type { ChatSnapshot, ChatTranscriptPage, ToolCallRecord } from "@/shared";
import type { ChatEvent } from "@/shared/events";
import { createTimestamp } from "@/shared/events";
import { isStandaloneChat, shouldIncludeChatTranscriptLog } from "@/shared";
import { chatEventEmitter, SimpleEventEmitter } from "./event-emitter";
import type { ChatStatePort } from "./chat-service-contracts";

function listVisibleChatTranscriptEntries(
  chatId: string,
  limit: number,
  before?: ChatTranscriptCursor,
): { entries: ChatTranscriptStorageEntry[]; hasOlder: boolean } {
  const entries: ChatTranscriptStorageEntry[] = [];
  const rawLimit = limit + 1;
  let rawCursor = before;

  while (true) {
    const batch = listChatTranscriptEntries(chatId, rawCursor, rawLimit);
    entries.push(...batch);
    const visibleCount = entries.filter((entry) =>
      isTranscriptStorageEntryVisible(entry, shouldIncludeChatTranscriptLog)
    ).length;
    if (visibleCount > limit || batch.length < rawLimit) {
      return { entries, hasOlder: visibleCount > limit };
    }
    const oldest = batch.at(-1);
    if (!oldest) {
      return { entries, hasOlder: false };
    }
    rawCursor = oldest;
  }
}

export class ChatStateService implements ChatStatePort {
  constructor(
    private readonly emitter: SimpleEventEmitter<ChatEvent> = chatEventEmitter,
  ) {}

  async getChat(chatId: string): Promise<Chat | null> {
    return loadChat(chatId);
  }

  async getChatSnapshot(chatId: string): Promise<ChatSnapshot | null> {
    const chat = await loadChatMetadata(chatId);
    if (!chat) {
      return null;
    }

    const meta = getChatTranscriptMeta(chatId);
    if (!meta) {
      throw new Error(`Chat transcript metadata is unavailable: ${chatId}`);
    }

    const entries = listChatTranscriptEntries(chatId, undefined, undefined);
    const { messages: _messages, logs: _logs, toolCalls: _toolCalls, ...state } = chat.state;
    return {
      config: chat.config,
      state,
      transcript: createTranscriptPageFromStorageEntries(entries, undefined, undefined, {
        revision: meta.revision,
        totalEntries: countChatTranscriptEntries(chatId),
        hasOlder: false,
      }, shouldIncludeChatTranscriptLog),
    };
  }

  async getChatTranscriptPage(
    chatId: string,
    limit: number,
    before?: string,
  ): Promise<ChatTranscriptPage | null> {
    const chat = await loadChatMetadata(chatId);
    if (!chat) {
      return null;
    }

    const meta = getChatTranscriptMeta(chatId);
    if (!meta) {
      throw new Error(`Chat transcript metadata is unavailable: ${chatId}`);
    }

    const cursor = before ? parseTranscriptCursor(before) : undefined;
    const { entries, hasOlder } = listVisibleChatTranscriptEntries(chatId, limit, cursor);
    return createTranscriptPageFromStorageEntries(entries, limit, before, {
      revision: meta.revision,
      totalEntries: countChatTranscriptEntries(chatId),
      hasOlder,
    }, shouldIncludeChatTranscriptLog);
  }

  async getChatToolCall(chatId: string, toolCallId: string): Promise<ToolCallRecord | null> {
    const chatMeta = await loadChatMetadata(chatId);
    if (!chatMeta) {
      return null;
    }
    const meta = getChatTranscriptMeta(chatId);
    if (!meta) {
      throw new Error(`Chat transcript metadata is unavailable: ${chatId}`);
    }

    const value = getChatToolCallFromTranscript(chatId, toolCallId);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as ToolCallRecord
      : null;
  }

  async getTaskChat(taskId: string): Promise<Chat | null> {
    return loadTaskChat(taskId);
  }

  async getAllChats(): Promise<Chat[]> {
    return (await listChats()).filter(isStandaloneChat);
  }

  async getChatSummaries(): Promise<Chat[]> {
    return (await listChatSummaries()).filter(isStandaloneChat);
  }

  async getChatsByWorkspace(workspaceId: string): Promise<Chat[]> {
    return (await listChatsByWorkspace(workspaceId)).filter(isStandaloneChat);
  }

  async getChatSummariesByWorkspace(workspaceId: string): Promise<Chat[]> {
    return (await listChatSummariesByWorkspace(workspaceId)).filter(isStandaloneChat);
  }

  async getChatSummariesBySshServer(sshServerId: string): Promise<Chat[]> {
    return (await listChatSummariesBySshServer(sshServerId)).filter(isStandaloneChat);
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    return getWorkspace(workspaceId);
  }

  async touchWorkspace(workspaceId: string): Promise<void> {
    await touchWorkspace(workspaceId);
  }

  async getWorkspaceChatNameStats(
    workspaceId: string,
    namePrefix: string,
  ): Promise<{ standaloneChatCount: number; maxGeneratedSuffix: number }> {
    return getWorkspaceChatNameStats(workspaceId, namePrefix);
  }

  async saveNewChat(chat: Chat): Promise<void> {
    await saveChat(chat);
  }

  async updateConfig(chatId: string, config: ChatConfig): Promise<Chat | null> {
    const saved = await updateChatConfig(chatId, config);
    if (!saved) {
      return null;
    }
    return this.getChat(chatId);
  }

  async updateState(chat: Chat, state: ChatState): Promise<Chat> {
    const preserveQueuedMessages = state.queuedMessages === chat.state.queuedMessages;
    const saved = await updateChatState(chat.config.id, state, {
      preserveQueuedMessages,
    });
    if (!saved) {
      throw new Error(`Failed to persist chat state for ${chat.config.id}`);
    }

    const updated = {
      config: chat.config,
      state,
    };
    if (chat.state.status !== state.status) {
      this.emitter.emit({
        type: "chat.status",
        chatId: chat.config.id,
        scope: chat.config.scope,
        status: state.status,
        timestamp: state.lastActivityAt ?? createTimestamp(),
      });
    }
    return updated;
  }

  async markChatError(chat: Chat, message: string, code?: string): Promise<Chat> {
    const now = createTimestamp();
    const updated = await this.updateState(chat, {
      ...chat.state,
      status: "failed",
      error: {
        message,
        timestamp: now,
        ...(code ? { code } : {}),
      },
      completedAt: now,
      pendingPermissionRequests: (chat.state.pendingPermissionRequests ?? []).map((request) =>
        request.status === "pending"
          ? {
              ...request,
              status: "cancelled",
              resolvedAt: now,
              error: message,
            }
          : request
      ),
      activeMessageId: undefined,
      interruptRequested: false,
      lastActivityAt: now,
    });
    this.emitter.emit({
      type: "chat.error",
      chatId: chat.config.id,
      scope: chat.config.scope,
      message,
      ...(code ? { code } : {}),
      timestamp: now,
    });
    return updated;
  }

  async deletePersistedChat(chatId: string): Promise<boolean> {
    return deleteChat(chatId);
  }

  emitChatCreated(chat: Chat, timestamp: string): void {
    this.emitter.emit({
      type: "chat.created",
      chatId: chat.config.id,
      config: chat.config,
      timestamp,
    });
  }

  emitChatUpdated(chat: Chat, timestamp?: string): void {
    this.emitter.emit({
      type: "chat.updated",
      chatId: chat.config.id,
      chat,
      timestamp: timestamp ?? chat.state.lastActivityAt ?? createTimestamp(),
    });
  }

  emitChatDeleted(chat: Chat, timestamp: string): void {
    this.emitter.emit({
      type: "chat.deleted",
      chatId: chat.config.id,
      scope: chat.config.scope,
      timestamp,
    });
  }

  emit(event: ChatEvent): void {
    this.emitter.emit(event);
  }
}
