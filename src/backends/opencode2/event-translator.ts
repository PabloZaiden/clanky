/**
 * Tracks bounded native step content and tool identity, not conversation history.
 */

import type { OpenCodeEvent, SessionEventDurable } from "@opencode/client";
import type { HarnessEvent, HarnessEventPayload, HarnessEventScope } from "@/shared/harness-events";
import { HarnessError } from "../harness-errors";

export class OpenCodeEventTranslator {
  private readonly messages = new Map<string, Map<number, string>>();
  private readonly tools = new Map<string, string>();
  private lastSequence?: number;

  get sequence(): number | undefined { return this.lastSequence; }

  translate(event: OpenCodeEvent | SessionEventDurable, scope: HarnessEventScope): HarnessEvent[] {
    if ("durable" in event) {
      if (this.lastSequence !== undefined && event.durable.seq <= this.lastSequence) return [];
      if (this.lastSequence !== undefined && event.durable.seq !== this.lastSequence + 1) {
        throw new HarnessError("harness_event_gap", "The native session event sequence has a gap.", {
          details: { previous: this.lastSequence, next: event.durable.seq, aggregateId: event.durable.aggregateID, eventType: event.type },
        });
      }
      this.lastSequence = event.durable.seq;
    }
    const wrap = (payload: HarnessEventPayload): HarnessEvent => ({
      ...payload, scope, sourceEventId: event.id,
      sourceSequence: "durable" in event ? event.durable.seq : undefined,
    });
    switch (event.type) {
      case "session.execution.started":
        return [wrap({ type: "session.status", sessionId: event.data.sessionID, status: "busy" })];
      case "session.execution.succeeded":
        return [wrap({ type: "prompt.complete", outcome: "completed" }), wrap({ type: "activity.changed" })];
      case "session.execution.interrupted":
        return [wrap({ type: "prompt.complete", outcome: "interrupted" }), wrap({ type: "activity.changed" })];
      case "session.execution.failed":
        return [wrap({ type: "error", code: "harness_request_failed", message: event.data.error.message }), wrap({ type: "activity.changed" })];
      case "session.step.started":
        return this.startMessage(event.data.assistantMessageID).map(wrap);
      case "session.text.delta":
        return [...this.startMessage(event.data.assistantMessageID).map(wrap), wrap({ type: "message.delta", content: event.data.delta })];
      case "session.text.ended": {
        const events = this.startMessage(event.data.assistantMessageID).map(wrap);
        const parts = this.messages.get(event.data.assistantMessageID)!;
        const totalLength = [...parts.values()].reduce((total, text) => total + text.length, 0)
          - (parts.get(event.data.ordinal)?.length ?? 0) + event.data.text.length;
        if (totalLength > 2 * 1024 * 1024 || parts.size >= 256) {
          throw new HarnessError("harness_event_gap", "Native message content exceeded the observation limit.");
        }
        parts.set(event.data.ordinal, event.data.text);
        return events;
      }
      case "session.step.ended": {
        const parts = this.messages.get(event.data.assistantMessageID);
        if (!parts) throw new HarnessError("harness_event_gap", "A native step completed without its observed start.");
        const content = [...parts.entries()].sort(([left], [right]) => left - right).map(([, text]) => text).join("\n");
        this.messages.delete(event.data.assistantMessageID);
        return [wrap({ type: "message.complete", content })];
      }
      case "session.reasoning.delta":
        return [wrap({ type: "reasoning.delta", content: event.data.delta })];
      case "session.tool.input.started":
        if (this.tools.size >= 1000) throw new HarnessError("harness_event_gap", "Native tool observation capacity reached.");
        this.tools.set(event.data.id, event.data.name);
        return [wrap({ type: "tool.start", toolCallId: event.data.id, toolName: event.data.name, input: {} })];
      case "session.tool.called":
        return [wrap({
          type: "tool.start", toolCallId: event.data.id,
          toolName: this.requireTool(event.data.id), input: event.data.input,
        })];
      case "session.tool.success":
      case "session.tool.failed": {
        const toolName = this.requireTool(event.data.id);
        this.tools.delete(event.data.id);
        return [wrap({
          type: "tool.complete", toolCallId: event.data.id, toolName,
          output: event.type === "session.tool.success" ? event.data.content : event.data.error,
        })];
      }
      case "session.retry.scheduled":
        return [wrap({
          type: "session.status", sessionId: event.data.sessionID, status: "retry",
          attempt: event.data.attempt, message: event.data.error.message,
        })];
      default:
        return [];
    }
  }

  private startMessage(id: string): HarnessEventPayload[] {
    if (this.messages.has(id)) return [];
    if (this.messages.size >= 128) throw new HarnessError("harness_event_gap", "Native active-message observation capacity reached.");
    this.messages.set(id, new Map());
    return [{ type: "message.start", messageId: id }];
  }
  private requireTool(id: string): string {
    const name = this.tools.get(id);
    if (!name) throw new HarnessError("harness_event_gap", "A native tool has no observed identity.");
    return name;
  }
}
