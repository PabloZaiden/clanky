/**
 * Log and persistence helpers for TaskEngine.
 */

import { log } from "@pablozaiden/webapp/server";
import type { TaskLogEntry, PersistedMessage } from "@/shared/task";
import type { MessageData, ToolCallData, LogLevel } from "@/shared/events";
import { mergeToolCallRecord } from "@/shared/tool-call";
import {
  MAX_PERSISTED_LOGS,
  MAX_PERSISTED_MESSAGES,
  MAX_PERSISTED_TOOL_CALLS,
} from "./engine-types";

export function logToConsole(
  level: LogLevel,
  taskPrefix: string,
  message: string,
  detailsStr: string,
  consoleLevel?: "trace" | "debug" | "info" | "warn" | "error",
): void {
  if (consoleLevel) {
    const levelTag = level === "agent" || level === "user" ? ` [${level}]` : "";
    const logMessage = `${taskPrefix}${levelTag} ${message}${detailsStr}`;
    switch (consoleLevel) {
      case "trace": log.trace(logMessage); break;
      case "debug": log.debug(logMessage); break;
      case "info": log.info(logMessage); break;
      case "warn": log.warn(logMessage); break;
      case "error": log.error(logMessage); break;
    }
  } else {
    switch (level) {
      case "error": log.error(`${taskPrefix} ${message}${detailsStr}`); break;
      case "warn": log.warn(`${taskPrefix} ${message}${detailsStr}`); break;
      case "info": log.info(`${taskPrefix} ${message}${detailsStr}`); break;
      case "debug": log.debug(`${taskPrefix} ${message}${detailsStr}`); break;
      case "trace": log.trace(`${taskPrefix} ${message}${detailsStr}`); break;
      case "agent":
      case "user":
        log.info(`${taskPrefix} [${level}] ${message}${detailsStr}`);
        break;
    }
  }
}

export function persistTaskLog(
  logs: TaskLogEntry[],
  entry: TaskLogEntry,
  isUpdate: boolean,
): TaskLogEntry[] {
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

export function persistTaskMessage(
  messages: PersistedMessage[],
  message: MessageData,
): PersistedMessage[] {
  const existingIndex = messages.findIndex((m) => m.id === message.id);
  if (existingIndex >= 0) {
    const existing = messages[existingIndex]!;
    messages[existingIndex] = {
      id: message.id,
      role: message.role,
      content: message.content,
      attachments:
        message.attachments === undefined
          ? existing.attachments
          : message.attachments,
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

export function persistTaskToolCall(
  toolCalls: ToolCallData[],
  toolCall: ToolCallData,
): ToolCallData[] {
  const existingIndex = toolCalls.findIndex((tc) => tc.id === toolCall.id);
  if (existingIndex >= 0) {
    toolCalls[existingIndex] = mergeToolCallRecord(toolCalls[existingIndex], toolCall);
  } else {
    toolCalls.push(toolCall);
  }
  if (toolCalls.length > MAX_PERSISTED_TOOL_CALLS) {
    toolCalls.splice(0, toolCalls.length - MAX_PERSISTED_TOOL_CALLS);
  }
  return toolCalls;
}
