/**
 * Deterministic external registry seam with observable scoped cancellation.
 */

import type { HarnessActivity, HarnessControl } from "@/shared/harness-control";
import type { HarnessEvent } from "@/shared/harness-events";
import { HarnessEventHub } from "../../src/backends/harness-event-hub";
import { HarnessError } from "../../src/backends/harness-errors";
import type { EventStream } from "../../src/utils/event-stream";
import { MockAcpBackend, type MockBackendOptions } from "./mock-backend";
import type { PromptInput } from "../../src/backends/types";

export class LifetimeHarnessBackend extends MockAcpBackend {
  private readonly activities: Map<string, HarnessActivity[]>;
  private readonly deliveries: Map<string, Map<string, string>>;
  private readonly acknowledgePrompts: boolean;
  private readonly hub = new HarnessEventHub();
  private readonly sources = new Map<string, { stream: EventStream<HarnessEvent>; completion: Promise<void> }>();

  constructor(options: MockBackendOptions & { inputAdmission?: "unknown" | "accepted"; acknowledgePrompts?: boolean } = {}) {
    const activities = new Map<string, HarnessActivity[]>();
    const deliveries = new Map<string, Map<string, string>>();
    const control: HarnessControl = {
      capabilities: { adapter: "copilot", experimental: true, steering: options.inputAdmission ? "active-session" : "unsupported", activity: "native", stopScopes: ["child-execution"] },
      getActivity: async (sessionId) => ({
        observation: "available", coverage: "native", observedAt: new Date().toISOString(),
        principalProcessing: false, activities: structuredClone(activities.get(sessionId) ?? []),
      }),
      stopActivity: async (sessionId, activityId) => {
        const activity = activities.get(sessionId)?.find((entry) => entry.id === activityId);
        if (!activity || activity.ownership !== "owned") throw new HarnessError("harness_activity_not_owned", "Native activity is not owned.");
        activity.status = "stopped";
        activity.workspaceWrites = "none";
        return { status: "stopped", activityId };
      },
      steer: async (sessionId, request) => {
        if (!options.inputAdmission) return { status: "rejected", inputId: request.inputId, code: "unsupported" };
        const messages = deliveries.get(sessionId) ?? new Map<string, string>();
        const messageId = crypto.randomUUID();
        messages.set(request.inputId, messageId);
        deliveries.set(sessionId, messages);
        return options.inputAdmission === "unknown"
          ? { status: "unknown", inputId: request.inputId }
          : { status: "accepted", inputId: request.inputId, nativeMessageId: messageId };
      },
      reconcileInput: async (sessionId, request) => {
        const nativeMessageId = deliveries.get(sessionId)?.get(request.inputId);
        return nativeMessageId
          ? { status: "delivered", inputId: request.inputId, nativeMessageId }
          : { status: "unknown", inputId: request.inputId };
      },
      settleOwnedWork: async (sessionId) => {
        const pending: string[] = [];
        for (const activity of activities.get(sessionId) ?? []) {
          if (activity.ownership !== "owned") continue;
          if (activity.status === "unknown") {
            pending.push(activity.id);
          } else {
            activity.status = "stopped";
            activity.workspaceWrites = "none";
          }
        }
        return pending.length > 0
          ? { status: "pending", activityIds: pending }
          : { status: "settled", observedAt: new Date().toISOString() };
      },
    };
    super({ ...options, harness: control });
    this.activities = activities;
    this.deliveries = deliveries;
    this.acknowledgePrompts = options.acknowledgePrompts ?? false;
  }

  override async sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void> {
    await super.sendPromptAsync(sessionId, prompt);
    if (this.acknowledgePrompts) {
      this.publishEvent(sessionId, { type: "message.start", messageId: crypto.randomUUID(), scope: { kind: "principal" } });
      this.publishEvent(sessionId, { type: "message.complete", content: "Native principal active", scope: { kind: "principal" } });
    }
  }

  publishActivities(sessionId: string, activities: HarnessActivity[]): void {
    this.activities.set(sessionId, structuredClone(activities));
    this.hub.publish(sessionId, { type: "activity.changed", scope: { kind: "principal" } });
  }

  publishEvent(sessionId: string, event: HarnessEvent): void { this.hub.publish(sessionId, event); }

  override async subscribeToEvents(sessionId: string): Promise<EventStream<HarnessEvent>> {
    if (!this.sources.has(sessionId)) {
      const stream = await super.subscribeToEvents(sessionId);
      const completion = (async () => {
        try {
          for (let event = await stream.next(); event; event = await stream.next()) this.hub.publish(sessionId, event);
        } catch (error) {
          this.hub.failSession(sessionId, error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      })();
      this.sources.set(sessionId, { stream, completion });
    }
    return this.hub.subscribe(sessionId);
  }

  override async abortSession(sessionId: string): Promise<void> {
    this.publishActivities(sessionId, (this.activities.get(sessionId) ?? []).map((entry) =>
      entry.ownership === "owned" && entry.status !== "unknown"
        ? { ...entry, status: "stopped", workspaceWrites: "none" }
        : entry,
    ));
  }

  override async deleteSession(sessionId: string): Promise<void> {
    await this.closeSessionSource(sessionId);
    this.activities.delete(sessionId);
    this.deliveries.delete(sessionId);
    await super.deleteSession(sessionId);
  }

  override async disconnect(): Promise<void> {
    for (const sessionId of this.sources.keys()) await this.closeSessionSource(sessionId);
    await super.disconnect();
  }

  private async closeSessionSource(sessionId: string): Promise<void> {
    const source = this.sources.get(sessionId);
    source?.stream.close();
    this.hub.closeSession(sessionId);
    await source?.completion;
    this.sources.delete(sessionId);
  }
}
