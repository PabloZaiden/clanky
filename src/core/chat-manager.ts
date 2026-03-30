/**
 * Chat manager for long-lived ACP-backed chats.
 *
 * This is the initial runtime facade for chat CRUD and runtime metadata. It
 * owns chat records and event emission, and exposes dedicated backend hooks so
 * later API/runtime layers can bind ACP sessions without reaching directly into
 * persistence.
 */

import type { Backend } from "../backends/types";
import type { Chat, ChatConfig, ChatStatus, SessionInfo } from "../types";
import type { ChatEvent } from "../types/events";
import { createTimestamp } from "../types/events";
import { createInitialChatState, DEFAULT_CHAT_CONFIG } from "../types/chat";
import { loadChat, listChats, saveChat, deleteChat, updateChatConfig, updateChatState } from "../persistence/chats";
import { getWorkspace } from "../persistence/workspaces";
import { backendManager } from "./backend";
import { chatEventEmitter, SimpleEventEmitter } from "./event-emitter";

export interface CreateChatOptions {
  name: string;
  workspaceId: string;
  modelProviderID: string;
  modelID: string;
  modelVariant?: string;
  useWorktree?: boolean;
  baseBranch?: string;
  directory?: string;
}

export class ChatManager {
  constructor(private readonly emitter: SimpleEventEmitter<ChatEvent> = chatEventEmitter) {}

  async createChat(options: CreateChatOptions): Promise<Chat> {
    const workspace = await getWorkspace(options.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${options.workspaceId}`);
    }

    const name = options.name.trim();
    if (!name) {
      throw new Error("Chat name is required");
    }

    const id = crypto.randomUUID();
    const now = createTimestamp();
    const chat: Chat = {
      config: {
        id,
        name,
        workspaceId: options.workspaceId,
        directory: options.directory ?? workspace.directory,
        model: {
          providerID: options.modelProviderID,
          modelID: options.modelID,
          variant: options.modelVariant,
        },
        useWorktree: options.useWorktree ?? DEFAULT_CHAT_CONFIG.useWorktree,
        baseBranch: options.baseBranch,
        createdAt: now,
        updatedAt: now,
        mode: DEFAULT_CHAT_CONFIG.mode,
      },
      state: createInitialChatState(id),
    };

    await saveChat(chat);
    this.emitter.emit({
      type: "chat.created",
      chatId: id,
      config: chat.config,
      timestamp: now,
    });
    return chat;
  }

  async getChat(chatId: string): Promise<Chat | null> {
    return loadChat(chatId);
  }

  async getAllChats(): Promise<Chat[]> {
    return listChats();
  }

  async updateChat(
    chatId: string,
    updates: Partial<Omit<ChatConfig, "id" | "createdAt" | "workspaceId" | "mode">>,
  ): Promise<Chat | null> {
    const chat = await loadChat(chatId);
    if (!chat) {
      return null;
    }

    const config: ChatConfig = {
      ...chat.config,
      ...updates,
      model: updates.model ? { ...chat.config.model, ...updates.model } : chat.config.model,
      updatedAt: createTimestamp(),
    };

    const saved = await updateChatConfig(chatId, config);
    return saved ? { config, state: chat.state } : null;
  }

  async updateChatStatus(chatId: string, status: ChatStatus): Promise<Chat | null> {
    const chat = await loadChat(chatId);
    if (!chat) {
      return null;
    }

    const state = {
      ...chat.state,
      status,
      lastActivityAt: createTimestamp(),
    };
    if (status === "stopped" || status === "failed") {
      state.completedAt = state.completedAt ?? state.lastActivityAt;
    }

    const saved = await updateChatState(chatId, state);
    if (!saved) {
      return null;
    }

    this.emitter.emit({
      type: "chat.status",
      chatId,
      status,
      timestamp: state.lastActivityAt,
    });
    return { config: chat.config, state };
  }

  async attachSession(chatId: string, session: SessionInfo): Promise<Chat | null> {
    const chat = await loadChat(chatId);
    if (!chat) {
      return null;
    }

    const now = createTimestamp();
    const state = {
      ...chat.state,
      session,
      startedAt: chat.state.startedAt ?? now,
      lastActivityAt: now,
    };

    const saved = await updateChatState(chatId, state);
    return saved ? { config: chat.config, state } : null;
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const deleted = await deleteChat(chatId);
    if (deleted) {
      this.emitter.emit({
        type: "chat.deleted",
        chatId,
        timestamp: createTimestamp(),
      });
      await backendManager.disconnectChat(chatId);
    }
    return deleted;
  }

  getChatBackend(chatId: string, workspaceId: string): Backend {
    return backendManager.getChatBackend(chatId, workspaceId);
  }

  async disconnectChat(chatId: string): Promise<void> {
    await backendManager.disconnectChat(chatId);
  }
}

export const chatManager = new ChatManager();
