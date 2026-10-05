/**
 * Session-lifetime fanout, independent of any single prompt consumer.
 */

import type { HarnessEvent } from "@/shared/harness-events";
import { createEventStream, type EventStream } from "../utils/event-stream";

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
    const timestamped = { ...event, timestamp: event.timestamp ?? new Date().toISOString() };
    for (const producer of this.subscribers.get(sessionId) ?? []) producer.push(timestamped);
  }

  closeSession(sessionId: string): void {
    for (const producer of this.subscribers.get(sessionId) ?? []) producer.end();
    this.subscribers.delete(sessionId);
  }

  failSession(sessionId: string, error: Error): void {
    for (const producer of this.subscribers.get(sessionId) ?? []) producer.fail(error);
    this.subscribers.delete(sessionId);
  }

  closeAll(): void {
    for (const sessionId of this.subscribers.keys()) this.closeSession(sessionId);
  }
}
