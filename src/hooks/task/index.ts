/**
 * Single task hook.
 * Provides detailed state and real-time updates for a specific task.
 *
 * Aggregates sub-hooks:
 * - useTaskStaleGuard  – stale-request guard utilities
 * - useTaskData        – state management, data fetching, hydration
 * - useTaskEventHandler – incremental realtime stream processing
 * - useTaskActions     – mutating action callbacks
 * - useTaskFileQueries – read-only file/diff queries
 */

import { useEffect, useRef } from "react";
import type { Task, TaskEvent, MessageData, ToolCallData, ToolCallDisplayData, SshSession } from "@/shared";
import type { UpdateTaskRequest, FileDiff, FileContentResponse, PullRequestDestinationResponse } from "@/contracts";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import type { FollowUpPromptMode } from "@/shared/task";
import type { LogEntry } from "../../components/LogViewer";
import { useRealtimeRefreshWithRecovery, useRealtimeStream } from "../useRealtimeStream";
import { createLogger } from "@pablozaiden/webapp/web";
import type {
  AcceptTaskResult,
  AcceptPlanResult,
  PushTaskResult,
  AddressCommentsResult,
  AutomaticPrFlowResult,
  PullRequestAutoMergeResult,
  SetPendingResult,
} from "../taskActions";
import { useTaskStaleGuard } from "./useTaskStaleGuard";
import { useTaskData } from "./useTaskData";
import { createTaskEventHandler } from "./useTaskEventHandler";
import { useTaskActions } from "./useTaskActions";
import { useTaskFileQueries } from "./useTaskFileQueries";

const log = createLogger("useTask");

export interface UseTaskResult {
  /** The task data */
  task: Task | null;
  /** Whether the task is loading */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** WebSocket connection status */
  connectionStatus: "connecting" | "open" | "closed" | "error";
  /** Messages from the current/recent iterations */
  messages: MessageData[];
  /** Tool calls from the current/recent iterations */
  toolCalls: ToolCallDisplayData[];
  /** Streaming progress content (accumulated text deltas) */
  progressContent: string;
  /** Application logs from the task engine */
  logs: LogEntry[];
  /** Counter that increments when git changes occur (use to trigger diff refresh) */
  gitChangeCounter: number;
  /** Refresh task data */
  refresh: () => Promise<void>;
  /** Load one complete tool-call payload when expanded. */
  loadToolDetails: (toolCallId: string) => Promise<ToolCallData | null>;
  /** Update the task */
  update: (request: UpdateTaskRequest) => Promise<boolean>;
  /** Delete the task */
  remove: () => Promise<boolean>;
  /** Stop the active task without deleting it */
  stopTask: () => Promise<boolean>;
  /** Accept the task's committed changes locally */
  accept: () => Promise<AcceptTaskResult>;
  /** Push the task's branch to remote */
  push: () => Promise<PushTaskResult>;
  /** Update a pushed task's branch by syncing with the base branch and re-pushing */
  updateBranch: () => Promise<PushTaskResult>;
  /** Discard the task's changes */
  discard: () => Promise<boolean>;
  /** Purge the task (permanently delete - only for accepted/pushed/merged/deleted tasks) */
  purge: () => Promise<boolean>;
  /** Mark a task as merged and sync with remote (only for final-state tasks) */
  markMerged: () => Promise<boolean>;
  /** Close a locally accepted task without PR actions */
  closeLocalTask: () => Promise<boolean>;
  /** Promote a stopped or failed task into completed status without resuming execution */
  manualCompleteTask: () => Promise<boolean>;
  /** Set a pending prompt for the next iteration (only works when task is running) */
  setPendingPrompt: (prompt: string, attachments?: MessageImageAttachment[]) => Promise<boolean>;
  /** Clear the pending prompt (only works when task is running) */
  clearPendingPrompt: () => Promise<boolean>;
  /** Get the git diff */
  getDiff: () => Promise<FileDiff[]>;
  /** Get the plan.md content */
  getPlan: () => Promise<FileContentResponse>;
  /** Get the status.md content */
  getStatusFile: () => Promise<FileContentResponse>;
  /** Get pull request navigation metadata for pushed tasks */
  getPullRequestDestination: () => Promise<PullRequestDestinationResponse>;
  /** Send feedback to refine the plan (only works when task is in planning status) */
  sendPlanFeedback: (feedback: string, attachments?: MessageImageAttachment[]) => Promise<boolean>;
  /** Accept the plan via the requested mode (only works when task is in planning status) */
  acceptPlan: (mode?: "start_task" | "open_ssh") => Promise<AcceptPlanResult>;
  /** Discard the plan and delete the task (only works when task is in planning status) */
  discardPlan: () => Promise<boolean>;
  /** Address reviewer comments (only works for pushed/merged tasks with reviewMode.addressable = true) */
  addressReviewComments: (comments: string, attachments?: MessageImageAttachment[]) => Promise<AddressCommentsResult>;
  /** Enable GitHub auto-merge for an existing pull request */
  enablePullRequestAutoMerge: () => Promise<PullRequestAutoMergeResult>;
  /** Enable automatic pull request monitoring and automated follow-up handling */
  startAutomaticPrFlow: () => Promise<AutomaticPrFlowResult>;
  /** Disable automatic pull request monitoring and return control to manual handling */
  stopAutomaticPrFlow: () => Promise<AutomaticPrFlowResult>;
  /** Set pending message and/or model for next iteration (only works when task is active) */
  setPending: (options: { message?: string; model?: { providerID: string; modelID: string }; attachments?: MessageImageAttachment[] }) => Promise<SetPendingResult>;
  /** Clear all pending values (message and model) */
  clearPending: () => Promise<boolean>;
  /** Start a new feedback cycle from a restartable terminal state */
  sendFollowUp: (
    message: string,
    model?: { providerID: string; modelID: string },
    attachments?: MessageImageAttachment[],
    promptMode?: FollowUpPromptMode,
  ) => Promise<boolean>;
  /** Get or create the task's linked SSH session */
  connectViaSsh: () => Promise<SshSession | null>;
}

