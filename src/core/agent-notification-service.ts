import { createLogger } from "@pablozaiden/webapp/server";
import {
  AgentNotificationSchema,
  NotificationWebhookUrlSchema,
  SetAgentNotificationSettingsSchema,
  type AgentNotificationSettings,
  type AgentNotification,
} from "@/contracts/schemas/agent-notifications";
import {
  getNotificationWebhookUrl, getNotificationPreferences, getNotificationDeliveryError,
  setNotificationDeliveryError, updateNotificationSettings,
} from "../persistence/preferences";
import { DomainError } from "../domain/domain-error";
import { requireCurrentUserId, requireExecutionOwnerUserId } from "../context/user-context";
import type { NotificationEventKind } from "@/shared/agent-notifications";
import { agentEventEmitter, taskEventEmitter } from "./event-emitter";

const log = createLogger("core:agent-notifications");

class AgentNotificationService {
  private controller?: AbortController;
  private unsubscribe: Array<() => void> = [];
  private readonly pending = new Set<Promise<void>>();
  private changed?: (userId: string) => void;

  async settings(): Promise<AgentNotificationSettings> {
    return {
      configured: await this.webhookUrl() !== null,
      ...getNotificationPreferences(),
      lastDeliveryError: getNotificationDeliveryError(),
    };
  }

  async configure(input: unknown): Promise<AgentNotificationSettings> {
    updateNotificationSettings(SetAgentNotificationSettingsSchema.parse(input));
    this.changed?.(requireCurrentUserId());
    return this.settings();
  }

  start(changed: (userId: string) => void): void {
    if (this.controller) throw new Error("Notification delivery is already running.");
    this.controller = new AbortController();
    this.changed = changed;
    this.unsubscribe = [
      taskEventEmitter.subscribe((event, context) => {
        if (!context.userId) return;
        switch (event.type) {
          case "task.error": this.notify("error", "Task", context.userId); break;
          case "task.stopped":
            if (event.blocked) this.notify("blocked", "Task", context.userId);
            break;
          case "task.plan.ready":
            if (event.requiresApproval) this.notify("planReady", "Task", context.userId);
            break;
          case "task.completed": this.notify("completed", "Task", context.userId); break;
        }
      }),
      agentEventEmitter.subscribe((event, context) => {
        if (!context.userId) return;
        if (event.type === "agent.run.failed") this.notify("error", "Agent run", context.userId);
        if (event.type === "agent.run.completed") this.notify("completed", "Agent run", context.userId);
      }),
    ];
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe = [];
    this.controller?.abort();
    await Promise.all(this.pending);
    this.controller = undefined;
    this.changed = undefined;
  }

  // The server lifecycle owns detached delivery; domain mutations never wait for a webhook.
  notify(event: NotificationEventKind, source: "Chat" | "Task" | "Agent run" | "Agent operation",
    ownerUserId = requireExecutionOwnerUserId()): void {
    const signal = this.controller?.signal;
    if (!signal || signal.aborted) return;
    const work = this.sendAutomatic(event, source, ownerUserId, signal).catch(() => {
      log.error("Could not record automatic notification delivery failure", { event, ownerUserId });
    }).finally(() => this.pending.delete(work));
    this.pending.add(work);
  }

  private async sendAutomatic(event: NotificationEventKind, source: string, ownerUserId: string,
    signal: AbortSignal): Promise<void> {
    let failure: string | undefined;
    try {
      const preferences = getNotificationPreferences(ownerUserId);
      if (!preferences.enabled || !preferences.events[event]) return;
      const url = await this.webhookUrl(ownerUserId);
      if (!url || signal.aborted) return;
      const current = getNotificationPreferences(ownerUserId);
      if (!current.enabled || !current.events[event]) return;
      const descriptions: Record<NotificationEventKind, string> = {
        error: "An error occurred.",
        blocked: "Work is blocked and needs your attention.",
        question: "A question needs your answer.",
        secret: "A private secret request needs your attention.",
        approval: "A permission or approval request needs your decision.",
        planReady: "A plan is ready for your approval.",
        completed: "Work has finished.",
      };
      const description = descriptions[event];
      const result = await this.deliver(url, {
        title: `${source}: ${description}`,
        shortDescription: description,
        markdownContent: `${source}: ${description}\n\nOpen Clanky to view the details.`,
      }, signal);
      if (!result.ok) failure = result.message;
    } catch {
      failure = "Automatic notification delivery could not be confirmed. Inspect Listen before sending again; no automatic retry will occur.";
    }
    if (failure) this.recordFailure(ownerUserId, failure);
  }

  private recordFailure(ownerUserId: string, message: string): void {
    setNotificationDeliveryError({ message, timestamp: new Date().toISOString() }, ownerUserId);
    log.warn("Automatic notification delivery failed", { ownerUserId });
    this.changed?.(ownerUserId);
  }

  private async webhookUrl(ownerUserId?: string): Promise<string | null> {
    const stored = await getNotificationWebhookUrl(ownerUserId);
    if (stored === null) return null;
    const parsed = NotificationWebhookUrlSchema.safeParse(stored);
    if (!parsed.success) {
      throw new DomainError("notification_configuration_invalid", "The saved notification webhook is invalid. Replace it in Settings.");
    }
    return parsed.data;
  }

  async send(input: unknown, signal: AbortSignal) {
    const payload = AgentNotificationSchema.parse(input);
    const url = await this.webhookUrl();
    if (!url) {
      log.warn("Notification webhook is not configured");
      return {
        ok: false, code: "notification_not_configured", completion: "not_executed",
        message: "Configure a Listen webhook in Settings > Agents & integrations before sending notifications.",
      };
    }
    return this.deliver(url, payload, signal);
  }

  private async deliver(url: string, payload: AgentNotification, signal: AbortSignal) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      });
    } catch {
      log.warn("Notification webhook outcome is unknown");
      return {
        ok: false, code: "notification_delivery_unknown", completion: "outcome_unknown",
        message: "No authoritative webhook response was received. Delivery may have occurred; do not automatically retry.",
      };
    }
    await response.body?.cancel().catch(() => {
      log.warn("Could not close the notification webhook response");
    });
    if (!response.ok) {
      log.warn("Notification webhook rejected the request", { status: response.status });
      return {
        ok: false, code: "notification_webhook_rejected",
        completion: response.status >= 400 && response.status < 500 ? "not_executed" : "outcome_unknown",
        status: response.status,
        message: "The webhook did not accept the notification. Inspect Listen before deciding whether to send again.",
      };
    }
    log.info("Notification accepted by webhook", { status: response.status });
    return {
      ok: true, completion: "completed", status: "accepted",
      message: "The webhook accepted the notification. This does not confirm browser push delivery or that the user read it.",
    };
  }
}

export const agentNotificationService = new AgentNotificationService();
