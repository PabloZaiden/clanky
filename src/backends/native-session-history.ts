/**
 * A fresh collector per read keeps history projection separate from live state.
 */
import type { HarnessEvent } from "@/shared/harness-events";
import {
  HARNESS_HISTORY_MAX_BYTES,
  HARNESS_HISTORY_MAX_EVENTS,
  HARNESS_HISTORY_MAX_NATIVE_BYTES,
  HARNESS_HISTORY_MAX_NATIVE_EVENTS,
  type HarnessHistoryEvent,
} from "@/shared/harness-history";
import { HarnessError } from "./harness-errors";

export class NativeSessionHistory {
  private nativeCount = 0;
  private nativeBytes = 0;
  private eventBytes = 0;
  private readonly events: HarnessHistoryEvent[] = [];
  private readonly tools = new Map<string, Extract<HarnessEvent, { type: "tool.start" }>>();

  observeNative(value: unknown): void {
    this.nativeCount++;
    this.nativeBytes += Buffer.byteLength(JSON.stringify(value));
    if (this.nativeCount > HARNESS_HISTORY_MAX_NATIVE_EVENTS || this.nativeBytes > HARNESS_HISTORY_MAX_NATIVE_BYTES) {
      throw new HarnessError("harness_event_gap", "Native history exceeds the recovery limit.");
    }
  }

  append(event: HarnessEvent): void {
    if (event.scope.kind !== "principal") return;
    if (event.type === "error" || event.type === "request.error") {
      if (event.code === "harness_event_gap" || event.code === "provider_image_omitted") {
        throw new HarnessError("harness_event_gap", "Native history content could not be recovered completely.");
      }
      return;
    }
    if (event.type === "tool.start") {
      if (!event.toolCallId || this.tools.size >= HARNESS_HISTORY_MAX_NATIVE_EVENTS) {
        throw new HarnessError("harness_event_gap", "Native history tool identity is unavailable.");
      }
      this.tools.set(event.toolCallId, event);
      return;
    }
    if (event.type !== "message.complete" && event.type !== "tool.complete") return;
    let completed: HarnessHistoryEvent = event;
    if (event.type === "message.complete" && !event.messageId) {
      throw new HarnessError("harness_event_gap", "Native history message identity is unavailable.");
    }
    if (event.type === "tool.complete") {
      if (!event.toolCallId) throw new HarnessError("harness_event_gap", "Native history tool identity is unavailable.");
      const start = this.tools.get(event.toolCallId);
      completed = { ...event, ...(start ? { input: start.input } : {}) };
      this.tools.delete(event.toolCallId);
    }
    const envelope = {
      scope: completed.scope,
      timestamp: completed.timestamp,
      sourceEventId: completed.sourceEventId,
      sourceSequence: completed.sourceSequence,
    };
    const start: HarnessHistoryEvent = completed.type === "message.complete"
      ? { ...envelope, type: "message.start", messageId: completed.messageId! }
      : { ...envelope, type: "tool.start", toolCallId: completed.toolCallId, toolName: completed.toolName, input: completed.input };
    this.push(start);
    this.push(completed);
  }

  takeEvents(): HarnessHistoryEvent[] {
    this.eventBytes = 0;
    return this.events.splice(0);
  }

  private push(event: HarnessHistoryEvent): void {
    this.eventBytes += Buffer.byteLength(JSON.stringify(event)) + 1;
    if (this.events.length >= HARNESS_HISTORY_MAX_EVENTS || this.eventBytes > HARNESS_HISTORY_MAX_BYTES - 256) {
      throw new HarnessError("harness_event_gap", "Completed native history exceeds the recovery limit.");
    }
    this.events.push(event);
  }
}

export async function recoverNativeSessionHistory<T>(
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("harness_event_gap", "Native history could not be recovered.", { cause: error });
  }
}
