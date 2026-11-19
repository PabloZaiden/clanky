import { createLogger } from "@pablozaiden/webapp/server";
import type { ChatMetadata } from "@/shared/chat";
import { isStandaloneChat } from "@/shared/chat";
import { chatEventEmitter } from "./event-emitter";
import { chatManager } from "./chat-manager";
import { runForEachActiveUser } from "./background-users";

const log = createLogger("chat-provider-recovery");

interface PendingContinuation {
  ownerId: string;
  chatId: string;
  interruptionId: string;
  nextAttemptAt: string;
  timer?: ReturnType<typeof setTimeout>;
  operation?: Promise<void>;
}

class ChatProviderRecovery {
  private readonly pending = new Map<string, PendingContinuation>();
  private unsubscribe?: () => void;
  private stopped = true;

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = chatEventEmitter.subscribe((event, context) => {
      if (event.type === "chat.updated" && context.userId) this.watch(event.chat, context.userId);
      if (event.type === "chat.deleted" && context.userId) {
        const key = JSON.stringify([context.userId, event.chatId]);
        const job = this.pending.get(key);
        if (job?.timer) clearTimeout(job.timer);
        if (!job?.operation) this.pending.delete(key);
      }
    });
    await runForEachActiveUser(async (user) => {
      for (const chat of await chatManager.getChatSummaries()) {
        const limit = chat.state.harness?.providerLimit;
        if (limit?.continuation?.status === "attempting") {
          await chatManager.attemptProviderContinuation(chat.config.id, limit.id, true);
        } else this.watch(chat, user.id);
      }
    });
  }

  private watch(chat: ChatMetadata, ownerId: string): void {
    if (this.stopped) return;
    const key = JSON.stringify([ownerId, chat.config.id]);
    const existing = this.pending.get(key);
    if (existing?.operation) return;
    const limit = chat.state.harness?.providerLimit;
    const continuation = limit?.continuation;
    const nextAttemptAt = continuation?.nextAttemptAt;
    const eligible = isStandaloneChat(chat) && chat.state.status === "blocked"
      && limit?.kind !== "billing" && continuation?.status === "scheduled" && nextAttemptAt;
    if (eligible && existing?.interruptionId === limit!.id && existing.nextAttemptAt === nextAttemptAt) return;
    if (existing?.timer) clearTimeout(existing.timer);
    this.pending.delete(key);
    if (!eligible) return;
    const job: PendingContinuation = {
      ownerId, chatId: chat.config.id, interruptionId: limit!.id, nextAttemptAt,
    };
    this.pending.set(key, job);
    const delay = Math.min(2_147_483_647, Math.max(0, Date.parse(nextAttemptAt) - Date.now()));
    job.timer = setTimeout(() => {
      job.timer = undefined;
      job.operation = this.run(key, job);
    }, delay);
    job.timer.unref?.();
  }

  private async run(key: string, job: PendingContinuation): Promise<void> {
    try {
      // Resolve the active account again instead of retaining request-time authority.
      await runForEachActiveUser(async (user) => {
        if (this.stopped || user.id !== job.ownerId) return;
        try {
          await chatManager.attemptProviderContinuation(job.chatId, job.interruptionId);
        } finally {
          this.pending.delete(key);
          const current = await chatManager.getChatSummary(job.chatId);
          if (current) this.watch(current, user.id);
        }
      });
    } catch (error) {
      log.error("Provider continuation scheduling failed", { chatId: job.chatId, error: String(error) });
    } finally {
      if (this.pending.get(key) === job) this.pending.delete(key);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const jobs = [...this.pending.values()];
    for (const job of jobs) if (job.timer) clearTimeout(job.timer);
    await Promise.all(jobs.map((job) => job.operation));
    this.pending.clear();
  }
}

export const chatProviderRecovery = new ChatProviderRecovery();
