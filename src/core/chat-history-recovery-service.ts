/**
 * Explicitly starts a fresh provider session backed by an exported chat history.
 */

import type { Chat, HarnessHistoryRecovery } from "@/shared";
import { createTimestamp } from "@/shared/events";
import { isChatBusyStatus } from "@/shared/chat";
import { isQuestionOpen } from "@/shared/harness-questions";
import { createLogger } from "@pablozaiden/webapp/server";
import { DomainError } from "@/domain/domain-error";
import { ChatHistoryExportService } from "./chat-history-export-service";
import type {
  ChatConversationPort,
  ChatSessionPort,
  ChatStatePort,
  ReconnectChatOptions,
} from "./chat-service-contracts";

const log = createLogger("core:chat-history-recovery-service");

export interface ChatHistoryRecoveryServiceDependencies {
  state: ChatStatePort;
  session: Pick<ChatSessionPort, "createSessionFromHistory">;
  conversation: Pick<ChatConversationPort, "hasActiveStream">;
  historyExport: ChatHistoryExportService;
}

export class ChatHistoryRecoveryService {
  private readonly state: ChatStatePort;
  private readonly session: ChatHistoryRecoveryServiceDependencies["session"];
  private readonly conversation: ChatHistoryRecoveryServiceDependencies["conversation"];
  private readonly historyExport: ChatHistoryExportService;

  constructor(dependencies: ChatHistoryRecoveryServiceDependencies) {
    this.state = dependencies.state;
    this.session = dependencies.session;
    this.conversation = dependencies.conversation;
    this.historyExport = dependencies.historyExport;
  }

  async continueFromHistory(
    chatId: string,
    options: ReconnectChatOptions = {},
  ): Promise<Chat | null> {
    const originalChat = await this.state.getChatSummary(chatId);
    if (!originalChat) {
      return null;
    }
    this.assertRecoverable(originalChat);

    let reservationStarted = false;
    let exportAllocated: HarnessHistoryRecovery | undefined;
    let sessionCreationStarted = false;
    let recoveryCommitted = false;
    const originalSessionId = originalChat.state.session?.id;
    const originalRecoveryId = originalChat.state.harness?.historyRecovery?.id;
    try {
      let reservationValid = false;
      await this.state.mutateState(chatId, (current) => {
        if (
          !this.isRecoverable(current)
          || this.hasUnresolvedWork(current)
          || this.conversation.hasActiveStream(chatId)
          || current.state.session?.id !== originalSessionId
          || current.state.harness?.historyRecovery?.id !== originalRecoveryId
        ) {
          return;
        }
        reservationValid = true;
        return {
          ...current.state,
          status: "starting",
          startupStage: "connecting_provider",
          error: undefined,
          lastActivityAt: createTimestamp(),
        };
      });
      if (!reservationValid) {
        throw new DomainError(
          "chat_history_recovery_conflict",
          "The chat changed before history recovery could start. Refresh it and resolve any active or queued input first.",
        );
      }
      reservationStarted = true;

      const previousRecovery = originalChat.state.harness?.historyRecovery;
      if (previousRecovery && previousRecovery.status !== "complete") {
        await this.historyExport.cleanup(
          originalChat,
          previousRecovery,
          options.credentialToken,
        );
      }

      const exportChat = await this.requireChatSummary(chatId);
      const session = exportChat.state.session;
      const previousSession = session
        ? {
            id: session.id,
            ...(session.serverUrl ? { serverUrl: session.serverUrl } : {}),
            ...(session.binding !== undefined
              ? { binding: session.binding }
              : {}),
          }
        : undefined;
      const recovery = await this.historyExport.create(exportChat, {
        credentialToken: options.credentialToken,
        previousSession,
        onAllocated: async (allocated) => {
          exportAllocated = allocated;
          let persisted = false;
          await this.state.mutateState(chatId, (current) => {
            if (
              current.state.status !== "starting"
              || current.state.session?.id !== originalSessionId
              || current.state.harness?.historyRecovery?.id !== originalRecoveryId
            ) {
              return;
            }
            persisted = true;
            return {
              ...current.state,
              harness: {
                ...current.state.harness,
                historyRecovery: allocated,
              },
            };
          });
          if (!persisted) {
            throw new DomainError(
              "chat_history_recovery_conflict",
              "The chat changed while its history export was being prepared.",
            );
          }
        },
      });
      exportAllocated = { ...recovery, status: "exporting" };

      const chatForSession = await this.requireChat(chatId);
      sessionCreationStarted = true;
      const createdSession = await this.session.createSessionFromHistory(
        chatForSession,
        {
          directory: recovery.directory,
          credentialToken: options.credentialToken,
          signal: options.signal,
        },
      );

      let committed = false;
      const readyChat = await this.state.mutateState(chatId, (current) => {
        if (
          current.state.status !== "starting"
          || current.state.session?.id !== createdSession.state.session?.id
          || current.state.harness?.historyRecovery?.id !== recovery.id
          || current.state.harness?.historyRecovery?.status !== "exporting"
        ) {
          return;
        }
        committed = true;
        return {
          ...current.state,
          status: "idle",
          startupStage: undefined,
          error: undefined,
          completedAt: undefined,
          activeMessageId: undefined,
          interruptRequested: false,
          connectionStatus: "connected",
          lastActivityAt: createTimestamp(),
          harness: {
            ...current.state.harness,
            historyRecovery: { ...recovery, status: "pending" },
          },
        };
      });
      if (!committed) {
        throw new DomainError(
          "chat_history_recovery_conflict",
          "The chat changed after its replacement provider session was created.",
        );
      }
      recoveryCommitted = true;
      return readyChat;
    } catch (error) {
      const latest = await this.state.getChatSummary(chatId);
      const currentSessionId = latest?.state.session?.id;
      const replacementSessionExists = Boolean(
        currentSessionId
        && currentSessionId !== originalSessionId,
      );
      let cleanupError: unknown;

      if (exportAllocated && !recoveryCommitted) {
        if (replacementSessionExists && latest) {
          try {
            await this.markRecoveryPending(latest, exportAllocated);
          } catch (markError) {
            cleanupError = markError;
          }
        } else {
          try {
            await this.cleanFailedExport(
              latest ?? originalChat,
              exportAllocated,
              options,
              error,
            );
          } catch (failedCleanup) {
            cleanupError = failedCleanup;
          }
        }
      }

      if (reservationStarted && !sessionCreationStarted) {
        await this.restoreFailedChatState(chatId, originalChat, error);
      } else if (reservationStarted && sessionCreationStarted && latest) {
        const current = await this.state.getChat(chatId);
        if (current?.state.status === "starting") {
          await this.state.markChatError(current, String(error));
        }
      }
      if (cleanupError) {
        throw cleanupError;
      }
      throw error;
    }
  }

