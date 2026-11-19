/**
 * Keeps model steps, assistant messages and child actors distinct.
 */

import type { SessionEvent } from "@microsoft/copilot-sdk";
import type { HarnessEvent, HarnessEventPayload, HarnessEventScope } from "@/shared/harness-events";
import { HarnessError } from "../harness-errors";
import { providerFailure, providerRetryAt } from "../provider-limit";
import type { ProviderLimit } from "@/shared/provider-limit";
import {
  projectProviderImageOutput,
  redactProviderImagePayloads,
} from "../provider-image-output";

export class CopilotEventTranslator {
  private readonly messages = new Set<string>();
  private readonly tools = new Map<string, string>();
  private queryError?: Extract<HarnessEventPayload, { type: "request.error" }>;
  private principalPromptActive = false;
  private quotaRetryAt?: string;
  interrupted = false;

  constructor(private readonly sessionId: string) {}

  beginPrompt(): void {
    this.principalPromptActive = true;
    this.queryError = undefined;
    this.quotaRetryAt = undefined;
    this.interrupted = false;
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
      case "session.quota_observation": {
        if (scope.kind !== "principal") return [];
        const observation = event.data.observation;
        const budget = observation.budgetMetadata;
        this.quotaRetryAt = observation.capacityState === "exhausted"
          && observation.acquisitionStatus !== "failed" && observation.acquisitionStatus !== "unavailable"
          && budget && !budget.unlimited && !budget.overageAllowedWhenExhausted && budget.resetEstimated !== true
          ? providerRetryAt(budget.resetAtEpochMs) : undefined;
        return [];
      }
      case "assistant.message_start":
        return this.startMessage(scope, event.data.messageId).map(wrap);
      case "assistant.message_delta": {
        const events = this.startMessage(scope, event.data.messageId).map(wrap);
        events.push(wrap({ type: "message.delta", content: event.data.deltaContent, messageId: event.data.messageId }));
        return events;
      }
      case "assistant.message": {
        if (scope.kind === "principal" && event.data.content.trim()) this.queryError = undefined;
        const events = this.startMessage(scope, event.data.messageId).map(wrap);
        events.push(wrap({ type: "message.complete", content: event.data.content, messageId: event.data.messageId }));
        this.messages.delete(this.getMessageKey(scope, event.data.messageId));
        return events;
      }
      case "assistant.reasoning_delta":
        return [wrap({ type: "reasoning.delta", content: event.data.deltaContent, reasoningId: event.data.reasoningId })];
      case "assistant.reasoning":
        return scope.kind === "child" ? [wrap({
          type: "reasoning.delta", content: event.data.content, reasoningId: event.data.reasoningId, complete: true,
        })] : [];
      case "subagent.started":
        return [wrap({
          type: "activity.changed",
          ...(event.agentId ? { activity: {
            id: event.agentId, parentId: event.data.parentId, spawningToolCallId: event.data.toolCallId,
            kind: "subagent" as const, description: event.data.agentDisplayName || event.data.agentDescription,
            status: "running" as const, ownership: "owned" as const, workspaceWrites: "possible" as const,
            requestedModel: event.data.model,
            native: { adapter: "copilot" as const, conversationId: this.sessionId, activityId: event.agentId },
          } } : {}),
        })];
      case "subagent.completed":
      case "subagent.failed":
        return [wrap({ type: "activity.changed" })];
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
            details: { reason: "tool_start_missing" },
          })];
        }
        const output = event.data.result ?? event.data.error;
        const failed = event.data.error !== undefined && event.data.error !== null;
        const projection = failed
          ? undefined
          : projectProviderImageOutput(
              output,
              `copilot-tool:${event.data.toolCallId}`,
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
      case "assistant.idle":
        if (scope.kind === "principal") {
          return this.completePrincipalPrompt(event.data.aborted === true).map(wrap);
        }
        this.clearMessagesInScope(this.getScopeKey(scope));
        return [wrap({ type: "prompt.complete", outcome: "completed" }), wrap({ type: "activity.changed" })];
      case "session.idle":
      case "session.background_tasks_changed":
        return [wrap({ type: "activity.changed" })];
      case "assistant.turn_start":
        if (scope.kind === "principal") this.principalPromptActive = true;
        return [wrap({ type: "session.status", sessionId: this.sessionId, status: "busy" })];
      case "user.message":
        return [{
          ...wrap({ type: "user.message", content: event.data.content, messageId: event.data.messageId }),
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
    const { errorType, errorCode } = event.data;
    const kind: ProviderLimit["kind"] | undefined = errorCode === "billing_not_configured" ? "billing"
      : errorType === "quota" || errorCode === "quota_exceeded" || errorCode === "session_quota_exceeded"
        || errorCode === "user_weekly_rate_limited" ? "quota"
        : errorType === "rate_limit" ? "rate_limit" : undefined;
    const classified = providerFailure(kind ? { kind, ...(kind === "quota" ? { retryAt: this.quotaRetryAt } : {}) } : undefined);
    const failure = {
      code: classified.code,
      message: event.data.message,
      details: { ...classified.details, errorType, ...(errorCode ? { errorCode } : {}) },
    };
    if (!principal || event.data.errorType !== "query") {
      if (principal) this.principalPromptActive = false;
      return { type: "error", ...failure };
    }
    // Query failure can precede a native background continuation, including after steering.
    this.queryError = { type: "request.error", ...failure };
    return this.queryError;
  }

  private completePrincipalPrompt(aborted: boolean): HarnessEventPayload[] {
    const active = this.principalPromptActive;
    this.principalPromptActive = false;
    const outcome = this.interrupted || aborted ? "interrupted" : "completed";
    const failure = this.queryError;
    this.queryError = undefined;
    this.interrupted = false;
    this.clearMessagesInScope("principal");
    if (!active) return [{ type: "activity.changed" }];
    if (failure && outcome !== "interrupted") return [{ ...failure, type: "error" }];
    return [{ type: "prompt.complete", outcome }, { type: "activity.changed" }];
  }

  private startMessage(
    scope: HarnessEventScope,
    messageId: string,
  ): HarnessEventPayload[] {
    const messageKey = this.getMessageKey(scope, messageId);
    if (this.messages.has(messageKey)) return [];
    if (this.messages.size >= 1024) throw new HarnessError("harness_request_failed", "Too many active native messages.");
    this.messages.add(messageKey);
    return [{ type: "message.start", messageId }];
  }

  private clearMessagesInScope(scopeKey: string): void {
    for (const key of this.messages) {
      if (key.startsWith(`${scopeKey}\0`)) this.messages.delete(key);
    }
  }

  private getMessageKey(scope: HarnessEventScope, messageId: string): string {
    return `${this.getScopeKey(scope)}\0${messageId}`;
  }

  private getScopeKey(scope: HarnessEventScope): string {
    return scope.kind === "child" ? `child:${scope.activityId}` : "principal";
  }
}