/**
 * Hook for managing a single task with real-time updates.
 */
export function useTask(taskId: string): UseTaskResult {
  log.debug("useTask initialized", { taskId });

  const hasMountedRef = useRef(false);

  // Stale-request guard — prevents state updates from previous taskId
  const { isActiveTask, ignoreStaleTaskAction, ignoreStaleTaskError } =
    useTaskStaleGuard(taskId);

  // Core state and data fetching
  const data = useTaskData(taskId, isActiveTask);
  const {
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
  } = data;

  // WebSocket event handler
  const handleEvent = createTaskEventHandler({
    isActiveTask,
    refresh,
    setLogs,
    setMessages,
    setToolCalls,
    setProgressContent,
    setGitChangeCounter,
  });

  const { status: connectionStatus } = useRealtimeStream<TaskEvent>({
    filters: { taskId },
    predicate: (event) => event.type.startsWith("task."),
    onEvent: handleEvent,
  });

  useRealtimeRefreshWithRecovery({
    resources: ["tasks"],
    ids: [taskId],
    filters: { resource: "tasks", id: taskId },
    refresh: () => refresh({ hydrateFromSnapshot: true }),
    onReconnect: () => refresh({ hydrateFromSnapshot: true }),
  });

  // Action callbacks
  const actions = useTaskActions({
    taskId,
    isActiveTask,
    ignoreStaleTaskAction,
    ignoreStaleTaskError,
    setTask,
    setError,
    refresh,
  });

  // Read-only file/diff queries
  const fileQueries = useTaskFileQueries({
    taskId,
    task,
    isActiveTask,
    ignoreStaleTaskAction,
    ignoreStaleTaskError,
    setError,
  });

  // Reset state when taskId changes (switching between tasks)
  // This prevents stale data from appearing briefly when switching tasks
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    refreshRequestIdRef.current += 1;
    // setLoading(true) is implicitly handled in useTaskData's refresh on next render
    setError(null);
    setTask(null);
    setMessages([]);
    setToolCalls([]);
    setProgressContent("");
    setLogs([]);
    setGitChangeCounter(0);
    // Reset initial load tracking so the new task hydrates from API
    initialLoadDoneRef.current = false;
  }, [
    abortControllerRef,
    initialLoadDoneRef,
    taskId,
    refreshRequestIdRef,
    setError,
    setGitChangeCounter,
    setLogs,
    setTask,
    setMessages,
    setProgressContent,
    setToolCalls,
  ]);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Cleanup: Release memory and cancel in-flight requests when component unmounts
  // Critical for preventing memory leaks when closing TaskDetails
  // This handles the case where the component unmounts entirely (not just switching tasks)
  // React state updates in cleanup are safe — warnings about unmounted components are
  // development-only and don't affect production behavior
  // Empty dependency array means this only runs on unmount, not on every render
  useEffect(() => {
    return () => {
      // Cancel any in-flight fetch request
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;

      setTask(null);
      setMessages([]);
      setToolCalls([]);
      setProgressContent("");
      setLogs([]);
      setGitChangeCounter(0);
      refreshRequestIdRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    task,
    loading,
    error,
    connectionStatus,
    messages,
    toolCalls,
    progressContent,
    logs,
    gitChangeCounter,
    refresh,
    loadToolDetails,
    ...actions,
    ...fileQueries,
  };
}
