/**
 * Recoverable standalone chat deletion; task/agent cleanup stays permanent.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import { CHAT_TRASH_RETENTION_MS, isStandaloneChat } from "@/shared/chat";
import { createTimestamp } from "@/shared/events";
import type { ChatTrashQuery, ChatTrashResult } from "@/contracts/schemas/chat-trash";
import { DomainError } from "../domain/domain-error";
import {
  deleteTrashedChat,
  listChatTrash,
  listTrashCleanupCandidates,
  loadTrashedChat,
  markChatTrashed,
  restoreTrashedChat,
} from "../persistence/chats/trash";
import { KeyedOperationQueue } from "../utils/keyed-operation-queue";
import { withWorkspaceExecutionLock } from "./workspace-execution-lock";
import type { ChatCleanupCredentials, ChatConversationPort, ChatStatePort } from "./chat-service-contracts";
import type { ChatLifecycleService } from "./chat-lifecycle-service";

const log = createLogger("chat-trash");

export class ChatTrashService {
  private readonly operations = new KeyedOperationQueue();

  constructor(
    private readonly state: ChatStatePort,
    private readonly lifecycle: Pick<ChatLifecycleService, "cleanupTrashResources">,
    private readonly conversation: Pick<ChatConversationPort, "checkpointForDeletion">,
  ) {}

  list(options: ChatTrashQuery) { return listChatTrash(options); }

  async move(chatId: string, credentialToken?: string | null): Promise<void> {
    await this.run(chatId, async () => {
      if (loadTrashedChat(chatId)) return;
      const chat = await this.state.getChatSummary(chatId);
      if (!chat || !isStandaloneChat(chat)) throw this.notFound();
      const trashed = this.conversation.checkpointForDeletion(chatId, markChatTrashed);
      if (!trashed) throw this.notFound();
      this.state.emitChatDeleted(chat, createTimestamp());
      this.changed(chatId);
      // The persisted deletion fence keeps the chat unavailable even if its host
      // cannot finish disconnecting; restore retries quiescence before admission.
      try {
        const complete = await this.lifecycle.cleanupTrashResources(trashed, {
          preserveWorktree: true, credentialToken,
        });
        if (!complete) log.warn("Chat is in Trash with incomplete external cleanup", { chatId });
      } catch (error) {
        log.warn("Chat is in Trash with incomplete runtime cleanup", { chatId, error: String(error) });
      }
      log.info("Chat moved to Trash", { chatId });
    });
  }

  async restore(chatId: string): Promise<void> {
    await this.run(chatId, async () => {
      const chat = loadTrashedChat(chatId);
      if (!chat?.config.deletedAt) throw this.notFound();
      if (chat.config.workspaceId && !await this.state.getWorkspace(chat.config.workspaceId)) {
        throw this.notFound();
      }
      const complete = await this.lifecycle.cleanupTrashResources(chat, { preserveWorktree: true });
      if (!complete) throw new DomainError("trash_cleanup_failed", "The chat could not be safely disconnected. Try restoring it again.");
      if (!restoreTrashedChat(chatId, chat.config.deletedAt)) throw this.notFound();
      this.changed(chatId);
      this.state.emitChatUpdated({ ...chat, config: { ...chat.config, deletedAt: undefined } });
      log.info("Chat restored from Trash", { chatId });
    });
  }

  async purge(chatId: string, options: ChatCleanupCredentials & {
    deletedAt?: string; bestEffort?: boolean;
  } = {}): Promise<boolean> {
    return await this.operations.run(chatId, async () => {
      const chat = loadTrashedChat(chatId);
      if (!chat?.config.deletedAt || (options.deletedAt && chat.config.deletedAt !== options.deletedAt)) return false;
      let complete = false;
      try {
        complete = await this.lifecycle.cleanupTrashResources(chat, {
          preserveWorktree: true, ...options,
        });
        if (complete) {
          const latest = loadTrashedChat(chatId);
          if (!latest) return false;
          complete = await this.lifecycle.cleanupTrashResources(latest, {
            credentialToken: options.credentialToken,
            credentialTokensByServerId: options.credentialTokensByServerId,
          });
        }
      } catch (error) {
        log.warn("Trashed chat external cleanup failed", { chatId, error: String(error) });
      }
      if (!complete && !options.bestEffort) {
        throw new DomainError("trash_cleanup_failed", "The chat remains in Trash because external cleanup failed. Try again when its host is available.");
      }
      if (!complete) log.warn("Removing workspace Trash with incomplete external cleanup", { chatId });
      const deleted = deleteTrashedChat(chatId, chat.config.deletedAt);
      if (deleted) this.changed(chatId);
      return deleted;
    });
  }

  async empty(options: ChatCleanupCredentials & {
    cutoff?: string; workspaceId?: string; bestEffort?: boolean;
  } = {}): Promise<ChatTrashResult> {
    const cutoff = options.cutoff ?? createTimestamp();
    const result: ChatTrashResult = { deletedCount: 0, failedCount: 0, failures: [] };
    let after: { id: string; deletedAt: string } | undefined;
    for (;;) {
      const candidates = listTrashCleanupCandidates({ cutoff, after, workspaceId: options.workspaceId });
      if (!candidates.length) return result;
      for (const candidate of candidates) {
        try {
          if (await this.purge(candidate.id, { ...options, deletedAt: candidate.deletedAt })) result.deletedCount++;
        } catch (error) {
          result.failedCount++;
          log.warn("Failed to permanently delete trashed chat", { chatId: candidate.id, error: String(error) });
          if (result.failures.length < 100) result.failures.push({
            chatId: candidate.id, message: "External cleanup failed; the chat remains in Trash.",
          });
        }
      }
      after = candidates.at(-1)!;
    }
  }

  async expire(): Promise<void> {
    const result = await this.empty({ cutoff: new Date(Date.now() - CHAT_TRASH_RETENTION_MS).toISOString() });
    if (result.deletedCount) log.info("Expired chats removed from Trash", { deletedCount: result.deletedCount });
  }

  credentialTargets(chatId?: string): string[] {
    const serverIds = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = this.list({ limit: 100, includePrivate: "true", cursor });
      for (const item of page.items) {
        if (!chatId || item.id === chatId) {
          for (const serverId of item.credentialServerIds) serverIds.add(serverId);
          if (chatId) return [...serverIds];
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    if (chatId) throw this.notFound();
    return [...serverIds];
  }

  async runLiveOperation<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const chat = await this.state.getChatSummary(chatId);
    if (!chat || !isStandaloneChat(chat)) return await operation();
    return await this.run(chatId, async () => {
      if (!await this.state.getChatSummary(chatId)) throw this.notFound();
      return await operation();
    });
  }

  private async run<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const chat = await this.state.getChatSummary(chatId) ?? loadTrashedChat(chatId);
    const run = () => this.operations.run(chatId, operation);
    return chat?.config.workspaceId ? await withWorkspaceExecutionLock(chat.config.workspaceId, run) : await run();
  }

  private changed(chatId: string): void {
    this.state.emit({ type: "chat.trash.changed", chatId, timestamp: createTimestamp() });
  }

  private notFound(): DomainError {
    return new DomainError("trashed_chat_not_found", "Chat not found in Trash");
  }
}
