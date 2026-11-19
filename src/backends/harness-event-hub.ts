/**
 * Session-lifetime fanout, independent of any single prompt consumer.
 */

import type { HarnessEvent } from "@/shared/harness-events";
import { createEventStream, type EventStream } from "../utils/event-stream";
import { logHarnessFailure, withHarnessDiagnostic } from "./harness-diagnostics";
import { DomainError } from "../domain/domain-error";

export class HarnessEventHub {
  private readonly subscribers = new Map<string, Set<ReturnType<typeof createEventStream<HarnessEvent>>>>();

  subscribe(sessionId: string): EventStream<HarnessEvent> {
    const producer = createEventStream<HarnessEvent>({ overflow: "fail" });
    const subscribers = this.subscribers.get(sessionId) ?? new Set();
    subscribers.add(producer);
    this.subscribers.set(sessionId, subscribers);
    return {
      next: () => producer.stream.next(),
      close: () => {
        producer.stream.close();
        subscribers.delete(producer);
        if (subscribers.size === 0) this.subscribers.delete(sessionId);
      },
    };
  }

  publish(sessionId: string, event: HarnessEvent): void {
    if (event.type === "error" || event.type === "request.error") {
      const diagnostic = logHarnessFailure(new DomainError(event.code ?? "harness_request_failed", event.message, { details: event.details }), {
        adapter: event.scope.native?.adapter, operation: "observe", conversationId: sessionId, details: event.details,
      }, event.type === "request.error" ? "warn" : "error");
      event = { ...event, details: { ...event.details, diagnostic } };
    }
    const timestamped = { ...event, timestamp: event.timestamp ?? new Date().toISOString() };
    for (const producer of this.subscribers.get(sessionId) ?? []) producer.push(timestamped);
  }

  closeSession(sessionId: string): void {
    for (const producer of this.subscribers.get(sessionId) ?? []) producer.end();
    this.subscribers.delete(sessionId);
  }

  failSession(sessionId: string, error: Error): void {
    const failure = withHarnessDiagnostic(error, { operation: "observe", conversationId: sessionId });
    for (const producer of this.subscribers.get(sessionId) ?? []) producer.fail(failure);
    this.subscribers.delete(sessionId);
  }

  closeAll(reason?: Error): void {
    for (const sessionId of this.subscribers.keys()) {
      if (reason) this.failSession(sessionId, reason);
      else this.closeSession(sessionId);
    }
  }
}
