/**
 * Single loop hook.
 * Provides detailed state and real-time updates for a specific loop.
 *
 * Aggregates sub-hooks:
 * - useLoopStaleGuard  – stale-request guard utilities
 * - useLoopData        – state management, data fetching, hydration
 * - useLoopEventHandler – WebSocket event processing
 * - useLoopActions     – mutating action callbacks
 * - useLoopFileQueries – read-only file/diff queries
 */

import { useEffect, useRef } from "react";
import type { Loop, LoopEvent, UpdateLoopRequest, FileDiff, FileContentResponse, PullRequestDestinationResponse, MessageData, ToolCallData, SshSession } from "../../types";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type { LogEntry } from "../../components/LogViewer";
import { useLoopEvents } from "../useWebSocket";
import { createLogger } from "../../lib/logger";
import type { AcceptLoopResult, AcceptPlanResult, PushLoopResult, AddressCommentsResult, SetPendingResult } from "../loopActions";
import { useLoopStaleGuard } from "./useLoopStaleGuard";
import { useLoopData } from "./useLoopData";
import { createLoopEventHandler } from "./useLoopEventHandler";
import { useLoopActions } from "./useLoopActions";
import { useLoopFileQueries } from "./useLoopFileQueries";

const log = createLogger("useLoop");

export interface UseLoopResult {
  /** The loop data */
  loop: Loop | null;
  /** Whether the loop is loading */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** WebSocket connection status */
  connectionStatus: "connecting" | "open" | "closed" | "error";
  /** Recent events for this loop */
  events: LoopEvent[];
  /** Messages from the current/recent iterations */
  messages: MessageData[];
  /** Tool calls from the current/recent iterations */
  toolCalls: ToolCallData[];
  /** Streaming progress content (accumulated text deltas) */
  progressContent: string;
  /** Application logs from the loop engine */
  logs: LogEntry[];
  /** Counter that increments when git changes occur (use to trigger diff refresh) */
  gitChangeCounter: number;
  /** Whether this loop is in chat mode */
  isChatMode: boolean;
  /** Refresh loop data */
  refresh: () => Promise<void>;
  /** Update the loop */
  update: (request: UpdateLoopRequest) => Promise<boolean>;
  /** Delete the loop */
  remove: () => Promise<boolean>;
  /** Accept (merge) the loop's changes */
  accept: () => Promise<AcceptLoopResult>;
  /** Push the loop's branch to remote */
  push: () => Promise<PushLoopResult>;
  /** Update a pushed loop's branch by syncing with the base branch and re-pushing */
  updateBranch: () => Promise<PushLoopResult>;
  /** Discard the loop's changes */
  discard: () => Promise<boolean>;
  /** Purge the loop (permanently delete - only for merged/pushed/deleted loops) */
  purge: () => Promise<boolean>;
  /** Mark a loop as merged and sync with remote (only for final-state loops) */
  markMerged: () => Promise<boolean>;
  /** Set a pending prompt for the next iteration (only works when loop is running) */
  setPendingPrompt: (prompt: string, attachments?: MessageImageAttachment[]) => Promise<boolean>;
  /** Clear the pending prompt (only works when loop is running) */
  clearPendingPrompt: () => Promise<boolean>;
  /** Get the git diff */
  getDiff: () => Promise<FileDiff[]>;
  /** Get the plan.md content */
  getPlan: () => Promise<FileContentResponse>;
  /** Get the status.md content */
  getStatusFile: () => Promise<FileContentResponse>;
  /** Get pull request navigation metadata for pushed loops */
  getPullRequestDestination: () => Promise<PullRequestDestinationResponse>;
  /** Send feedback to refine the plan (only works when loop is in planning status) */
  sendPlanFeedback: (feedback: string, attachments?: MessageImageAttachment[]) => Promise<boolean>;
  /** Answer a pending plan-mode question */
  answerPlanQuestion: (answers: string[][]) => Promise<boolean>;
  /** Accept the plan via the requested mode (only works when loop is in planning status) */
  acceptPlan: (mode?: "start_loop" | "open_ssh") => Promise<AcceptPlanResult>;
  /** Discard the plan and delete the loop (only works when loop is in planning status) */
  discardPlan: () => Promise<boolean>;
  /** Address reviewer comments (only works for pushed/merged loops with reviewMode.addressable = true) */
  addressReviewComments: (comments: string, attachments?: MessageImageAttachment[]) => Promise<AddressCommentsResult>;
  /** Convert a completed chat into a plan-mode loop while preserving the same loop identity */
  convertChatToLoop: () => Promise<boolean>;
  /** Set pending message and/or model for next iteration (only works when loop is active) */
  setPending: (options: { message?: string; model?: { providerID: string; modelID: string }; attachments?: MessageImageAttachment[] }) => Promise<SetPendingResult>;
  /** Clear all pending values (message and model) */
  clearPending: () => Promise<boolean>;
  /** Send a message to a chat (only works for chat-mode loops) */
  sendChatMessage: (
    message: string,
    model?: { providerID: string; modelID: string },
    attachments?: MessageImageAttachment[],
  ) => Promise<boolean>;
  /** Start a new feedback cycle from a restartable terminal state */
  sendFollowUp: (
    message: string,
    model?: { providerID: string; modelID: string },
    attachments?: MessageImageAttachment[],
  ) => Promise<boolean>;
  /** Get or create the loop's linked SSH session */
  connectViaSsh: () => Promise<SshSession | null>;
}

