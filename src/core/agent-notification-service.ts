import { createLogger } from "@pablozaiden/webapp/server";
import {
  AgentNotificationSchema,
  NotificationWebhookUrlSchema,
  SetAgentNotificationSettingsSchema,
  type AgentNotificationSettings,
  type AgentNotification,
} from "@/contracts/schemas/agent-notifications";
import {
  getNotificationWebhookUrl, getNotificationWebhookGeneration, getNotificationPreferences, getNotificationDeliveryError,
  setNotificationDeliveryError, updateNotificationSettings,
} from "../persistence/preferences";
import { DomainError } from "../domain/domain-error";
import { requireCurrentUserId, requireExecutionOwnerUserId } from "../context/user-context";
import type { NotificationEventKind } from "@/shared/agent-notifications";
import { agentEventEmitter, taskEventEmitter } from "./event-emitter";
import { loadChatMetadata } from "../persistence/chats";
import { loadTaskSummary } from "../persistence/tasks";
import { loadAgent, loadAgentRunSummary } from "../persistence/agents";
import { controlRequestPrivate, resourcePrivate } from "./control-request-privacy";
import type { PreparedOperation } from "./clanky-operation-service";
import type { ManagedContextIdentity } from "@/shared/context-api-key";

const log = createLogger("core:agent-notifications");

type AutomaticNotificationSource =
  | { kind: "Chat" | "Task" | "Agent run"; id: string; context?: string }
  | { kind: "Agent operation"; operation: PreparedOperation; context: string; origin?: ManagedContextIdentity };

function boundedText(value: string, maximum: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 3).replace(/[\uD800-\uDBFF]$/u, "").trimEnd()}...`;
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#!|]/g, "\\$&");
}

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
          case "task.error": this.notify("error", { kind: "Task", id: event.taskId }, context.userId); break;
          case "task.stopped":
            if (event.blocked) this.notify("blocked", { kind: "Task", id: event.taskId }, context.userId);
            break;
          case "task.plan.ready":
            if (event.requiresApproval) this.notify("planReady", { kind: "Task", id: event.taskId }, context.userId);
            break;
          case "task.completed": this.notify("completed", { kind: "Task", id: event.taskId }, context.userId); break;
        }
      }),
      agentEventEmitter.subscribe((event, context) => {
        if (!context.userId) return;
        if (event.type === "agent.run.failed") this.notify("error", { kind: "Agent run", id: event.agentId }, context.userId);
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
  notify(event: NotificationEventKind, source: AutomaticNotificationSource,
    ownerUserId = requireExecutionOwnerUserId()): void {
    const signal = this.controller?.signal;
    if (!signal || signal.aborted) return;
    const work = this.sendAutomatic(event, source, ownerUserId, signal).catch(() => {
      log.error("Could not record automatic notification delivery failure", { event, ownerUserId });
    }).finally(() => this.pending.delete(work));
    this.pending.add(work);
  }

  private async sourceDetails(source: AutomaticNotificationSource): Promise<{
    kind?: AutomaticNotificationSource["kind"]; name?: string; context?: string;
  }> {
    if (source.kind === "Agent operation") {
      if (await controlRequestPrivate(source.operation)) return {};
      const origin = source.origin;
      if (!origin) return { context: source.context };
      let work: AutomaticNotificationSource;
      if (origin.contextType === "chat" || origin.contextType === "task") {
        work = { kind: origin.contextType === "chat" ? "Chat" : "Task", id: origin.contextId };
      } else if (origin.contextType === "agent_run") {
        const run = await loadAgentRunSummary(origin.contextId);
        if (!run) return {};
        work = { kind: "Agent run", id: run.agentId };
      } else {
        return {};
      }
      const details = await this.sourceDetails(work);
      return details.name ? { ...details, context: source.context } : {};
    }
    const resource = source.kind === "Chat" ? "chat" : source.kind === "Task" ? "task" : "agent";
    const work = source.kind === "Chat" ? await loadChatMetadata(source.id)
      : source.kind === "Task" ? await loadTaskSummary(source.id) : await loadAgent(source.id);
    if (!work || await resourcePrivate(resource, source.id)) return {};
    return { kind: source.kind, name: work.config.name, context: source.context };
  }

  private async sendAutomatic(event: NotificationEventKind, source: AutomaticNotificationSource, ownerUserId: string,
    signal: AbortSignal): Promise<void> {
    const generation = getNotificationWebhookGeneration(ownerUserId);
    let failure: string | undefined;
    try {
      const preferences = getNotificationPreferences(ownerUserId);
      if (!preferences.enabled || !preferences.events[event]) return;
      const url = await this.webhookUrl(ownerUserId);
      if (!url || signal.aborted || generation !== getNotificationWebhookGeneration(ownerUserId)) return;
      const details = await this.sourceDetails(source);
      const current = getNotificationPreferences(ownerUserId);
      if (!current.enabled || !current.events[event] || signal.aborted
        || generation !== getNotificationWebhookGeneration(ownerUserId)) return;
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
      const name = details.name ? boundedText(details.name, 120) : undefined;
      const label = name ? `${details.kind ?? source.kind}: ${name}` : source.kind;
      const context = details.context ? boundedText(details.context, 1_000) : undefined;
      const result = await this.deliver(url, {
        title: `${boundedText(label, 100 - description.length - 2)}: ${description}`,
        shortDescription: boundedText(`${name ? `${label}: ` : ""}${description}${context ? ` ${context}` : ""}`, 500),
        markdownContent: `${markdownText(label)}: ${description}${context ? `\n\n${markdownText(context)}` : ""}\n\nOpen Clanky to view the details.`,
      }, signal);
      if (!result.ok) failure = result.message;
    } catch {
      failure = "Automatic notification delivery could not be confirmed. Inspect Listen before sending again; no automatic retry will occur.";
    }
    if (failure) {
      if (generation !== getNotificationWebhookGeneration(ownerUserId)) {
        log.debug("Ignoring a delivery failure for an outdated webhook configuration", { ownerUserId });
        return;
      }
      this.recordFailure(ownerUserId, failure);
    }
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
