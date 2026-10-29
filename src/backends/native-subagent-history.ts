import type { HarnessEvent } from "@/shared/harness-events";
import { NativeSessionHistory } from "./native-session-history";
import { HarnessError } from "./harness-errors";
import { HARNESS_HISTORY_MAX_BYTES, HARNESS_HISTORY_MAX_EVENTS } from "@/shared/harness-history";

export interface NativeHistoryCollector<TEvent extends HarnessEvent> {
  observeNative(value: unknown): void;
  append(event: HarnessEvent): void;
  takeEvents(): TEvent[];
}

export class NativeSubagentHistory implements NativeHistoryCollector<HarnessEvent> {
  private readonly budget = new NativeSessionHistory();
  private readonly events: HarnessEvent[] = [];
  private readonly tools = new Map<string, Extract<HarnessEvent, { type: "tool.start" }>>();
  private count = 0;
  private bytes = 0;

  constructor(private readonly activityId: string) {}

  observeNative(value: unknown): void { this.budget.observeNative(value); }

  append(event: HarnessEvent): void {
    if (event.scope.kind !== "child" || event.scope.activityId !== this.activityId) return;
    if (event.type === "error" && event.code === "harness_event_gap") {
      throw new HarnessError("harness_event_gap", "The native child history is incomplete.");
    }
    if (event.type === "tool.start") {
      if (!event.toolCallId) throw new HarnessError("harness_event_gap", "The native child tool has no identity.");
      if (this.tools.size >= 1000) throw new HarnessError("harness_event_gap", "Too many unfinished native child tools.");
      this.tools.set(event.toolCallId, event);
    } else if (event.type === "tool.complete") {
      const start = event.toolCallId ? this.tools.get(event.toolCallId) : undefined;
      if (!start) throw new HarnessError("harness_event_gap", "The native child tool has no persisted start.");
      this.push(start, { ...event, input: event.input ?? start.input });
      this.tools.delete(start.toolCallId!);
    } else if (event.type === "message.complete") {
      if (!event.messageId) throw new HarnessError("harness_event_gap", "The native child response has no identity.");
      this.push({ ...event, type: "message.start", messageId: event.messageId }, event);
    } else if (event.type === "user.message" || event.type === "reasoning.delta" || event.type === "error" || event.type === "request.error"
      || event.type === "question.asked" || event.type === "question.resolved" || event.type === "permission.asked") {
      this.push(event);
    }
  }

  takeEvents(): HarnessEvent[] { return this.events.splice(0); }

  private push(...events: HarnessEvent[]): void {
    for (const event of events) {
      this.count++;
      this.bytes += Buffer.byteLength(JSON.stringify(event));
      if (this.count > HARNESS_HISTORY_MAX_EVENTS || this.bytes > HARNESS_HISTORY_MAX_BYTES) {
        throw new HarnessError("harness_event_gap", "Native child history exceeds its recovery budget.");
      }
      this.events.push(event);
    }
  }
}
