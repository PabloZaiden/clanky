/**
 * WebSocket event handler for loop real-time updates.
 * Processes incoming LoopEvents and dispatches state updates.
 */

import type { Dispatch, SetStateAction } from "react";
import type { LoopEvent, MessageData, ToolCallData } from "../../types";
import type { LogEntry } from "../../components/LogViewer";
import { createLogger } from "../../lib/logger";
import { MAX_FRONTEND_LOGS, MAX_FRONTEND_MESSAGES, MAX_FRONTEND_TOOL_CALLS } from "./useLoopData";
import { finalizeLatestResponseLog } from "./response-log-normalization";
import { mergeToolCallRecord, upsertToolCallExtra } from "../../types/tool-call";

const log = createLogger("useLoop");

export interface LoopEventHandlerParams {
  isActiveLoop: (expectedLoopId: string) => boolean;
  refresh: () => Promise<void>;
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  setMessages: Dispatch<SetStateAction<MessageData[]>>;
  setToolCalls: Dispatch<SetStateAction<ToolCallData[]>>;
  setProgressContent: Dispatch<SetStateAction<string>>;
  setGitChangeCounter: Dispatch<SetStateAction<number>>;
}

/** Returns a stable event handler function for use with useLoopEvents. */
export function createLoopEventHandler(params: LoopEventHandlerParams) {
  const {
    isActiveLoop,
    refresh,
    setLogs,
    setMessages,
    setToolCalls,
    setProgressContent,
    setGitChangeCounter,
  } = params;

  return function handleEvent(event: LoopEvent) {
    if (!isActiveLoop(event.loopId)) {
      log.trace("Ignoring event for inactive loop", {
        type: event.type,
        eventLoopId: event.loopId,
        activeLoopId: "(stale)",
      });
      return;
    }

    log.trace("Received event", { loopId: event.loopId, type: event.type });
    switch (event.type) {
      case "loop.log":
        // Update existing log entry or add new one
        setLogs((prev) => {
          const existingIndex = prev.findIndex((logEntry) => logEntry.id === event.id);
          if (existingIndex >= 0) {
            const existingLog = prev[existingIndex];
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

      case "loop.progress":
        // Accumulate streaming text deltas
        setProgressContent((prev) => prev + event.content);
        break;

      case "loop.message":
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

      case "loop.tool_call":
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

      case "loop.tool_call.extra":
        setToolCalls((prev) => prev.map((toolCall) => (
          toolCall.id === event.toolId
            ? { ...toolCall, extras: upsertToolCallExtra(toolCall.extras, event.extra) }
            : toolCall
        )));
        break;

      case "loop.iteration.start":
        // Clear progress content for new iteration
        // Keep messages, tool calls, and logs as they accumulate across iterations
        setProgressContent("");
        refresh();
        break;

      case "loop.started":
      case "loop.stopped":
      case "loop.completed":
      case "loop.ssh_handoff":
      case "loop.merged":
      case "loop.accepted":
      case "loop.pushed":
      case "loop.discarded":
      case "loop.error":
      case "loop.plan.ready":
      case "loop.plan.feedback":
      case "loop.plan.accepted":
      case "loop.plan.discarded":
      case "loop.automatic_pr_flow.updated":
        refresh();
        break;

      case "loop.iteration.end":
      case "loop.git.commit":
        // These events indicate git changes that affect the diff
        setGitChangeCounter((prev) => prev + 1);
        refresh();
        break;
      case "loop.pending.updated":
        // Pending values changed - refresh to get updated state
        refresh();
        break;
    }
  };
}
