/**
 * Simple event emitter for Clanky Tasks Management System.
 * A minimal pub/sub implementation for internal event handling.
 * No external dependencies - uses native patterns.
 */

import type {
  AgentEvent,
  ChatEvent,
  PreviewEvent,
  ProvisioningEvent,
  TaskEvent,
  TerminalSessionEvent,
  WorkerUpdateEvent,
} from "@/shared";
import { log } from "@pablozaiden/webapp/server";
import { getExecutionOwnerUserId } from "../context/user-context";
import type { ControlUiActionEvent } from "@/shared/clanky-control";
import type { LiveVoiceActivityEvent } from "@/shared/live-voice";

export interface EventContext {
  readonly userId?: string;
}

export type MeshStateEvent = {
  type: "mesh.changed";
  reason: "enrollment" | "endpoint" | "health" | "revoked" | "removed" | "identity";
} & (
  | { impact: "inventory" }
  | {
      impact: "cache" | "resources";
      scope: {
        userId: string;
        workerNodeIds: readonly [string, ...string[]];
      };
    }
);

type EventHandler<T> = (event: T, context: EventContext) => void;
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
  emit(event: T, context: EventContext = { userId: getExecutionOwnerUserId() }): void {
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
        handler(event, context);
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
export const clientActionEventEmitter = new SimpleEventEmitter<ControlUiActionEvent | LiveVoiceActivityEvent>();

/**
 * Global event emitter instance for scheduled agent events.
 */
export const agentEventEmitter = new SimpleEventEmitter<AgentEvent>();

/**
 * Global event emitter instance for terminal session events.
 */
export const terminalSessionEventEmitter = new SimpleEventEmitter<TerminalSessionEvent>();

/**
 * Global event emitter instance for provisioning job events.
 */
export const provisioningEventEmitter = new SimpleEventEmitter<ProvisioningEvent>();

/**
 * Global event emitter for persisted Mesh worker update jobs.
 */
export const workerUpdateEventEmitter = new SimpleEventEmitter<WorkerUpdateEvent>();

/**
 * Global event emitter instance for workspace and direct server preview events.
 */
export const previewEventEmitter = new SimpleEventEmitter<PreviewEvent>();

export const meshStateEventEmitter = new SimpleEventEmitter<MeshStateEvent>();

export interface HarnessStateEvent {
  type: "harness.changed";
  context: { kind: "chat" | "task"; id: string };
  runs?: Array<{ id: string; agentId: string }>;
}

export const harnessEventEmitter = new SimpleEventEmitter<HarnessStateEvent>();