/**
 * Hook for managing a single loop with real-time updates.
 */
export function useLoop(loopId: string): UseLoopResult {
  log.debug("useLoop initialized", { loopId });

  const hasMountedRef = useRef(false);

  // Stale-request guard — prevents state updates from previous loopId
  const { isActiveLoop, ignoreStaleLoopAction, ignoreStaleLoopError } =
    useLoopStaleGuard(loopId);

  // Core state and data fetching
  const data = useLoopData(loopId, isActiveLoop);
  const {
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
  } = data;

  // WebSocket event handler
  const handleEvent = createLoopEventHandler({
    isActiveLoop,
    refresh,
    setLogs,
      setMessages,
      setToolCalls,
      setProgressContent,
      setGitChangeCounter,
    });

  // WebSocket subscription for real-time updates
  const { events, status: connectionStatus, clearEvents } = useLoopEvents<LoopEvent>(loopId, {
    onEvent: handleEvent,
  });

  // Action callbacks
  const actions = useLoopActions({
    loopId,
    isActiveLoop,
    ignoreStaleLoopAction,
    ignoreStaleLoopError,
    setLoop,
    setError,
    refresh,
  });

  // Read-only file/diff queries
  const fileQueries = useLoopFileQueries({
    loopId,
    isActiveLoop,
    ignoreStaleLoopAction,
    ignoreStaleLoopError,
    setError,
  });

  // Whether this loop is in chat mode
  const isChatMode = loop?.config.mode === "chat";

  // Reset state when loopId changes (switching between loops)
  // This prevents stale data from appearing briefly when switching loops
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    refreshRequestIdRef.current += 1;
    // setLoading(true) is implicitly handled in useLoopData's refresh on next render
    setError(null);
    setLoop(null);
    setMessages([]);
    setToolCalls([]);
    setProgressContent("");
    setLogs([]);
    setGitChangeCounter(0);
    clearEvents();
    // Reset initial load tracking so the new loop hydrates from API
    initialLoadDoneRef.current = false;
  }, [
    abortControllerRef,
    clearEvents,
    initialLoadDoneRef,
    loopId,
    refreshRequestIdRef,
    setError,
    setGitChangeCounter,
    setLogs,
    setLoop,
    setMessages,
    setProgressContent,
    setToolCalls,
  ]);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Cleanup: Release memory and cancel in-flight requests when component unmounts
  // Critical for preventing memory leaks when closing LoopDetails
  // This handles the case where the component unmounts entirely (not just switching loops)
  // React state updates in cleanup are safe — warnings about unmounted components are
  // development-only and don't affect production behavior
  // Empty dependency array means this only runs on unmount, not on every render
  useEffect(() => {
    return () => {
      // Cancel any in-flight fetch request
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;

      setLoop(null);
      setMessages([]);
      setToolCalls([]);
      setProgressContent("");
      setLogs([]);
      setGitChangeCounter(0);
      refreshRequestIdRef.current += 1;
      clearEvents();
      // WebSocket cleanup is automatically handled by useLoopEvents hook
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    loop,
    loading,
    error,
    connectionStatus,
    events,
    messages,
    toolCalls,
    progressContent,
    logs,
    gitChangeCounter,
    isChatMode,
    refresh,
    ...actions,
    ...fileQueries,
  };
}
