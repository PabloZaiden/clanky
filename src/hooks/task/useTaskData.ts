/**
 * Core task data fetching and state management.
 * Handles HTTP fetching, abort controller, hydration from persisted state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatTranscript, Task, MessageData, ToolCallData, ToolCallDisplayData } from "@/shared";
import {
  mergeTranscriptSnapshotRecords,
  mergeTranscriptSnapshotToolCalls,
} from "@/shared";
import type { LogEntry } from "../../components/LogViewer";
import { createLogger } from "@pablozaiden/webapp/web";
import { appFetch } from "../../lib/public-path";
import { reconcileToolCallRecords } from "@/shared/tool-call";
import { normalizeHydratedTaskLogs } from "./response-log-normalization";

const log = createLogger("useTask");

export interface UseTaskDataResult {
  task: Task | null;
  setTask: Dispatch<SetStateAction<Task | null>>;
  loading: boolean;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  messages: MessageData[];
  setMessages: Dispatch<SetStateAction<MessageData[]>>;
  toolCalls: ToolCallDisplayData[];
  setToolCalls: Dispatch<SetStateAction<ToolCallDisplayData[]>>;
  progressContent: string;
  setProgressContent: Dispatch<SetStateAction<string>>;
  logs: LogEntry[];
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  gitChangeCounter: number;
  setGitChangeCounter: Dispatch<SetStateAction<number>>;
  refresh: (options?: { hydrateFromSnapshot?: boolean }) => Promise<void>;
  loadToolDetails: (toolCallId: string) => Promise<ToolCallData | null>;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  initialLoadDoneRef: React.MutableRefObject<boolean>;
  refreshRequestIdRef: React.MutableRefObject<number>;
}

export function useTaskData(
  taskId: string,
  isActiveTask: (expectedTaskId: string) => boolean,
): UseTaskDataResult {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallDisplayData[]>([]);
  const [progressContent, setProgressContent] = useState<string>("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [gitChangeCounter, setGitChangeCounter] = useState(0);

  const abortControllerRef = useRef<AbortController | null>(null);
  const snapshotEtagRef = useRef<string | null>(null);
  const initialLoadDoneRef = useRef(false);
  const refreshRequestIdRef = useRef(0);

  useEffect(() => {
    snapshotEtagRef.current = null;
  }, [taskId]);

  const refresh = useCallback(async (options?: { hydrateFromSnapshot?: boolean }) => {
    const requestTaskId = taskId;
    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    log.debug("Refreshing task data", { taskId: requestTaskId });

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
      if (isActiveTask(requestTaskId)) {
        setError(null);
      }
      const headers = new Headers();
      if (snapshotEtagRef.current) {
        headers.set("If-None-Match", snapshotEtagRef.current);
      }
      const response = await appFetch(`/api/tasks/${requestTaskId}/snapshot`, {
        signal: controller.signal,
        headers,
      });

      // Check if request was aborted during fetch
      if (
        controller.signal.aborted ||
        !isActiveTask(requestTaskId) ||
        refreshRequestIdRef.current !== requestId
      ) {
        return;
      }

      if (response.status === 304) {
        return;
      }

      if (!response.ok) {
        if (response.status === 404) {
          log.debug("Task not found", { taskId: requestTaskId });
          setTask(null);
          setError("Task not found");
          return;
        }
        throw new Error(`Failed to fetch task: ${response.statusText}`);
      }
      const data = (await response.json()) as {
        task: Task;
        transcript: ChatTranscript;
      };
      if (
        controller.signal.aborted ||
        !isActiveTask(requestTaskId) ||
        refreshRequestIdRef.current !== requestId
      ) {
        return;
      }
      snapshotEtagRef.current = response.headers.get("ETag");
      setTask((current) => current ? {
        ...data.task,
        state: {
          ...data.task.state,
          toolCalls: reconcileToolCallRecords(
            (current.state.toolCalls as ToolCallData[] | undefined) ?? [],
            (data.task.state.toolCalls as ToolCallData[] | undefined) ?? [],
          ),
        },
      } : data.task);
      log.debug("Task data refreshed", { taskId: requestTaskId, status: data.task.state.status });

      // Hydrate persisted data on the first successful load and on explicit reconnect recovery.
      // Using a ref avoids adding state array lengths to the dependency array,
      // which would cause a refresh cascade: event adds item → length changes →
      // refresh recreated → useEffect fires → full API refetch.
      if (!initialLoadDoneRef.current || options?.hydrateFromSnapshot) {
        initialLoadDoneRef.current = true;

        const latestLogs = data.transcript.logs?.map((logEntry) => ({
          id: logEntry.id,
          level: logEntry.level,
          message: logEntry.message,
          details: logEntry.details,
          timestamp: logEntry.timestamp,
        })) ?? [];
        setLogs((current) => normalizeHydratedTaskLogs(
          mergeTranscriptSnapshotRecords(current, latestLogs),
        ));

        const latestMessages = data.transcript.messages?.map((msg) => ({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          attachments: msg.attachments,
          timestamp: msg.timestamp,
        })) ?? [];
        setMessages((current) => mergeTranscriptSnapshotRecords(current, latestMessages));

        const latestToolCalls = data.transcript.toolCalls ?? [];
        setToolCalls((current) => mergeTranscriptSnapshotToolCalls(current, latestToolCalls));

        if (options?.hydrateFromSnapshot) {
          setProgressContent("");
        }
      }
    } catch (err) {
      // Ignore abort errors — they are expected during cleanup
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!isActiveTask(requestTaskId) || refreshRequestIdRef.current !== requestId) {
        return;
      }
      log.error("Failed to refresh task", { taskId: requestTaskId, error: String(err) });
      setError(String(err));
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      if (isInitialLoad && isActiveTask(requestTaskId) && refreshRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [isActiveTask, taskId]);

  const loadToolDetails = useCallback(async (toolCallId: string): Promise<ToolCallData | null> => {
    const response = await appFetch(`/api/tasks/${taskId}/tool-calls/${encodeURIComponent(toolCallId)}`);
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch task tool call: ${response.statusText}`);
    }
    return await response.json() as ToolCallData;
  }, [taskId]);

  return {
    task,
    setTask,
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
    loadToolDetails,
    abortControllerRef,
    initialLoadDoneRef,
    refreshRequestIdRef,
  };
}
