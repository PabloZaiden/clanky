/**
 * Core loop data fetching and state management.
 * Handles HTTP fetching, abort controller, hydration from persisted state.
 */

import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Loop, MessageData, ToolCallData } from "../../types";
import type { LogEntry } from "../../components/LogViewer";
import { createLogger } from "../../lib/logger";
import { appFetch } from "../../lib/public-path";
import { normalizeHydratedLoopLogs } from "./response-log-normalization";

const log = createLogger("useLoop");

/** Maximum number of log entries to keep in frontend state */
export const MAX_FRONTEND_LOGS = 2000;
/** Maximum number of messages to keep in frontend state */
export const MAX_FRONTEND_MESSAGES = 1000;
/** Maximum number of tool calls to keep in frontend state */
export const MAX_FRONTEND_TOOL_CALLS = 2000;

export interface UseLoopDataResult {
  loop: Loop | null;
  setLoop: Dispatch<SetStateAction<Loop | null>>;
  loading: boolean;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  messages: MessageData[];
  setMessages: Dispatch<SetStateAction<MessageData[]>>;
  toolCalls: ToolCallData[];
  setToolCalls: Dispatch<SetStateAction<ToolCallData[]>>;
  progressContent: string;
  setProgressContent: Dispatch<SetStateAction<string>>;
  logs: LogEntry[];
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  gitChangeCounter: number;
  setGitChangeCounter: Dispatch<SetStateAction<number>>;
  refresh: () => Promise<void>;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  initialLoadDoneRef: React.MutableRefObject<boolean>;
  refreshRequestIdRef: React.MutableRefObject<number>;
}

export function useLoopData(
  loopId: string,
  isActiveLoop: (expectedLoopId: string) => boolean,
): UseLoopDataResult {
  const [loop, setLoop] = useState<Loop | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallData[]>([]);
  const [progressContent, setProgressContent] = useState<string>("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [gitChangeCounter, setGitChangeCounter] = useState(0);

  const abortControllerRef = useRef<AbortController | null>(null);
  const initialLoadDoneRef = useRef(false);
  const refreshRequestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestLoopId = loopId;
    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    log.debug("Refreshing loop data", { loopId: requestLoopId });

    // Cancel any in-flight request
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Only show loading spinner on initial load to prevent flicker on event-driven refreshes
    const isInitialLoad = !initialLoadDoneRef.current;

    try {
      if (isInitialLoad) {
        setLoading(true);
      }
      if (isActiveLoop(requestLoopId)) {
        setError(null);
      }
      const response = await appFetch(`/api/loops/${requestLoopId}`, {
        signal: controller.signal,
      });

      // Check if request was aborted during fetch
      if (
        controller.signal.aborted ||
        !isActiveLoop(requestLoopId) ||
        refreshRequestIdRef.current !== requestId
      ) {
        return;
      }

      if (!response.ok) {
        if (response.status === 404) {
          log.debug("Loop not found", { loopId: requestLoopId });
          setLoop(null);
          setError("Loop not found");
          return;
        }
        throw new Error(`Failed to fetch loop: ${response.statusText}`);
      }
      const data = (await response.json()) as Loop;
      if (
        controller.signal.aborted ||
        !isActiveLoop(requestLoopId) ||
        refreshRequestIdRef.current !== requestId
      ) {
        return;
      }
      setLoop(data);
      log.debug("Loop data refreshed", { loopId: requestLoopId, status: data.state.status });

      // Hydrate persisted data only on the first successful load.
      // Using a ref avoids adding state array lengths to the dependency array,
      // which would cause a refresh cascade: event adds item → length changes →
      // refresh recreated → useEffect fires → full API refetch.
      if (!initialLoadDoneRef.current) {
        initialLoadDoneRef.current = true;

        // Load persisted logs from loop state (latest 1000 to keep UI responsive)
        if (data.state.logs && data.state.logs.length > 0) {
          const latestLogs = data.state.logs.slice(-1000);
          setLogs(
            normalizeHydratedLoopLogs(
              latestLogs.map((logEntry) => ({
                id: logEntry.id,
                level: logEntry.level,
                message: logEntry.message,
                details: logEntry.details,
                timestamp: logEntry.timestamp,
              })),
            ),
          );
        }

        // Load persisted messages from loop state (latest 1000)
        if (data.state.messages && data.state.messages.length > 0) {
          const latestMessages = data.state.messages.slice(-1000);
          setMessages(
            latestMessages.map((msg) => ({
              id: msg.id,
              role: msg.role,
              content: msg.content,
              attachments: msg.attachments,
              timestamp: msg.timestamp,
            })),
          );
        }

        // Load persisted tool calls from loop state (latest 1000)
        if (data.state.toolCalls && data.state.toolCalls.length > 0) {
          const latestToolCalls = data.state.toolCalls.slice(-1000);
          setToolCalls(
            latestToolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              input: tc.input,
              output: tc.output,
              status: tc.status,
              timestamp: tc.timestamp,
            })),
          );
        }
      }
    } catch (err) {
      // Ignore abort errors — they are expected during cleanup
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!isActiveLoop(requestLoopId) || refreshRequestIdRef.current !== requestId) {
        return;
      }
      log.error("Failed to refresh loop", { loopId: requestLoopId, error: String(err) });
      setError(String(err));
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      if (isInitialLoad && isActiveLoop(requestLoopId) && refreshRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [isActiveLoop, loopId]);

  return {
    loop,
    setLoop,
    loading,
    error,
    setError,
    messages,
    setMessages,
    toolCalls,
    setToolCalls,
    progressContent,
    setProgressContent,
    logs,
    setLogs,
    gitChangeCounter,
    setGitChangeCounter,
    refresh,
    abortControllerRef,
    initialLoadDoneRef,
    refreshRequestIdRef,
  };
}
