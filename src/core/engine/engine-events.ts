/**
 * Log and persistence helpers for LoopEngine.
 */

import { log } from "../logger";
import type { LoopLogEntry, PersistedMessage } from "../../types/loop";
import type { MessageData, ToolCallData, LogLevel } from "../../types/events";
import {
  MAX_PERSISTED_LOGS,
  MAX_PERSISTED_MESSAGES,
  MAX_PERSISTED_TOOL_CALLS,
} from "./engine-types";

export function logToConsole(
  level: LogLevel,
  loopPrefix: string,
  message: string,
  detailsStr: string,
  consoleLevel?: "trace" | "debug" | "info" | "warn" | "error",
): void {
  if (consoleLevel) {
    const levelTag = level === "agent" || level === "user" ? ` [${level}]` : "";
    const logMessage = `${loopPrefix}${levelTag} ${message}${detailsStr}`;
    switch (consoleLevel) {
      case "trace": log.trace(logMessage); break;
      case "debug": log.debug(logMessage); break;
      case "info": log.info(logMessage); break;
      case "warn": log.warn(logMessage); break;
      case "error": log.error(logMessage); break;
    }
  } else {
    switch (level) {
      case "error": log.error(`${loopPrefix} ${message}${detailsStr}`); break;
      case "warn": log.warn(`${loopPrefix} ${message}${detailsStr}`); break;
      case "info": log.info(`${loopPrefix} ${message}${detailsStr}`); break;
      case "debug": log.debug(`${loopPrefix} ${message}${detailsStr}`); break;
      case "trace": log.trace(`${loopPrefix} ${message}${detailsStr}`); break;
      case "agent":
      case "user":
        log.info(`${loopPrefix} [${level}] ${message}${detailsStr}`);
        break;
    }
  }
}

export function persistLoopLog(
  logs: LoopLogEntry[],
  entry: LoopLogEntry,
  isUpdate: boolean,
): LoopLogEntry[] {
  if (isUpdate) {
    const index = logs.findIndex((log) => log.id === entry.id);
    if (index >= 0) {
      logs[index] = entry;
    } else {
      logs.push(entry);
    }
  } else {
    logs.push(entry);
  }
  if (logs.length > MAX_PERSISTED_LOGS) {
    logs.splice(0, logs.length - MAX_PERSISTED_LOGS);
  }
  return logs;
}

export function persistLoopMessage(
  messages: PersistedMessage[],
  message: MessageData,
): PersistedMessage[] {
  const existingIndex = messages.findIndex((m) => m.id === message.id);
  if (existingIndex >= 0) {
    messages[existingIndex] = {
      id: message.id,
      role: message.role,
      content: message.content,
      attachments: message.attachments,
      timestamp: message.timestamp,
    };
  } else {
    messages.push({
      id: message.id,
      role: message.role,
      content: message.content,
      attachments: message.attachments,
      timestamp: message.timestamp,
    });
  }
  if (messages.length > MAX_PERSISTED_MESSAGES) {
    messages.splice(0, messages.length - MAX_PERSISTED_MESSAGES);
  }
  return messages;
}

export function persistLoopToolCall(
  toolCalls: ToolCallData[],
  toolCall: ToolCallData,
): ToolCallData[] {
  const existingIndex = toolCalls.findIndex((tc) => tc.id === toolCall.id);
  if (existingIndex >= 0) {
    toolCalls[existingIndex] = {
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.input,
      output: toolCall.output,
      status: toolCall.status,
      timestamp: toolCall.timestamp,
    };
  } else {
    toolCalls.push({
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.input,
      output: toolCall.output,
      status: toolCall.status,
      timestamp: toolCall.timestamp,
    });
  }
  if (toolCalls.length > MAX_PERSISTED_TOOL_CALLS) {
    toolCalls.splice(0, toolCalls.length - MAX_PERSISTED_TOOL_CALLS);
  }
  return toolCalls;
}
