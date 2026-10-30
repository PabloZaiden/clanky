import { createLogger } from "@pablozaiden/webapp/server";
import {
  AgentNotificationSchema,
  NotificationWebhookUrlSchema,
  SetAgentNotificationSettingsSchema,
  type AgentNotificationSettings,
} from "@/contracts/schemas/agent-notifications";
import { getNotificationWebhookUrl, setNotificationWebhookUrl } from "../persistence/preferences";
import { DomainError } from "../domain/domain-error";

const log = createLogger("core:agent-notifications");

class AgentNotificationService {
  async settings(): Promise<AgentNotificationSettings> {
    return { configured: await this.webhookUrl() !== null };
  }

  async configure(input: unknown): Promise<AgentNotificationSettings> {
    const { webhookUrl } = SetAgentNotificationSettingsSchema.parse(input);
    await setNotificationWebhookUrl(webhookUrl);
    return { configured: webhookUrl !== null };
  }

  private async webhookUrl(): Promise<string | null> {
    const stored = await getNotificationWebhookUrl();
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
