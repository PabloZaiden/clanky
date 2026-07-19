/**
 * Event translation and replay mapping for the ACP backend.
 *
 * Parses ACP `session/update`, `session/status`, and `session/question`
 * notifications into normalized {@link AgentEvent}s, and maps raw session/load
 * history into {@link SessionReplayEvent}s for import capture. All per-session
 * tracking is delegated to the state store; all emission goes through the state
 * store's session/replay sinks. This service owns no RPC request state,
 * subscription lifecycle, or permission handling.
 */

import { log } from "@pablozaiden/webapp/server";
import type { AgentEvent, QuestionInfo, SessionReplayEvent } from "../types";

import { isRecord, getString, getNumber, firstString } from "./json-helpers";
import type { SessionStateStore } from "./session-state";
import type { CapabilityService } from "./capability-service";

const TOOL_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "success",
  "failed",
  "error",
  "cancelled",
  "canceled",
]);

export class AcpEventTranslator {
  constructor(
    private readonly state: SessionStateStore,
    private readonly capability: CapabilityService,
  ) {}

  handleSessionUpdate(params: Record<string, unknown>): void {
    const sessionId = getString(params["sessionId"]);
    const updateObj = isRecord(params["update"]) ? params["update"] : params;
    const updateType = getString(updateObj["sessionUpdate"]) ?? getString(updateObj["type"]);
    const content = isRecord(updateObj["content"]) ? updateObj["content"] : {};

    log.trace("[AcpBackend] Raw session/update", {
      sessionId,
      updateType,
      params,
      updateObj,
      content,
    });

    if (!sessionId || !updateType) {
      return;
    }

    if (this.state.hasReplaySubscribers(sessionId)) {
      const replayEvent = this.mapReplayEvent(sessionId, updateObj, content, updateType);
      if (replayEvent) {
        this.state.deliverReplayEvent(sessionId, replayEvent);
      }
    }

    if (updateType === "config_option_update" || updateType === "config_options_update") {
      const configOptions = this.capability.parseConfigOptions(updateObj);
      if (configOptions.length > 0) {
        const cached = this.state.getCachedSession(sessionId);
        if (cached) {
          cached.configOptions = configOptions;
          const modelOption = configOptions.find((o) => o.category === "model" || o.id === "model");
          if (modelOption) {
            cached.model = modelOption.currentValue;
          }
        }
        log.debug("[AcpBackend] Config options updated by agent", {
          sessionId,
          options: configOptions.map((o) => `${o.id}=${o.currentValue}`),
        });
      }
      return;
    }

    if (updateType === "user_message_chunk") {
      const text = getString(content["text"]) ?? "";
      if (text.length > 0) {
        this.state.emitSessionEvent(sessionId, {
          type: "user.message",
          content: text,
        });
      }
      return;
    }

    if (updateType === "agent_message_chunk") {
      const text = getString(content["text"]) ?? "";
      if (text.length === 0) {
        return;
      }
      this.state.markPromptActivity(sessionId);
      this.state.clearIgnoreStatusUntilActivity(sessionId);
      if (!this.state.isMessageStarted(sessionId)) {
        this.state.startMessage(sessionId);
        this.state.emitSessionEvent(sessionId, {
          type: "message.start",
          messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
      }
      const delta = this.state.normalizeMessageChunk(sessionId, text);
      if (delta.length > 0) {
        this.state.emitSessionEvent(sessionId, {
          type: "message.delta",
          content: delta,
        });
      }
      return;
    }

    if (updateType === "agent_thought_chunk") {
      this.state.markPromptActivity(sessionId);
      this.state.clearIgnoreStatusUntilActivity(sessionId);
      const text = getString(content["text"]) ?? "";
      if (text.length > 0) {
        const partKey = this.getReasoningPartKey(updateObj, content);
        const reasoningText = this.state.computeReasoningDelta(sessionId, partKey, text);
        if (reasoningText === null) {
          return;
        }
        this.state.emitSessionEvent(sessionId, {
          type: "reasoning.delta",
          content: reasoningText,
        });
      }
      return;
    }

    if (updateType === "tool_call") {
      this.state.markPromptActivity(sessionId);
      this.state.clearIgnoreStatusUntilActivity(sessionId);
      const toolCallId = firstString(updateObj["toolCallId"], content["toolCallId"]);
      const toolName = firstString(
        content["toolName"],
        content["name"],
        updateObj["toolName"],
        updateObj["name"],
        updateObj["kind"],
        content["kind"],
        updateObj["title"],
      ) ?? "unknown_tool";
      if (toolCallId) {
        this.state.setToolName(sessionId, toolCallId, toolName);
      }
      log.trace("[AcpBackend] Handling tool_call update", {
        sessionId,
        toolCallId,
        toolName,
        contentInput: content["input"],
        updateInput: updateObj["input"],
        rawInput: updateObj["rawInput"],
        fullUpdate: updateObj,
      });
      this.state.emitSessionEvent(sessionId, {
        type: "tool.start",
        toolCallId,
        toolName,
        input: content["input"] ?? updateObj["input"] ?? updateObj["rawInput"] ?? {},
      });
      return;
    }

    if (updateType === "tool_call_update") {
      this.state.markPromptActivity(sessionId);
      this.state.clearIgnoreStatusUntilActivity(sessionId);
      const toolCallId = firstString(updateObj["toolCallId"], content["toolCallId"]);
      const toolName = firstString(
        content["toolName"],
        content["name"],
        updateObj["toolName"],
        updateObj["name"],
        updateObj["kind"],
        toolCallId ? this.state.getToolName(sessionId, toolCallId) : undefined,
        updateObj["title"],
      ) ?? "unknown_tool";
      const status = firstString(
        content["status"],
        updateObj["status"],
        content["state"],
        updateObj["state"],
      );

      log.trace("[AcpBackend] Handling tool_call_update", {
        sessionId,
        toolCallId,
        toolName,
        status,
        contentOutput: content["output"],
        updateOutput: updateObj["output"],
        rawOutput: updateObj["rawOutput"],
        fullUpdate: updateObj,
      });

      if (status !== undefined && TOOL_TERMINAL_STATUSES.has(status)) {
        const output = this.buildToolOutput(updateObj, content, status);
        const completedInput = updateObj["input"] ?? updateObj["rawInput"] ?? content["input"];
        this.state.emitSessionEvent(sessionId, {
          type: "tool.complete",
          toolCallId,
          toolName,
          input: completedInput,
          output,
        });
        if (toolCallId) {
          this.state.deleteToolName(sessionId, toolCallId);
        }
      }
    }
  }

  handleSessionStatus(params: Record<string, unknown>): void {
    const sessionId = getString(params["sessionId"]);
    const status = getString(params["status"]);
    if (!sessionId || (status !== "idle" && status !== "busy" && status !== "retry")) {
      return;
    }
    const hasActivePrompt = this.state.hasActivePrompt(sessionId);
    const ignoreStatusUntilActivity = this.state.isIgnoringStatusUntilActivity(sessionId);
    if (hasActivePrompt && !ignoreStatusUntilActivity && (status === "busy" || status === "retry")) {
      this.state.markPromptActivity(sessionId);
    }
    this.state.emitSessionEvent(sessionId, {
      type: "session.status",
      sessionId,
      status,
      attempt: getNumber(params["attempt"]),
      message: getString(params["message"]),
    });
    const hasPromptActivity = this.state.hasPromptActivity(sessionId);
    if (status === "idle" && hasActivePrompt && hasPromptActivity && !ignoreStatusUntilActivity) {
      this.state.emitSessionEvent(sessionId, {
        type: "message.complete",
        content: "",
      });
      this.state.clearPromptState(sessionId);
    }
  }

  handleSessionQuestion(params: Record<string, unknown>): void {
    const sessionId = getString(params["sessionId"]);
    const requestId = getString(params["requestId"]);
    const questions = params["questions"];
    if (!sessionId || !requestId || !Array.isArray(questions)) {
      return;
    }
    const normalizedQuestions: QuestionInfo[] = questions
      .filter((question): question is Record<string, unknown> => isRecord(question))
      .map((question) => ({
        question: getString(question["question"]) ?? "",
        header: getString(question["header"]) ?? "",
        options: Array.isArray(question["options"])
          ? question["options"]
            .filter((option): option is Record<string, unknown> => isRecord(option))
            .map((option) => ({
              label: getString(option["label"]) ?? "",
              description: getString(option["description"]) ?? "",
            }))
          : [],
        multiple: question["multiple"] === true,
        custom: question["custom"] !== false,
      }));

    this.state.emitSessionEvent(sessionId, {
      type: "question.asked",
      requestId,
      sessionId,
      questions: normalizedQuestions,
    });
  }

  private buildToolOutput(
    updateObj: Record<string, unknown>,
    content: Record<string, unknown>,
    status: string,
  ): unknown {
    const rawOutput = isRecord(updateObj["rawOutput"]) ? updateObj["rawOutput"] : {};
    const errorMessage = firstString(content["error"], updateObj["error"], rawOutput["message"]);
    const baseOutput = content["output"] ?? updateObj["output"] ?? updateObj["rawOutput"] ?? content["content"] ?? updateObj["content"];
    const isFailure = status === "failed" || status === "error";
    if (!isFailure) {
      return baseOutput ?? {};
    }
    return isRecord(baseOutput)
      ? {
        ...baseOutput,
        status,
        ...(errorMessage ? { error: errorMessage } : {}),
      }
      : {
        status,
        ...(errorMessage ? { error: errorMessage } : {}),
        ...(baseOutput !== undefined ? { output: baseOutput } : {}),
      };
  }

  private getReasoningPartKey(
    updateObj: Record<string, unknown>,
    content: Record<string, unknown>,
  ): string | undefined {
    const partId = firstString(
      content["partId"],
      content["partID"],
      updateObj["partId"],
      updateObj["partID"],
      content["reasoningPartId"],
      updateObj["reasoningPartId"],
      content["thoughtId"],
      updateObj["thoughtId"],
    );
    if (partId) {
      return `id:${partId}`;
    }

    const partIndex = getNumber(content["partIndex"])
      ?? getNumber(updateObj["partIndex"])
      ?? getNumber(content["reasoningPartIndex"])
      ?? getNumber(updateObj["reasoningPartIndex"]);
    if (partIndex !== undefined) {
      return `index:${partIndex}`;
    }

    return undefined;
  }

  private mapReplayEvent(
    sessionId: string,
    updateObj: Record<string, unknown>,
    content: Record<string, unknown>,
    updateType: string,
  ): SessionReplayEvent | null {
    if (updateType === "user_message_chunk") {
      const text = getString(content["text"]) ?? "";
      return text.length > 0 ? { type: "user.message", content: text } : null;
    }

    if (updateType === "agent_message_chunk") {
      const text = getString(content["text"]) ?? "";
      return text.length > 0 ? { type: "assistant.message", content: text } : null;
    }

    if (updateType === "agent_thought_chunk") {
      const text = getString(content["text"]) ?? "";
      return text.length > 0 ? { type: "reasoning", content: text } : null;
    }

    if (updateType === "tool_call") {
      const toolCallId = firstString(updateObj["toolCallId"], content["toolCallId"]);
      const toolName = firstString(
        content["toolName"],
        content["name"],
        updateObj["toolName"],
        updateObj["name"],
        updateObj["kind"],
        content["kind"],
        updateObj["title"],
      ) ?? "unknown_tool";
      return {
        type: "tool.start",
        toolCallId,
        toolName,
        input: content["input"] ?? updateObj["input"] ?? updateObj["rawInput"] ?? {},
      };
    }

    if (updateType === "tool_call_update") {
      const status = firstString(
        content["status"],
        updateObj["status"],
        content["state"],
        updateObj["state"],
      );
      if (status === undefined || !TOOL_TERMINAL_STATUSES.has(status)) {
        return null;
      }

      const toolCallId = firstString(updateObj["toolCallId"], content["toolCallId"]);
      const toolName = firstString(
        content["toolName"],
        content["name"],
        updateObj["toolName"],
        updateObj["name"],
        updateObj["kind"],
        toolCallId ? this.state.getToolName(sessionId, toolCallId) : undefined,
        updateObj["title"],
      ) ?? "unknown_tool";
      const output = this.buildToolOutput(updateObj, content, status);
      const completedInput = updateObj["input"] ?? updateObj["rawInput"] ?? content["input"];

      return {
        type: "tool.complete",
        toolCallId,
        toolName,
        input: completedInput,
        output,
      };
    }

    return null;
  }
}
