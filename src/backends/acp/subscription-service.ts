/**
 * Subscription lifecycle owner for the ACP backend.
 *
 * Owns the set of active subscription abort controllers and the creation of
 * per-session {@link EventStream}s. Subscriber registration is delegated to the
 * session state store; this service guarantees that closing a stream or
 * aborting all subscriptions detaches the subscriber and releases the stream.
 */

import { log } from "@pablozaiden/webapp/server";
import type { AgentEvent } from "../types";
import { createEventStream, type EventStream } from "../../utils/event-stream";

import type { SessionStateStore } from "./session-state";
import type { SessionSubscriber } from "./types";

export class SubscriptionService {
  private readonly activeSubscriptions = new Map<string, Set<() => void>>();

  constructor(private readonly state: SessionStateStore) {}

  abortAll(): void {
    for (const closes of [...this.activeSubscriptions.values()]) {
      for (const close of [...closes]) {
        close();
      }
    }
  }

  clearSession(sessionId: string): void {
    const closes = this.activeSubscriptions.get(sessionId);
    if (!closes) {
      return;
    }
    for (const close of [...closes]) {
      close();
    }
  }

  subscribe(sessionId: string): EventStream<AgentEvent> {
    log.debug("[AcpBackend] Subscribing to session events", { sessionId });

    const abortController = new AbortController();

    const { stream, push, end } = createEventStream<AgentEvent>();

    const subscriber: SessionSubscriber = (event) => {
      if (!abortController.signal.aborted) {
        push(event);
      }
    };

    this.state.addSessionSubscriber(sessionId, subscriber);

    let closed = false;
    const close = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      abortController.abort();
      const closes = this.activeSubscriptions.get(sessionId);
      closes?.delete(close);
      if (closes?.size === 0) {
        this.activeSubscriptions.delete(sessionId);
      }
      this.state.removeSessionSubscriber(sessionId, subscriber);
      stream.close();
      end();
      log.debug("[AcpBackend] Unsubscribed from session events", { sessionId });
    };

    const closes = this.activeSubscriptions.get(sessionId) ?? new Set<() => void>();
    closes.add(close);
    this.activeSubscriptions.set(sessionId, closes);

    return {
      next: () => stream.next(),
      close,
    };
  }
}
