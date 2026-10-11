/**
 * Keeps model steps, assistant messages and child actors distinct.
 */

import type { SessionEvent } from "@github/copilot-sdk";
import type { HarnessEvent, HarnessEventPayload, HarnessEventScope } from "@/shared/harness-events";
import { HarnessError } from "../harness-errors";
import {
  ProviderImageOutputBudget,
  projectProviderImageOutput,
  redactProviderImagePayloads,
} from "../provider-image-output";

interface ActiveMessage {
  messageId: string;
  scopeKey: string;
  deltaContent: string | null;
}

const MAX_TRACKED_DELTA_CONTENT_CHARS = 1_000_000;

export class CopilotEventTranslator {
  private readonly messages = new Map<string, ActiveMessage>();
  private trackedDeltaContentChars = 0;
  private currentMessageKey?: string;
  private readonly tools = new Map<string, string>();
  private readonly imageOutputBudget = new ProviderImageOutputBudget();
  private queryError?: Extract<HarnessEventPayload, { type: "request.error" }>;
  interrupted = false;

  constructor(private readonly sessionId: string) {}

  beginPrompt(): void {
    this.imageOutputBudget.reset();
  }

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
        const messageKey = this.getMessageKey(scope, event.data.messageId);
        const restart = this.messages.has(messageKey) && this.currentMessageKey !== messageKey;
        const events = this.startMessage(scope, event.data.messageId, restart).map(wrap);
        this.appendMessageDelta(messageKey, event.data.deltaContent);
        events.push(wrap({ type: "message.delta", content: event.data.deltaContent }));
        return events;
      }
      case "assistant.message": {
        if (scope.kind === "principal" && event.data.content.trim()) this.queryError = undefined;
        const nativeMessageKey = this.getMessageKey(scope, event.data.messageId);
        // Reconcile an ID mismatch only when one active delta stream exactly matches the final content.
        let completedMessageKey = this.messages.has(nativeMessageKey)
          ? nativeMessageKey
          : this.findMatchingStreamedMessage(scope, event.data.content);
        const activeMessage = completedMessageKey
          ? this.messages.get(completedMessageKey)
          : undefined;
        const events = activeMessage
          ? this.startMessage(scope, activeMessage.messageId, this.currentMessageKey !== completedMessageKey).map(wrap)
          : this.startMessage(scope, event.data.messageId).map(wrap);
        completedMessageKey ??= nativeMessageKey;
        events.push(wrap({ type: "message.complete", content: event.data.content }));
        this.deleteMessage(completedMessageKey);
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
        const output = event.data.result ?? event.data.error;
        const failed = event.data.error !== undefined && event.data.error !== null;
        const projection = failed
          ? undefined
          : projectProviderImageOutput(
              output,
              `copilot-tool:${event.data.toolCallId}`,
              this.imageOutputBudget,
            );
        return [
          wrap({
            type: "tool.complete",
            toolCallId: event.data.toolCallId,
            toolName: name,
            output: projection?.output ?? redactProviderImagePayloads(output),
          }),
          ...(projection?.events ?? []).map(wrap),
        ];
      }
      case "session.error":
        return [wrap(this.translateFailure(event, scope.kind === "principal"))];
      case "session.idle":
        if (scope.kind === "principal") {
          return this.completePrincipalPrompt(event.data.aborted === true).map(wrap);
        }
        this.clearMessagesInScope(this.getScopeKey(scope));
        return [wrap({ type: "prompt.complete", outcome: "completed" }), wrap({ type: "activity.changed" })];
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
    this.clearMessagesInScope("principal");
    if (failure && outcome !== "interrupted") return [{ ...failure, type: "error" }];
    return [{ type: "prompt.complete", outcome }, { type: "activity.changed" }];
  }

  private startMessage(
    scope: HarnessEventScope,
    messageId: string,
    restart = false,
  ): HarnessEventPayload[] {
    const scopeKey = this.getScopeKey(scope);
    const messageKey = this.getMessageKey(scope, messageId);
    if (this.messages.has(messageKey)) {
      if (!restart) return [];
      this.currentMessageKey = messageKey;
      return [{ type: "message.start", messageId }];
    }
    if (this.messages.size >= 1024) throw new HarnessError("harness_request_failed", "Too many active native messages.");
    this.messages.set(messageKey, { messageId, scopeKey, deltaContent: "" });
    this.currentMessageKey = messageKey;
    return [{ type: "message.start", messageId }];
  }

  private appendMessageDelta(messageKey: string, content: string): void {
    if (content.length === 0) return;
    const message = this.messages.get(messageKey);
    if (!message || message.deltaContent === null) return;
    if (this.trackedDeltaContentChars + content.length > MAX_TRACKED_DELTA_CONTENT_CHARS) {
      this.trackedDeltaContentChars -= message.deltaContent.length;
      message.deltaContent = null;
      return;
    }
    message.deltaContent += content;
    this.trackedDeltaContentChars += content.length;
  }

  private findMatchingStreamedMessage(scope: HarnessEventScope, content: string): string | undefined {
    if (content.length === 0) return undefined;
    const scopeKey = this.getScopeKey(scope);
    let match: string | undefined;
    for (const [key, message] of this.messages) {
      if (message.scopeKey !== scopeKey || message.deltaContent !== content) continue;
      if (match) return undefined;
      match = key;
    }
    return match;
  }

  private deleteMessage(messageKey: string): void {
    const message = this.messages.get(messageKey);
    if (!message) return;
    if (message.deltaContent !== null) {
      this.trackedDeltaContentChars -= message.deltaContent.length;
    }
    this.messages.delete(messageKey);
  }

  private clearMessagesInScope(scopeKey: string): void {
    for (const [key, message] of this.messages) {
      if (message.scopeKey === scopeKey) this.deleteMessage(key);
    }
  }

  private getMessageKey(scope: HarnessEventScope, messageId: string): string {
    return `${this.getScopeKey(scope)}\0${messageId}`;
  }

  private getScopeKey(scope: HarnessEventScope): string {
    return scope.kind === "child" ? `child:${scope.activityId}` : "principal";
  }
}
