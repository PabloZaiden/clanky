/**
 * Persistence and state-event boundary for chat workflows.
 */

import {
  deleteChat,
  getWorkspaceChatNameStats,
  listChatSummaries,
  listChatSummariesByWorkspace,
  listChats,
  listChatsByWorkspace,
  loadChat,
  loadChatMetadata,
  loadChatStreamControlState,
  loadTaskChat,
  getChatTranscriptMeta,
  getChatToolCallFromTranscript,
  listChatTranscriptEntriesPage,
  saveChat,
  updateChatConfig,
  updateChatState,
  updateChatStreamState,
} from "../persistence/chats";
import { createTranscriptFromStoragePage } from "./transcript-service";
import { getWorkspace, touchWorkspace } from "../persistence/workspaces";
import type {
  Chat,
  ChatConfig,
  ChatState,
  ChatStatus,
  ChatStreamControlState,
  ChatStartupStage,
  TranscriptChangeSet,
  Workspace,
  TranscriptSnapshotOptions,
} from "@/shared";
import { createTranscriptChangeSet } from "@/shared";
import type { ChatSnapshot, ToolCallRecord } from "@/shared";
import type { ChatEvent } from "@/shared/events";
import { createTimestamp } from "@/shared/events";
import { ChatBusyError, isStandaloneChat, shouldIncludeConversationTranscriptLog } from "@/shared";
import { chatEventEmitter, SimpleEventEmitter } from "./event-emitter";
import type { ChatStatePort } from "./chat-service-contracts";
import { closeOpenQuestions, reconcileQuestionAnswerAdmissions } from "@/shared/harness-questions";
import { KeyedOperationQueue } from "../utils/keyed-operation-queue";
import { HarnessError } from "../backends/harness-errors";
import { projectQuestionMessages } from "@/shared/question-transcript";

export class ChatStateService implements ChatStatePort {
  private readonly mutations = new KeyedOperationQueue();

  constructor(
    private readonly emitter: SimpleEventEmitter<ChatEvent> = chatEventEmitter,
  ) {}

  async getChat(chatId: string): Promise<Chat | null> {
    return loadChat(chatId);
  }

  async getChatSummary(chatId: string): Promise<Chat | null> {
    return loadChatMetadata(chatId);
  }

  async getChatStreamControlState(chatId: string): Promise<ChatStreamControlState | null> {
    return loadChatStreamControlState(chatId);
  }

