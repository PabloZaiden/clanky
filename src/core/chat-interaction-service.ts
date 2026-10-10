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
  ChatBusyError,
  ChatPermissionReplyError,
  ChatPermissionRequestNotFoundError,
  isChatBusyStatus,
} from "@/shared/chat";
import { createTimestamp } from "@/shared/events";
import { createLogger } from "@pablozaiden/webapp/server";
import { HarnessError } from "../backends/harness-errors";
import type { HarnessInputAdmission } from "@/shared/harness-control";
import { isHarnessInputValidationError, retainHarnessInputReceipt } from "./harness-input-ledger";
import type { DomainError } from "../domain/domain-error";
import type { ChatQuestionService } from "./chat-question-service";
import { buildPromptParts } from "../backends/prompt-parts";
import { KeyedOperationQueue } from "../utils/keyed-operation-queue";
import { requireMatchingHarnessBinding } from "../backends/harness-binding";
import { updateQuestionAnswerStatus } from "@/shared/harness-questions";
import { isClankyControlChat } from "@/shared/clanky-control";
import { preferencesManager } from "./preferences-manager";
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
  private readonly queuedCredentialTokens = new Map<string, string>();
  private readonly inputOperations = new KeyedOperationQueue();
  private readonly state: ChatStatePort;
  private readonly conversation: ChatConversationPort;
  private readonly session: ChatSessionPort;

  constructor(dependencies: {
    state: ChatStatePort;
    conversation: ChatConversationPort;
    session: ChatSessionPort;
    questions?: Pick<ChatQuestionService, "reply">;
  }) {
    this.state = dependencies.state;
    this.conversation = dependencies.conversation;
    this.session = dependencies.session;
    this.questions = dependencies.questions;
  }
  private readonly questions?: Pick<ChatQuestionService, "reply">;

  replyToQuestion(chatId: string, requestId: string, answers: string[][], clientId?: string): Promise<Chat> {
    if (!this.questions) throw new HarnessError("harness_unsupported_feature", "Chat questions are unavailable.");
    return this.questions.reply(chatId, requestId, answers, clientId);
  }

  sendMessage(chatId: string, options: ChatMessageOptions): Promise<Chat> {
    return this.serializeInput(chatId, () => this.sendMessageUnlocked(chatId, options));
  }

  private async sendMessageUnlocked(chatId: string, options: ChatMessageOptions): Promise<Chat> {
    const chat = await this.state.getChat(chatId);
    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }
    if (chat.state.harness?.integrity === "invalid") throw new HarnessError("harness_request_failed", "Input admission history is corrupt.");

    const input = this.normalizeMessageInput(options);
    const activeChat = await this.reactivateDoneChat(chat);
    if (this.shouldQueueMessage(activeChat)) {
      return this.enqueueMessage(activeChat, input, options.credentialToken);
    }

    try {
      return await this.conversation.dispatchMessage(activeChat, input, {
        credentialToken: options.credentialToken,
      });
    } catch (error) {
      if (!(error instanceof ChatBusyError)) {
        throw error;
      }

      const latest = await this.state.getChat(chatId);
      if (latest && this.shouldQueueMessage(latest)) {
        return this.enqueueMessage(latest, input, options.credentialToken);
      }
      throw error;
    }
  }

  removeQueuedMessage(chatId: string, queuedMessageId: string): Promise<Chat | null> {
    return this.serializeInput(chatId, () => this.removeQueuedMessageUnlocked(chatId, queuedMessageId));
  }

  private async removeQueuedMessageUnlocked(chatId: string, queuedMessageId: string): Promise<Chat | null> {
    const chat = await this.state.getChat(chatId);
    if (!chat) {
      return null;
    }

    const queuedMessages = chat.state.queuedMessages ?? [];
    if (chat.state.harness?.integrity === "invalid") throw new HarnessError("harness_request_failed", "Input admission history is corrupt.");
    if (chat.state.harness?.inputs?.some((receipt) => receipt.admission.inputId === queuedMessageId && receipt.admission.status !== "rejected")) {
      throw new HarnessError("harness_input_unresolved", "This input has unknown native admission and cannot be removed as an unsent message.");
    }
    const nextQueuedMessages = queuedMessages.filter((queuedMessage) => queuedMessage.id !== queuedMessageId);
    if (nextQueuedMessages.length === queuedMessages.length) {
      return chat;
    }
    if (nextQueuedMessages.length === 0) {
      this.queuedCredentialTokens.delete(chatId);
    }

    const updated = await this.state.updateState(chat, {
      ...chat.state,
      queuedMessages: nextQueuedMessages,
      harness: updateQuestionAnswerStatus(chat.state.harness, queuedMessageId, "pending"),
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
        await this.serializeInput(chatId, () => this.drainQueuedMessages(chatId));
      } catch (error) {
        log.error("Failed to drain queued chat messages", { chatId, error: String(error) });
      } finally {
        this.queuedMessageDrains.delete(chatId);
      }
    })();
  }

  private async isControlChat(chat: Chat): Promise<boolean> {
    const settings = await preferencesManager.getQuickChatSettings();
    return isClankyControlChat(chat, settings.workspaceId);
  }

  steerQueuedMessage(chatId: string, queuedMessageId: string): Promise<{ chat: Chat; admission: HarnessInputAdmission }> {
    return this.serializeInput(chatId, async () => {
      let chat = await this.state.getChat(chatId);
      if (!chat) throw new HarnessError("harness_session_not_found", "The chat is unavailable.");
      if (chat.state.harness?.integrity === "invalid") throw new HarnessError("harness_request_failed", "Input admission history is corrupt.");
      const existing = chat.state.harness?.inputs?.find((receipt) => receipt.admission.inputId === queuedMessageId);
      if (existing && existing.admission.status !== "rejected") return { chat, admission: existing.admission };
      const message = chat.state.queuedMessages?.find((entry) => entry.id === queuedMessageId);
      if (!message) throw new HarnessError("harness_input_not_found", "The queued input is unavailable.");
      const binding = chat.state.session?.binding;
      const backend = this.session.getChatBackend(chatId, chat.config.workspaceId);
      if (binding && (binding.adapter !== backend.harness.capabilities.adapter || binding.nativeId !== chat.state.session?.id)) {
        throw new HarnessError("harness_session_not_owned", "The input belongs to a different conversation.");
      }
      if (!binding || !backend.isConnected() || chat.state.status !== "streaming") {
        return { chat, admission: { status: "rejected", inputId: queuedMessageId, code: "not-running" } };
      }
      if (backend.harness.capabilities.steering === "unsupported") {
        return { chat, admission: { status: "rejected", inputId: queuedMessageId, code: "unsupported" } };
      }
      const unknown: HarnessInputAdmission = { status: "unknown", inputId: queuedMessageId };
      chat = await this.state.updateState(chat, {
        ...chat.state,
        harness: {
          ...chat.state.harness,
          inputs: retainHarnessInputReceipt(chat.state.harness?.inputs ?? [], {
            conversation: binding, admission: unknown, submittedAt: createTimestamp(),
          }),
        },
      });
      this.state.emitChatUpdated(chat);
      // Durable unknown admission precedes the RPC, so interruption never causes blind resend.
      let admission: HarnessInputAdmission;
      let validationError: DomainError | undefined;
      try {
        admission = await backend.harness.steer(binding.nativeId, {
          inputId: queuedMessageId,
          clientId: message.clientId,
          prompt: { parts: buildPromptParts(message.content, message.attachments ?? []) },
        });
      } catch (error) {
        if (!isHarnessInputValidationError(error)) throw error;
        admission = { status: "rejected", inputId: queuedMessageId, code: "unsupported" };
        validationError = error;
      }
      if (admission.inputId !== queuedMessageId) throw new HarnessError("harness_event_gap", "Native input correlation changed during admission.");
      const latest = await this.state.getChat(chatId);
      if (!latest) throw new HarnessError("harness_session_not_found", "The chat was removed during input admission.");
      if (admission.status === "accepted" || admission.status === "delivered") {
        chat = await this.conversation.recordSteeredMessage(latest, message, admission);
      } else {
        chat = await this.state.updateState(latest, {
          ...latest.state,
          harness: {
            ...latest.state.harness,
            inputs: retainHarnessInputReceipt(latest.state.harness?.inputs ?? [], {
              conversation: binding, admission, submittedAt: createTimestamp(),
            }),
          },
        });
      }
      this.state.emitChatUpdated(chat);
      if (validationError) throw validationError;
      return { chat, admission };
    });
  }

  reconcileQueuedMessage(chatId: string, queuedMessageId: string): Promise<{ chat: Chat; admission: HarnessInputAdmission }> {
    return this.serializeInput(chatId, async () => {
      const chat = await this.state.getChat(chatId);
      if (!chat) throw new HarnessError("harness_session_not_found", "The chat is unavailable.");
      if (chat.state.harness?.integrity === "invalid") throw new HarnessError("harness_request_failed", "Input admission history is corrupt.");
      const receipt = chat.state.harness?.inputs?.find((entry) => entry.admission.inputId === queuedMessageId);
      if (!receipt) throw new HarnessError("harness_input_not_found", "Input admission is unavailable.");
      if (receipt.admission.status === "rejected" || receipt.admission.status === "delivered") return { chat, admission: receipt.admission };
      const binding = chat.state.session?.binding;
      const backend = this.session.getChatBackend(chatId, chat.config.workspaceId);
      if (!binding || binding.adapter !== backend.harness.capabilities.adapter) throw new HarnessError("harness_session_not_owned", "The input belongs to a replaced conversation.");
      requireMatchingHarnessBinding(JSON.stringify(receipt.conversation), binding);
      if (!backend.isConnected()) return { chat, admission: receipt.admission };
      const previous = receipt.admission;
      const admission = await backend.harness.reconcileInput(binding.nativeId, {
        inputId: queuedMessageId,
        nativeMessageId: previous.status === "accepted" ? previous.nativeMessageId : undefined,
        nativeClientInputId: previous.status === "accepted" ? previous.nativeClientInputId : undefined,
        nativeTurnId: previous.status === "accepted" ? previous.nativeTurnId : undefined,
      });
      if (admission.inputId !== queuedMessageId) throw new HarnessError("harness_event_gap", "Native input correlation changed during recovery.");
      if (admission.status === "unknown") return { chat, admission };
      const latest = await this.state.getChat(chatId);
      if (!latest) throw new HarnessError("harness_session_not_found", "The chat was removed during recovery.");
      const message = latest.state.queuedMessages?.find((entry) => entry.id === queuedMessageId);
      const updated = message && (admission.status === "accepted" || admission.status === "delivered")
        ? await this.conversation.recordSteeredMessage(latest, message, admission)
        : await this.state.updateState(latest, {
          ...latest.state,
          harness: {
            ...latest.state.harness,
            inputs: retainHarnessInputReceipt(latest.state.harness?.inputs ?? [], { ...receipt, admission }),
          },
        });
      this.state.emitChatUpdated(updated);
      return { chat: updated, admission };
    });
  }

  private serializeInput<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    return this.inputOperations.run(chatId, operation);
  }

  private normalizeMessageInput(options: ChatMessageOptions): NormalizedChatMessageInput {
    const message = options.message?.trim() ?? "";
    const attachments = options.attachments ?? [];
    if (!message && attachments.length === 0) {
      throw new Error("Message or attachments are required");
    }
    return {
      message,
      attachments,
      transcriptMessage: options.transcriptMessage,
      clientId: options.clientId,
    };
  }

  private shouldQueueMessage(chat: Chat): boolean {
    return isChatBusyStatus(chat.state.status) || chat.state.status === "reconnecting";
  }

  private async reactivateDoneChat(chat: Chat): Promise<Chat> {
    if (chat.state.status !== "done") {
      return chat;
    }

    return this.state.updateState(chat, {
      ...chat.state,
      status: "idle",
      error: undefined,
      completedAt: undefined,
      activeMessageId: undefined,
      interruptRequested: false,
      lastActivityAt: createTimestamp(),
    });
  }

  private async enqueueMessage(
    chat: Chat,
    input: NormalizedChatMessageInput,
    credentialToken?: string | null,
  ): Promise<Chat> {
    const now = createTimestamp();
    const queuedMessage = {
      id: input.transcriptMessage?.id ?? `chat-queued-${crypto.randomUUID()}`,
      content: input.message,
      attachments: input.attachments.length > 0 ? input.attachments : undefined,
      createdAt: now,
      transcriptMessage: input.transcriptMessage,
      clientId: input.clientId,
    };
    if ((chat.state.queuedMessages?.length ?? 0) >= 200) throw new HarnessError("harness_input_capacity", "Queued input capacity reached.");
    const updated = await this.state.updateState(chat, {
      ...chat.state,
      queuedMessages: [...(chat.state.queuedMessages ?? []), queuedMessage],
      harness: updateQuestionAnswerStatus(chat.state.harness, queuedMessage.id, "queued"),
      lastActivityAt: now,
    });
    const normalizedCredentialToken = credentialToken?.trim();
    if (normalizedCredentialToken) {
      this.queuedCredentialTokens.set(chat.config.id, normalizedCredentialToken);
    }
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

    if (chat.state.harness?.integrity === "invalid") throw new HarnessError("harness_request_failed", "Input admission history is corrupt.");
    const blocked = new Set((chat.state.harness?.inputs ?? []).filter((receipt) => receipt.admission.status !== "rejected").map((receipt) => receipt.admission.inputId));
    const availableMessages = (chat.state.queuedMessages ?? []).filter((message) => !blocked.has(message.id));
    // Question replies own an existing transcript message and cannot be folded
    // into a new combined composer message.
    const isControlChat = await this.isControlChat(chat);
    const questionIndex = availableMessages.findIndex((message) => message.transcriptMessage);
    const queuedMessages = isControlChat ? availableMessages.slice(0, 1)
      : questionIndex === 0 ? availableMessages.slice(0, 1)
        : questionIndex > 0 ? availableMessages.slice(0, questionIndex) : availableMessages;
    if (queuedMessages.length === 0) {
      return;
    }

    const message = queuedMessages
      .map((queuedMessage) => queuedMessage.content.trim())
      .filter((content) => content.length > 0)
      .join("\n");
    const attachments = queuedMessages.flatMap((queuedMessage) => queuedMessage.attachments ?? []);
    if (!message && attachments.length === 0) {
      this.queuedCredentialTokens.delete(chatId);
      const updated = await this.state.updateState(chat, {
        ...chat.state,
        queuedMessages: chat.state.queuedMessages?.filter((entry) => blocked.has(entry.id)),
        lastActivityAt: createTimestamp(),
      });
      this.state.emitChatUpdated(updated);
      return;
    }

    const credentialToken = this.queuedCredentialTokens.get(chatId);
    try {
      await this.conversation.dispatchMessage(
        chat,
        {
          message, attachments,
          transcriptMessage: queuedMessages[0]?.transcriptMessage,
          clientId: queuedMessages[0]?.clientId,
        },
        { clearQueuedMessageIds: queuedMessages.map((entry) => entry.id), credentialToken },
      );
    } catch (error) {
      const latestChat = await this.state.getChat(chatId);
      if (latestChat) {
        const message = `Failed to send queued chat messages: ${String(error)}`;
        log.error(message, { chatId });
        await this.state.markChatError(latestChat, message);
      }
    } finally {
      this.queuedCredentialTokens.delete(chatId);
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
