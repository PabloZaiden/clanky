/**
 * Incremental realtime stream handler for task updates.
 * Processes incoming TaskEvents and dispatches state updates.
 */

import type { Dispatch, SetStateAction } from "react";
import type { TaskEvent, MessageData, ToolCallData } from "@/shared";
import type { LogEntry } from "../../components/LogViewer";
import { createLogger } from "@pablozaiden/webapp/web";
import { MAX_FRONTEND_LOGS, MAX_FRONTEND_MESSAGES, MAX_FRONTEND_TOOL_CALLS } from "./useTaskData";
import { finalizeLatestResponseLog } from "./response-log-normalization";
import { mergeToolCallRecord, upsertToolCallExtra } from "@/shared/tool-call";

const log = createLogger("useTask");

export interface TaskEventHandlerParams {
  isActiveTask: (expectedTaskId: string) => boolean;
  refresh: (options?: { hydrateFromSnapshot?: boolean }) => Promise<void>;
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  setMessages: Dispatch<SetStateAction<MessageData[]>>;
  setToolCalls: Dispatch<SetStateAction<ToolCallData[]>>;
  setProgressContent: Dispatch<SetStateAction<string>>;
  setGitChangeCounter: Dispatch<SetStateAction<number>>;
}

/** Returns the incremental task stream handler. */
export function createTaskEventHandler(params: TaskEventHandlerParams) {
  const {
    isActiveTask,
    refresh,
    setLogs,
    setMessages,
    setToolCalls,
    setProgressContent,
    setGitChangeCounter,
  } = params;

  return function handleEvent(event: TaskEvent) {
    if (!isActiveTask(event.taskId)) {
      log.trace("Ignoring event for inactive task", {
        type: event.type,
        eventTaskId: event.taskId,
        activeTaskId: "(stale)",
      });
      return;
    }

    log.trace("Received event", { taskId: event.taskId, type: event.type });
    switch (event.type) {
      case "task.log":
        // Update existing log entry or add new one
        setLogs((prev) => {
          const existingIndex = prev.findIndex((logEntry) => logEntry.id === event.id);
          if (existingIndex >= 0) {
            const existingLog = prev[existingIndex]!;
            const updated = [...prev];
            updated[existingIndex] = {
              id: event.id,
              level: event.level,
              message: event.message,
              details: event.details,
              finalizedResponse: existingLog?.finalizedResponse,
              timestamp: event.timestamp,
            };
            return updated;
          }
          // Add new entry, evict oldest if over limit
          const newLogs = [
            ...prev,
            {
              id: event.id,
              level: event.level,
              message: event.message,
              details: event.details,
              timestamp: event.timestamp,
            },
          ];
          if (newLogs.length > MAX_FRONTEND_LOGS) {
            return newLogs.slice(-MAX_FRONTEND_LOGS);
          }
          return newLogs;
        });
        break;

      case "task.log.delta":
        setLogs((prev) => {
          const existingIndex = prev.findIndex((logEntry) => logEntry.id === event.id);
          if (existingIndex < 0) {
            if (event.baseLength !== 0) {
              void refresh({ hydrateFromSnapshot: true });
              return prev;
            }
            const newLogs = [
              ...prev,
              {
                id: event.id,
                level: event.level,
                message: event.message,
                details: {
                  logKind: event.logKind,
                  responseContent: event.delta,
                },
                timestamp: event.logTimestamp,
              },
            ];
            return newLogs.length > MAX_FRONTEND_LOGS ? newLogs.slice(-MAX_FRONTEND_LOGS) : newLogs;
          }

          const existingLog = prev[existingIndex]!;
          const currentContent = existingLog?.details?.["responseContent"];
          if (typeof currentContent !== "string" || currentContent.length !== event.baseLength) {
            void refresh({ hydrateFromSnapshot: true });
            return prev;
          }

          const updated = [...prev];
          updated[existingIndex] = {
            id: event.id,
            level: event.level,
            message: event.message,
            details: {
              ...existingLog.details,
              logKind: event.logKind,
              responseContent: `${currentContent}${event.delta}`,
            },
            finalizedResponse: existingLog.finalizedResponse,
            timestamp: event.logTimestamp,
          };
          return updated;
        });
        break;

      case "task.progress":
        // Accumulate streaming text deltas
        setProgressContent((prev) => prev + event.content);
        break;

      case "task.message":
        // Clear progress content when message is complete
        setProgressContent("");
        if (event.message.role === "assistant") {
          setLogs((prev) => finalizeLatestResponseLog(prev, event.message.content));
        }
        setMessages((prev) => {
          const newMessages = [...prev, event.message];
          if (newMessages.length > MAX_FRONTEND_MESSAGES) {
            return newMessages.slice(-MAX_FRONTEND_MESSAGES);
          }
          return newMessages;
        });
        break;

      case "task.tool_call":
        setToolCalls((prev) => {
          // Update existing or add new
          const index = prev.findIndex((tc) => tc.id === event.tool.id);
          if (index >= 0) {
            const newToolCalls = [...prev];
            newToolCalls[index] = mergeToolCallRecord(newToolCalls[index], event.tool);
            return newToolCalls;
          }
          const newToolCalls = [...prev, event.tool];
          if (newToolCalls.length > MAX_FRONTEND_TOOL_CALLS) {
            return newToolCalls.slice(-MAX_FRONTEND_TOOL_CALLS);
          }
          return newToolCalls;
        });
        break;

      case "task.tool_call.extra":
        setToolCalls((prev) => prev.map((toolCall) => (
          toolCall.id === event.toolId
            ? { ...toolCall, extras: upsertToolCallExtra(toolCall.extras, event.extra) }
            : toolCall
        )));
        break;

      case "task.iteration.start":
        // Clear progress content for new iteration
        // Keep messages, tool calls, and logs as they accumulate across iterations
        setProgressContent("");
        break;

      case "task.iteration.end":
      case "task.git.commit":
        // These events indicate git changes that affect the diff
        setGitChangeCounter((prev) => prev + 1);
        break;
    }
  };
}
