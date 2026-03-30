/**
 * Simple event emitter for Ralph Loops Management System.
 * A minimal pub/sub implementation for internal event handling.
 * No external dependencies - uses native patterns.
 */

import type { ChatEvent, LoopEvent, ProvisioningEvent, SshSessionEvent } from "../types";
import { log } from "./logger";

type EventHandler<T> = (event: T) => void;
type Unsubscribe = () => void;

/**
 * Simple typed event emitter.
 * Provides basic pub/sub functionality for loop events.
 */
export class SimpleEventEmitter<T = LoopEvent> {
  private handlers = new Set<EventHandler<T>>();

  /**
   * Subscribe to all events.
   * Returns an unsubscribe function.
   */
  subscribe(handler: EventHandler<T>): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Emit an event to all subscribers.
   */
  emit(event: T): void {
    // Only log subscriber count for loop.log events to avoid spam
    const eventType = (event as { type?: string }).type;
    if (this.handlers.size > 1 && eventType === "loop.log") {
      log.debug("[EventEmitter] emit: Multiple subscribers detected", {
        subscriberCount: this.handlers.size,
        eventType,
      });
    }
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        // Don't let one handler's error break others
        log.error("Event handler error:", String(error));
      }
    }
  }

  /**
   * Get the number of active subscribers.
   */
  get subscriberCount(): number {
    return this.handlers.size;
  }

  /**
   * Remove all subscribers.
   */
  clear(): void {
    this.handlers.clear();
  }
}

/**
 * Global event emitter instance for loop events.
 * Used by WebSocket handlers to broadcast events to clients.
 */
export const loopEventEmitter = new SimpleEventEmitter<LoopEvent>();

/**
 * Global event emitter instance for chat events.
 */
export const chatEventEmitter = new SimpleEventEmitter<ChatEvent>();

/**
 * Global event emitter instance for SSH session events.
 */
export const sshSessionEventEmitter = new SimpleEventEmitter<SshSessionEvent>();

/**
 * Global event emitter instance for provisioning job events.
 */
export const provisioningEventEmitter = new SimpleEventEmitter<ProvisioningEvent>();
