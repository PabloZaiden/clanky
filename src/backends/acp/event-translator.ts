/**
 * Event translation and replay mapping for the ACP backend.
 *
 * Parses ACP `session/update`, `session/status`, and `session/question`
 * notifications into normalized {@link AgentEvent}s, and maps raw session/load
 * history into {@link SessionReplayEvent}s for import capture. It also retains
 * the legacy SDK event translation (`translateEvent`) for backward
 * compatibility. All per-session tracking is delegated to the state store; all
 * emission goes through the state store's session/replay sinks. This service
 * owns no RPC request state, subscription lifecycle, or permission handling.
 */

import { log } from "../../core/logger";
import type { AgentEvent, QuestionInfo, SessionReplayEvent } from "../types";

import { isRecord, getString, getNumber, firstString } from "./json-helpers";
import { createAcpRpcError } from "./errors";
import type { AcpEvent, TranslateEventContext } from "./types";
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

  /**
   * Translate a legacy SDK ACP event to our AgentEvent type.
   * Returns null if the event is not relevant, for a different session, or a duplicate.
   * Retained for backward compatibility with the legacy event shape.
   */
  translateEvent(event: AcpEvent, ctx: TranslateEventContext): AgentEvent | null {
    const {
      sessionId,
      subId,
      emittedMessageStarts,
      toolPartStatus,
      reasoningTextLength,
      pendingReasoningFallbackDeltas,
      partTypes,
    } = ctx;
    switch (event.type) {
      case "message.updated": {
        const msg = event.properties.info;
        log.trace(`[AcpBackend:${subId}] translateEvent: message.updated`, {
          msgSessionId: msg.sessionID,
          targetSessionId: sessionId,
          role: msg.role,
          messageId: msg.id,
          alreadyEmitted: emittedMessageStarts.has(msg.id),
        });
        if (msg.sessionID !== sessionId) {
          log.trace(`[AcpBackend:${subId}] translateEvent: message.updated - session ID mismatch`);
          return null;
        }

        if (msg.role === "assistant") {
          if (emittedMessageStarts.has(msg.id)) {
            log.trace(`[AcpBackend:${subId}] translateEvent: message.updated - already emitted start for this message`);
            return null;
          }
          emittedMessageStarts.add(msg.id);
          log.debug(`[AcpBackend:${subId}] translateEvent: message.updated - emitting message.start`, { messageId: msg.id });
          return {
            type: "message.start",
            messageId: msg.id,
          };
        }
        log.trace(`[AcpBackend:${subId}] translateEvent: message.updated - role is not assistant, returning null`, { role: msg.role });
        return null;
      }

      case "message.part.updated": {
        const part = event.properties.part;
        log.trace(`[AcpBackend:${subId}] translateEvent: message.part.updated`, {
          partSessionId: part.sessionID,
          targetSessionId: sessionId,
          partType: part.type,
        });
        if (part.sessionID !== sessionId) {
          log.trace(`[AcpBackend:${subId}] translateEvent: message.part.updated - session ID mismatch`);
          return null;
        }

        partTypes.set(part.id, part.type);

        if (part.type === "text") {
          log.trace(`[AcpBackend:${subId}] translateEvent: message.part.updated - text part (deltas via message.part.delta)`);
        } else if (part.type === "reasoning") {
          if (part.text) {
            const partId = part.id;
            const prevLength = reasoningTextLength.get(partId) ?? 0;
            const newContent = part.text.slice(prevLength);

            if (newContent.length > 0) {
              reasoningTextLength.set(partId, part.text.length);
              pendingReasoningFallbackDeltas.set(partId, newContent);
              return {
                type: "reasoning.delta",
                content: newContent,
              };
            }
          }
        } else if (part.type === "tool") {
          const state = part.state;
          const partId = part.id;
          const lastStatus = toolPartStatus.get(partId);

          log.trace(`[AcpBackend:${subId}] translateEvent: message.part.updated - tool part`, {
            partId,
            tool: part.tool,
            status: state.status,
            input: state.input,
            output: state.output,
          });

          if (state.status === "running") {
            if (lastStatus === "running") {
              return null;
            }
            toolPartStatus.set(partId, "running");
            return {
              type: "tool.start",
              toolCallId: partId,
              toolName: part.tool,
              input: state.input,
            };
          } else if (state.status === "completed") {
            if (lastStatus === "completed") {
              return null;
            }
            toolPartStatus.set(partId, "completed");
            return {
              type: "tool.complete",
              toolCallId: partId,
              toolName: part.tool,
              input: state.input,
              output: state.output,
            };
          } else if (state.status === "error") {
            if (lastStatus === "error") {
              return null;
            }
            toolPartStatus.set(partId, "error");
            return {
              type: "error",
              message: state.error,
            };
          }
        } else if (part.type === "step-start") {
          return null;
        } else if (part.type === "step-finish") {
          return null;
        }
        return null;
      }

      case "session.idle": {
        if (event.properties.sessionID !== sessionId) {
          log.trace(`[AcpBackend:${subId}] translateEvent: session.idle - session ID mismatch`);
          return null;
        }
        if (!emittedMessageStarts.size) {
          log.warn(`[AcpBackend:${subId}] translateEvent: session.idle received but no assistant messages were seen`, {
            sessionId,
            emittedMessageStartsCount: emittedMessageStarts.size,
          });
        }
        log.debug(`[AcpBackend:${subId}] translateEvent: session.idle - emitting message.complete`, { sessionId });
        return {
          type: "message.complete",
          content: "",
        };
      }

      case "session.error": {
        if (event.properties.sessionID !== sessionId) return null;
        const error = event.properties.error;
        const errorMessage = typeof error?.data?.message === "string"
          ? error.data.message
          : "Unknown error";
        const errorCode = typeof error?.code === "number" ? error.code : undefined;
        const typedError = createAcpRpcError({
          code: errorCode,
          message: errorMessage,
        });
        log.error(`[AcpBackend:${subId}] translateEvent: session.error`, {
          sessionId,
          errorMessage,
          errorCode: typedError.code,
        });
        return {
          type: "error",
          message: typedError.message,
          code: typedError.code,
        };
      }

      case "permission.asked": {
        const props = event.properties;
        if (props.sessionID !== sessionId) return null;
        return {
          type: "permission.asked",
          requestId: props.id,
          sessionId: props.sessionID,
          permission: props.permission ?? "unknown",
          patterns: props.patterns ?? [],
        };
      }

      case "question.asked": {
        const props = event.properties;
        if (props.sessionID !== sessionId) return null;
        return {
          type: "question.asked",
          requestId: props.id,
          sessionId: props.sessionID,
          questions: (props.questions ?? []).map((q: any) => ({
            question: q.question ?? "",
            header: q.header ?? "",
            options: (q.options ?? []).map((o: any) => ({
              label: o.label ?? "",
              description: o.description ?? "",
            })),
            multiple: q.multiple ?? false,
            custom: q.custom ?? true,
          })),
        };
      }

      case "session.status": {
        const props = event.properties;
        if (props.sessionID !== sessionId) return null;
        const statusInfo = props.status;
        const statusType = statusInfo.type;
        return {
          type: "session.status",
          sessionId: props.sessionID,
          status: statusType,
          attempt: statusType === "retry" ? statusInfo.attempt : undefined,
          message: statusType === "retry" ? statusInfo.message : undefined,
        };
      }

      default:
        if ((event as { type: string }).type === "message.part.delta") {
          type MessagePartDeltaEvent = {
            type: "message.part.delta";
            properties: {
              sessionID: string;
              partID: string;
              field: string;
              delta: string;
            };
          };

          const deltaEvent = event as unknown as MessagePartDeltaEvent;
          const { sessionID, partID, field, delta } = deltaEvent.properties;
          if (sessionID !== sessionId) {
            return null;
          }

          const partType = partTypes.get(partID);
          const resolvedType = partType ?? field;
          if (resolvedType === "text") {
            return {
              type: "message.delta",
              content: delta,
            };
          }
          if (resolvedType === "reasoning") {
            const pendingFallbackDelta = pendingReasoningFallbackDeltas.get(partID);
            if (pendingFallbackDelta === delta) {
              pendingReasoningFallbackDeltas.delete(partID);
              return null;
            }
            pendingReasoningFallbackDeltas.delete(partID);
            const currentLength = reasoningTextLength.get(partID) ?? 0;
            reasoningTextLength.set(partID, currentLength + delta.length);
            return {
              type: "reasoning.delta",
              content: delta,
            };
          }
          return null;
        }

        log.trace(`[AcpBackend:${subId}] translateEvent: Unhandled event type`, { type: event.type });
        return null;
    }
  }
}
