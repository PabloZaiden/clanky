/**
 * Simple event emitter for Clanky Tasks Management System.
 * A minimal pub/sub implementation for internal event handling.
 * No external dependencies - uses native patterns.
 */

import type { AgentEvent, ChatEvent, TaskEvent, ProvisioningEvent, PreviewEvent, SshSessionEvent } from "../types";
import { log } from "./logger";

type EventHandler<T> = (event: T) => void;
type Unsubscribe = () => void;

/**
 * Simple typed event emitter.
 * Provides basic pub/sub functionality for task events.
 */
export class SimpleEventEmitter<T = TaskEvent> {
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
    // Only log subscriber count for task.log events to avoid spam
    const eventType = (event as { type?: string }).type;
    if (this.handlers.size > 1 && eventType === "task.log") {
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
 * Global event emitter instance for task events.
 * Used by WebSocket handlers to broadcast events to clients.
 */
export const taskEventEmitter = new SimpleEventEmitter<TaskEvent>();

/**
 * Global event emitter instance for chat events.
 */
export const chatEventEmitter = new SimpleEventEmitter<ChatEvent>();

/**
 * Global event emitter instance for scheduled agent events.
 */
export const agentEventEmitter = new SimpleEventEmitter<AgentEvent>();

/**
 * Global event emitter instance for SSH session events.
 */
export const sshSessionEventEmitter = new SimpleEventEmitter<SshSessionEvent>();

/**
 * Global event emitter instance for provisioning job events.
 */
export const provisioningEventEmitter = new SimpleEventEmitter<ProvisioningEvent>();

/**
 * Global event emitter instance for workspace live preview events.
 */
export const previewEventEmitter = new SimpleEventEmitter<PreviewEvent>();