  private assertRecoverable(chat: Chat): void {
    if (!this.isRecoverable(chat) || this.conversation.hasActiveStream(chat.config.id)) {
      throw new DomainError(
        "chat_history_recovery_unavailable",
        "Continue from history is available only for a failed chat with no active run.",
      );
    }
    if ((chat.state.queuedMessages ?? []).length > 0) {
      throw new DomainError(
        "chat_history_recovery_queued_input",
        "Remove or send the queued messages before continuing from history.",
      );
    }
    if (chat.state.harness?.inputs?.some(
      (receipt) => receipt.admission.status === "unknown",
    )) {
      throw new DomainError(
        "chat_history_recovery_unresolved_input",
        "Reconcile the delivery status of pending chat input before continuing from history.",
      );
    }
    if (chat.state.harness?.questions?.some(isQuestionOpen)) {
      throw new DomainError(
        "chat_history_recovery_unresolved_question",
        "Resolve or dismiss the pending agent question before continuing from history.",
      );
    }
    if (chat.state.pendingPermissionRequests?.some(
      (request) => request.status === "pending",
    )) {
      throw new DomainError(
        "chat_history_recovery_unresolved_permission",
        "Resolve the pending agent permission request before continuing from history.",
      );
    }
  }

  private isRecoverable(chat: Chat): boolean {
    return chat.state.status === "failed"
      && !isChatBusyStatus(chat.state.status);
  }

  private hasUnresolvedWork(chat: Chat): boolean {
    return (chat.state.queuedMessages ?? []).length > 0
      || Boolean(chat.state.harness?.inputs?.some(
        (receipt) => receipt.admission.status === "unknown",
      ))
      || Boolean(chat.state.harness?.questions?.some(isQuestionOpen))
      || Boolean(chat.state.pendingPermissionRequests?.some(
        (request) => request.status === "pending",
      ));
  }

  private async requireChat(chatId: string): Promise<Chat> {
    const chat = await this.state.getChat(chatId);
    if (!chat) {
      throw new DomainError(
        "chat_not_found",
        "The chat was deleted while history recovery was in progress.",
      );
    }
    return chat;
  }

  private async requireChatSummary(chatId: string): Promise<Chat> {
    const chat = await this.state.getChatSummary(chatId);
    if (!chat) {
      throw new DomainError(
        "chat_not_found",
        "The chat was deleted while history recovery was in progress.",
      );
    }
    return chat;
  }

  private async markRecoveryPending(
    chat: Chat,
    recovery: HarnessHistoryRecovery,
  ): Promise<void> {
    await this.state.mutateState(chat.config.id, (current) => {
      const currentRecovery = current.state.harness?.historyRecovery;
      if (!currentRecovery || currentRecovery.id !== recovery.id) {
        return;
      }
      return {
        ...current.state,
        harness: {
          ...current.state.harness,
          historyRecovery: { ...recovery, status: "pending" },
        },
      };
    });
  }

  private async cleanFailedExport(
    chat: Chat,
    recovery: HarnessHistoryRecovery,
    options: ReconnectChatOptions,
    originalError: unknown,
  ): Promise<void> {
    try {
      await this.historyExport.cleanup(chat, recovery, options.credentialToken);
    } catch (cleanupError) {
      log.error("Failed to clean up chat history after recovery failed", {
        chatId: chat.config.id,
        error: String(cleanupError),
      });
      throw new DomainError(
        "chat_history_export_cleanup_failed",
        "History recovery failed and its temporary export could not be removed.",
        { cause: new AggregateError([originalError, cleanupError]) },
      );
    }
  }

  private async restoreFailedChatState(
    chatId: string,
    originalChat: Chat,
    originalError: unknown,
  ): Promise<void> {
    await this.state.mutateState(chatId, (current) => {
      if (current.state.status !== "starting") {
        return;
      }
      return {
        ...current.state,
        status: originalChat.state.status,
        startupStage: originalChat.state.startupStage,
        error: originalChat.state.error,
        lastActivityAt: originalChat.state.lastActivityAt,
      };
    }).catch((rollbackError) => {
      log.error("Failed to restore chat state after history recovery failed", {
        chatId,
        error: String(rollbackError),
        cause: String(originalError),
      });
    });
  }
}
