/**
 * Keeps model steps, assistant messages and child actors distinct.
 */

import type { SessionEvent } from "@github/copilot-sdk";
import type { HarnessEvent, HarnessEventPayload, HarnessEventScope } from "@/shared/harness-events";
import { HarnessError } from "../harness-errors";

export class CopilotEventTranslator {
  private readonly messages = new Set<string>();
  private readonly tools = new Map<string, string>();
  private queryError?: Extract<HarnessEventPayload, { type: "request.error" }>;
  interrupted = false;

  constructor(private readonly sessionId: string) {}

  translate(event: SessionEvent): HarnessEvent[] {
    const scope: HarnessEventScope = event.agentId
      ? {
          kind: "child",
          activityId: event.agentId,
          native: { adapter: "copilot", conversationId: this.sessionId, activityId: event.agentId },
        }
      : { kind: "principal", native: { adapter: "copilot", conversationId: this.sessionId } };
    const wrap = (payload: HarnessEventPayload): HarnessEvent => ({
      ...payload,
      scope,
      sourceEventId: event.id,
      timestamp: event.timestamp,
    });
    switch (event.type) {
      case "assistant.message_delta": {
        const events = this.startMessage(event.data.messageId).map(wrap);
        events.push(wrap({ type: "message.delta", content: event.data.deltaContent }));
        return events;
      }
      case "assistant.message": {
        if (scope.kind === "principal" && event.data.content.trim()) this.queryError = undefined;
        const events = this.startMessage(event.data.messageId).map(wrap);
        events.push(wrap({ type: "message.complete", content: event.data.content }));
        this.messages.delete(event.data.messageId);
        return events;
      }
      case "assistant.reasoning_delta":
        return [wrap({ type: "reasoning.delta", content: event.data.deltaContent })];
      case "tool.execution_start":
        if (this.tools.size >= 1024) throw new HarnessError("harness_request_failed", "Too many active native tool calls.");
        this.tools.set(event.data.toolCallId, event.data.toolName);
        return [wrap({
          type: "tool.start",
          toolCallId: event.data.toolCallId,
          toolName: event.data.toolName,
          input: event.data.arguments,
        })];
      case "tool.execution_complete": {
        const name = this.tools.get(event.data.toolCallId);
        this.tools.delete(event.data.toolCallId);
        if (!name) {
          return [wrap({
            type: "error",
            code: "harness_event_gap",
            message: "A native tool completed without its observed start.",
          })];
        }
        return [wrap({
          type: "tool.complete",
          toolCallId: event.data.toolCallId,
          toolName: name,
          output: event.data.result ?? event.data.error,
        })];
      }
      case "session.error":
        return [wrap(this.translateFailure(event, scope.kind === "principal"))];
      case "session.idle":
        return scope.kind === "principal"
          ? this.completePrincipalPrompt(event.data.aborted === true).map(wrap)
          : [wrap({ type: "prompt.complete", outcome: "completed" }), wrap({ type: "activity.changed" })];
      case "session.background_tasks_changed":
        return [wrap({ type: "activity.changed" })];
      case "assistant.turn_start":
        return [wrap({ type: "session.status", sessionId: this.sessionId, status: "busy" })];
      case "user.message":
        return [{
          ...wrap({ type: "user.message", content: event.data.content }),
          scope: {
            ...scope,
            native: { ...scope.native, adapter: "copilot", messageId: event.data.messageId },
          },
        }];
      default:
        return [];
    }
  }

  private translateFailure(event: Extract<SessionEvent, { type: "session.error" }>, principal: boolean): HarnessEventPayload {
    const failure = {
      code: "harness_request_failed",
      message: event.data.message,
      details: { errorType: event.data.errorType, ...(event.data.errorCode ? { errorCode: event.data.errorCode } : {}) },
    };
    if (!principal || event.data.errorType !== "query") return { type: "error", ...failure };
    // Query failure can precede a native background continuation, including after steering.
    this.queryError = { type: "request.error", ...failure };
    return this.queryError;
  }

  private completePrincipalPrompt(aborted: boolean): HarnessEventPayload[] {
    const outcome = this.interrupted || aborted ? "interrupted" : "completed";
    const failure = this.queryError;
    this.queryError = undefined;
    this.interrupted = false;
    if (failure && outcome !== "interrupted") return [{ ...failure, type: "error" }];
    return [{ type: "prompt.complete", outcome }, { type: "activity.changed" }];
  }

  private startMessage(messageId: string): HarnessEventPayload[] {
    if (this.messages.has(messageId)) return [];
    if (this.messages.size >= 1024) throw new HarnessError("harness_request_failed", "Too many active native messages.");
    this.messages.add(messageId);
    return [{ type: "message.start", messageId }];
  }
}
