import { createLogger } from "@pablozaiden/webapp/server";
import type { ChatMetadata } from "@/shared/chat";
import { hasRemoteChatContinuity } from "@/shared/chat";
import type { CurrentUser } from "@/platform/contracts";
import { requireExecutionOwnerUser, runWithExecutionOwner } from "../context/user-context";
import { runForEachActiveUser } from "./background-users";
import { chatEventEmitter } from "./event-emitter";
import { chatManager } from "./chat-manager";
import { loadAutomationRunSummaryByChatId } from "../persistence/automations";
import { isAutomationCodeEnabled, isAutomationRunActiveStatus } from "@/shared/automation";
import { listPendingRemoteInterruptions } from "../persistence/chats/queries";

const log = createLogger("core:remote-chat-recovery");
interface Recovery {
  owner: CurrentUser;
  chatId: string;
  controller: AbortController;
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
  operation?: Promise<void>;
}

class RemoteChatRecovery {
  private readonly jobs = new Map<string, Recovery>();
  private unsubscribe?: () => void;
  private stopped = true;

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = chatEventEmitter.subscribe((event) => {
      if (event.type === "chat.updated") this.schedule(event.chat);
    });
    await runForEachActiveUser(async () => {
      for (const chat of await chatManager.getChatSummaries()) {
        if (chat.state.status !== "idle") this.schedule(chat, true);
      }
      for (const chat of await listPendingRemoteInterruptions()) {
        if (chat.config.scope !== "automation") this.schedule(chat, true);
      }
    });
  }

  private eligible(chat: ChatMetadata): boolean {
    return hasRemoteChatContinuity(chat) && chat.state.connectionStatus !== "connected"
      && (chat.state.interruptRequested || !["done", "stopped", "failed", "interrupting"].includes(chat.state.status));
  }

  recover(chat: ChatMetadata): void {
    this.schedule(chat, true);
  }

  private schedule(chat: ChatMetadata, startup = false): void {
    if (this.stopped || !this.eligible(chat)) return;
    if (!startup && chat.state.status !== "reconnecting" && !chat.state.interruptRequested) return;
    const owner = requireExecutionOwnerUser();
    const key = JSON.stringify([owner.id, chat.config.id]);
    if (this.jobs.has(key)) return;
    const job: Recovery = { owner, chatId: chat.config.id, controller: new AbortController(), failures: 0 };
    this.jobs.set(key, job);
    this.enqueue(key, job);
  }

  private enqueue(key: string, job: Recovery): void {
    if (this.stopped || job.controller.signal.aborted) { this.jobs.delete(key); return; }
    job.timer = setTimeout(() => {
      job.timer = undefined;
      job.operation = runWithExecutionOwner(job.owner, async () => {
        let retry = false;
        try {
          const current = await chatManager.getChatSummary(job.chatId);
          if (!current || !this.eligible(current)) return;
          if (current.config.scope === "automation" && !current.state.interruptRequested) {
            const run = await loadAutomationRunSummaryByChatId(job.chatId);
            if (!run || !isAutomationRunActiveStatus(run.status) || isAutomationCodeEnabled(run.configSnapshot)) return;
          }
          if (current.state.interruptRequested) {
            await chatManager.interruptChat(job.chatId, undefined, job.controller.signal);
          } else await chatManager.reconnectSession(job.chatId, { signal: job.controller.signal });
        } catch (error) {
          if (job.controller.signal.aborted) return;
          log.warn("Remote conversation reattachment failed", { chatId: job.chatId, error: String(error) });
          job.failures++;
          const current = await chatManager.getChatSummary(job.chatId);
          retry = current !== null && this.eligible(current);
        } finally {
          job.operation = undefined;
          if (retry && !this.stopped) this.enqueue(key, job);
          else this.jobs.delete(key);
        }
      }).catch((error: unknown) => {
        this.jobs.delete(key);
        log.error("Remote conversation recovery failed", { chatId: job.chatId, error: String(error) });
      });
    }, job.failures ? Math.min(30_000, 250 * 2 ** Math.min(job.failures, 7)) : 0);
    job.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) {
      clearTimeout(job.timer);
      job.controller.abort();
    }
    await Promise.all(jobs.map((job) => job.operation));
    this.jobs.clear();
  }
}

export const remoteChatRecovery = new RemoteChatRecovery();
