/**
 * Normalizes attributed native items without conflating messages and turns.
 */

import type { HarnessEvent, HarnessEventPayload, HarnessEventScope } from "@/shared/harness-events";
import type { CodexNotification } from "./protocol";
import type { ThreadItem } from "./generated/v2/ThreadItem";
import { HarnessError } from "../harness-errors";
import { formatHarnessQuestions } from "@/shared/harness-questions";
import {
  ProviderImageOutputBudget,
  projectProviderImageOutput,
  redactProviderImagePayloads,
} from "../provider-image-output";

export class CodexEventTranslator {
  private readonly messages = new Set<string>();
  private readonly imageOutputBudget = new ProviderImageOutputBudget();

  constructor(private readonly options: { includeProviderImageFileReference?: boolean } = {}) {}

  translate(event: CodexNotification, scope: HarnessEventScope): HarnessEvent[] {
    const wrap = (payload: HarnessEventPayload): HarnessEvent => ({ ...payload, scope });
    switch (event.method) {
      case "turn/started":
        this.imageOutputBudget.reset();
        return [wrap({ type: "session.status", sessionId: event.params.threadId, status: "busy" })];
      case "turn/completed":
        if (event.params.turn.status === "failed") return [wrap({
          type: "error", code: "harness_request_failed",
          message: event.params.turn.error?.message ?? "The native Codex turn failed.",
        }), wrap({ type: "activity.changed" })];
        return [wrap({
          type: "prompt.complete",
          outcome: event.params.turn.status === "interrupted" ? "interrupted" : "completed",
        }), wrap({ type: "activity.changed" })];
      case "thread/status/changed":
        return [wrap({ type: "activity.changed" })];
      case "item/agentMessage/delta":
        return [...this.startMessage(event.params.itemId).map(wrap), wrap({ type: "message.delta", content: event.params.delta })];
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        return [wrap({ type: "reasoning.delta", content: event.params.delta })];
      case "item/started":
        return this.translateItem(event.params.item, false).map(wrap);
      case "item/completed":
        return [
          ...this.translateItem(event.params.item, true),
          ...(event.params.item.type === "agentMessage" && event.params.item.delivery === "async" && event.params.item.questions?.length ? [{
            type: "question.asked" as const,
            requestId: `async:${event.params.threadId}:${event.params.item.id}`,
            sessionId: event.params.threadId, blocking: false, responseMode: "message" as const,
            questions: event.params.item.questions.map((question) => ({
              question: question.title, header: "", custom: true,
              options: (question.options ?? []).map((label) => ({ label, description: "" })),
            })),
          }] : []),
        ].map((payload) => payload.type === "question.asked"
          ? {
              ...payload,
              scope: {
                ...scope,
                native: { adapter: "codex", ...scope.native, messageId: event.params.item.id },
              },
            }
          : wrap(payload));
      case "item/commandExecution/outputDelta":
        return [wrap({ type: "activity.changed" })];
      case "error":
        return event.params.willRetry ? [] : [wrap({
          type: "error", code: "harness_request_failed", message: event.params.error.message,
        })];
      default:
        return [];
    }
  }

  private startMessage(id: string): HarnessEventPayload[] {
    if (this.messages.has(id)) return [];
    if (this.messages.size >= 1000) throw new HarnessError("harness_event_gap", "The native active-message limit was exceeded.");
    this.messages.add(id);
    return [{ type: "message.start", messageId: id }];
  }

  private translateItem(item: ThreadItem, completed: boolean): HarnessEventPayload[] {
    if (item.type === "imageGeneration") {
      if (completed && item.status === "completed" && item.failure === null) {
        const projection = projectProviderImageOutput(
          item,
          `codex-image:${item.id}`,
          this.imageOutputBudget,
        );
        const savedPath = item.savedPath;
        if (
          !this.options.includeProviderImageFileReference
          || typeof savedPath !== "string"
          || savedPath.length === 0
          || savedPath.length > 16_384
        ) {
          return projection.events;
        }
        return projection.events.map((event) => {
          if (event.type !== "message.complete" || event.attachments?.length !== 1) {
            return event;
          }
          const { data: _data, ...attachment } = event.attachments[0]!;
          return {
            ...event,
            providerImageFile: { path: savedPath, attachment },
          };
        });
      }
      return [];
    }
    if (item.type === "agentMessage") {
      const events = this.startMessage(item.id);
      if (completed) {
        events.push({
          type: "message.complete",
          content: item.delivery === "async" && item.questions?.length
            ? formatHarnessQuestions(item.questions.map((question) => ({
                question: question.title, header: "", options: [],
              })), item.text)
            : item.text,
        });
        this.messages.delete(item.id);
      }
      return events;
    }
    if (item.type === "userMessage") return completed ? [{
      type: "user.message",
      content: item.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
    }] : [];
    const toolName = item.type === "commandExecution" ? "bash"
      : item.type === "fileChange" ? "apply_patch"
        : item.type === "mcpToolCall" ? `${item.server}/${item.tool}`
          : item.type === "dynamicToolCall" ? item.tool
            : item.type === "collabAgentToolCall" ? item.tool
              : item.type === "webSearch" ? "web_search" : undefined;
    if (!toolName) return [];
    if (!completed) {
      return [{ type: "tool.start", toolCallId: item.id, toolName, input: item }];
    }

    const status = "status" in item ? item.status : undefined;
    const failed = typeof status === "string"
      && ["failed", "cancelled", "canceled", "error"].includes(status);
    const projection = failed
      ? undefined
      : projectProviderImageOutput(
          item,
          `codex-tool:${item.id}`,
          this.imageOutputBudget,
        );
    return [
      {
        type: "tool.complete",
        toolCallId: item.id,
        toolName,
        output: projection?.output ?? redactProviderImagePayloads(item),
      },
      ...(projection?.events ?? []),
    ];
  }
}