  async getChatSnapshot(
    chatId: string,
    options: TranscriptSnapshotOptions = {},
  ): Promise<ChatSnapshot | null> {
    const chat = await loadChatMetadata(chatId);
    if (!chat) {
      return null;
    }

    const meta = getChatTranscriptMeta(chatId);
    if (!meta) {
      throw new Error(`Chat transcript metadata is unavailable: ${chatId}`);
    }

    const page = listChatTranscriptEntriesPage(chatId, options);
    const { messages: _messages, logs: _logs, toolCalls: _toolCalls, ...state } = chat.state;
    return {
      config: chat.config,
      state,
      transcript: createTranscriptFromStoragePage(page, {
        revision: meta.revision,
        totalEntries: meta.entryCount,
      }, shouldIncludeConversationTranscriptLog),
    };
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

  async updateConfig(
    chatId: string,
    config: ChatConfig,
    options?: { expectedName?: string },
  ): Promise<Chat | null> {
    const saved = await updateChatConfig(chatId, config, options);
    if (!saved) {
      return null;
    }
    return this.getChat(chatId);
  }

  updateState(
    chat: Chat,
    state: ChatState,
    options: {
      transcriptChanges?: TranscriptChangeSet;
      expectedStatus?: ChatStatus;
      streaming?: boolean;
    } = {},
  ): Promise<Chat> {
    return this.mutations.run(chat.config.id, () => this.persistState(chat, state, options));
  }

  mutateState(
    chatId: string,
    update: (current: Chat) => ChatState | undefined,
  ): Promise<Chat> {
    return this.mutations.run(chatId, async () => {
      const current = await this.getChat(chatId);
      if (!current) throw new HarnessError("harness_session_not_found", "The chat is unavailable.");
      // Keep the mutation synchronous so provider I/O never holds the state queue.
      const state = update(current);
      return state ? await this.persistState(current, state) : current;
    });
  }

  private async persistState(
    chat: Chat,
    state: ChatState,
    options: {
      transcriptChanges?: TranscriptChangeSet;
      expectedStatus?: ChatStatus;
      streaming?: boolean;
    } = {},
  ): Promise<Chat> {
    const preserveQueuedMessages = state.queuedMessages === chat.state.queuedMessages;
    const unchangedCollections = state.messages === chat.state.messages
      && state.logs === chat.state.logs && state.toolCalls === chat.state.toolCalls;
    if (state.harness?.inputs !== chat.state.harness?.inputs) {
      state = {
        ...state,
        harness: reconcileQuestionAnswerAdmissions(state.harness, state.queuedMessages?.map((message) => message.id) ?? []),
      };
    }
    const questionMessages = state.harness?.questions !== chat.state.harness?.questions
      ? projectQuestionMessages(state.messages, state.harness?.questions)
      : [];
    if (questionMessages.length) {
      const updates = new Map(questionMessages.map((message) => [message.id, message]));
      state = {
        ...state,
        messages: state.messages.map((message) => {
          const updated = updates.get(message.id);
          updates.delete(message.id);
          return updated ?? message;
        }).concat([...updates.values()]),
      };
    }
    const questionUpserts = questionMessages.map((message) => ({
      id: message.id, kind: "message" as const, timestamp: message.timestamp, payload: message,
    }));
    const transcriptChanges = options.transcriptChanges
      ? {
          ...options.transcriptChanges,
          upserts: [...options.transcriptChanges.upserts, ...questionUpserts],
          entryCount: state.messages.length + state.logs.length + state.toolCalls.length,
        }
      : unchangedCollections ? createTranscriptChangeSet(state, questionUpserts) : undefined;
    const saved = options.streaming
      ? await updateChatStreamState(chat.config.id, state.lastActivityAt, {
        transcriptChanges,
        expectedStatus: options.expectedStatus,
      })
      : await updateChatState(chat.config.id, state, {
        preserveQueuedMessages,
        preserveHarnessState: state.harness === chat.state.harness,
        previousState: chat.state,
        transcriptChanges,
        expectedStatus: options.expectedStatus,
      });
    if (!saved) {
      if (options.expectedStatus !== undefined) {
        const latest = await this.getChat(chat.config.id);
        if (latest && latest.state.status !== options.expectedStatus) {
          throw new ChatBusyError("Chat changed while marking it as done");
        }
      }
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
    for (const message of questionMessages) {
      this.emitter.emit({
        type: "chat.message", chatId: chat.config.id, scope: chat.config.scope,
        message, timestamp: state.lastActivityAt ?? createTimestamp(),
      });
    }
    return updated;
  }

  async updateStartupStage(
    chat: Chat,
    startupStage: ChatStartupStage | undefined,
    options: { expectedStatus?: ChatStatus } = {},
  ): Promise<Chat> {
    let current = chat;
    if (options.expectedStatus !== undefined) {
      const latest = await this.getChat(chat.config.id);
      if (!latest) {
        throw new Error(`Chat not found: ${chat.config.id}`);
      }
      if (latest.state.status !== options.expectedStatus) {
        throw new ChatBusyError("Chat changed while updating startup stage");
      }
      current = latest;
    }
    if (current.state.startupStage === startupStage) {
      return current;
    }

    const updated = await this.updateState(current, {
      ...current.state,
      startupStage,
      lastActivityAt: createTimestamp(),
    }, options);
    this.emitChatUpdated(updated);
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
      harness: { ...chat.state.harness, questions: closeOpenQuestions(chat.state.harness?.questions, "expired") },
      startupStage: undefined,
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
