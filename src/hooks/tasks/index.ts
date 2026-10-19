/**
 * Tasks state management hook.
 * Provides CRUD operations and real-time state updates for tasks.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "@pablozaiden/webapp/web";
import {
  acceptTaskApi,
  pushTaskApi,
  updateBranchApi,
  discardTaskApi,
  deleteTaskApi,
  purgeTaskApi,
  purgeArchivedWorkspaceTasksApi,
  addressReviewCommentsApi,
  type AcceptTaskResult,
  type PushTaskResult,
  type AddressCommentsResult,
  type PurgeArchivedTasksResult,
} from "../taskActions";
import type { Task } from "@/shared";
import type { CreateTaskRequest, UpdateTaskRequest, UncommittedChangesError } from "@/contracts";
import type { MessageAttachment } from "@/shared/message-attachments";
import { apiRequest, readApiResponse, requestApiResponse } from "../../lib/api-client";
import { parseApiError } from "../../lib/api-error";
import { isAbortError } from "../../lib/request-lifecycle";

export interface CreateTaskResult {
  task: Task | null;
  startError?: UncommittedChangesError;
}

export interface UseTasksResult {
  /** Array of all tasks */
  tasks: Task[];
  /** Whether tasks are currently loading */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Refresh tasks from the server */
  refresh: () => Promise<void>;
  /** Refresh a routed task through its authoritative item endpoint */
  refreshTaskById: (id: string, signal?: AbortSignal) => Promise<boolean | null>;
  /** Create a new task (tasks are always started immediately) */
  createTask: (request: CreateTaskRequest) => Promise<CreateTaskResult>;
  /** Update an existing task */
  updateTask: (id: string, request: UpdateTaskRequest) => Promise<Task | null>;
  /** Delete a task */
  deleteTask: (id: string) => Promise<boolean>;
  /** Optimistically remove a draft status before startup setup begins */
  markTaskStarting: (id: string, status: "starting" | "planning") => void;
  /** Stop overlaying an optimistic startup status after a pre-claim failure */
  clearOptimisticTaskStart: (id: string) => void;
  /** Accept a task's committed changes locally */
  acceptTask: (id: string) => Promise<AcceptTaskResult>;
  /** Push a task's branch to remote */
  pushTask: (id: string) => Promise<PushTaskResult>;
  /** Update a pushed task's branch by syncing with the base branch and re-pushing */
  updateBranch: (id: string) => Promise<PushTaskResult>;
  /** Discard a task's changes */
  discardTask: (id: string) => Promise<boolean>;
  /** Purge a task (permanently delete - only for merged/pushed/deleted tasks) */
  purgeTask: (id: string) => Promise<boolean>;
  /** Purge all archived tasks for a workspace */
  purgeArchivedWorkspaceTasks: (workspaceId: string) => Promise<PurgeArchivedTasksResult>;
  /** Address reviewer comments (only for pushed/merged tasks with reviewMode.addressable = true) */
  addressReviewComments: (id: string, comments: string, attachments?: MessageAttachment[]) => Promise<AddressCommentsResult>;
  /** Get a task by ID */
  getTask: (id: string) => Task | undefined;
}

/**
 * Hook for managing tasks state with framework realtime resource updates.
 */
export function useTasks(): UseTasksResult {
  const [error, setError] = useState<string | null>(null);
  const query = useLiveQuery<Task[]>({
    load: (signal) => apiRequest<Task[]>("/api/tasks", {
      signal,
      action: "Fetch tasks",
      fallbackMessage: "Failed to fetch tasks",
    }),
    realtime: { resources: ["tasks"] },
  });
  const [optimisticStatuses, setOptimisticStatuses] = useState<Record<string, "starting" | "planning">>({});
  const tasks = useMemo(() => (query.data ?? []).map((task) => {
    const status = optimisticStatuses[task.config.id];
    return status && task.state.status === "draft"
      ? { ...task, state: { ...task.state, status } }
      : task;
  }), [optimisticStatuses, query.data]);
  const mutate = query.mutate;
  const refresh = useCallback(async () => {
    setError(null);
    await query.refresh();
  }, [query.refresh]);

  useEffect(() => {
    if (!query.data) return;
    setOptimisticStatuses((current) => {
      const drafts = new Set(query.data!.filter((task) => task.state.status === "draft").map((task) => task.config.id));
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => drafts.has(id)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [query.data]);

  const runMutation = useCallback(async <T,>(
    operation: (signal: AbortSignal) => Promise<T>,
    fallback: T,
    reconcile?: (previous: Task[] | undefined, result: T) => Task[] | undefined,
  ): Promise<T> => {
    try {
      setError(null);
      return await mutate(operation, reconcile);
    } catch (error) {
      setError(String(error));
      return fallback;
    }
  }, [mutate]);

  const createTask = useCallback((request: CreateTaskRequest): Promise<CreateTaskResult> => runMutation<CreateTaskResult>(async (signal) => {
    const response = await requestApiResponse("/api/tasks", {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      action: "Create task",
      fallbackMessage: "Failed to create task",
      acceptedStatuses: [409],
    });
    if (response.status === 409) {
      const error = await parseApiError(response, "Failed to create task");
      if (error.code !== "uncommitted_changes") throw error;
      const changedFiles = error.data?.["changedFiles"];
      return {
        task: null,
        startError: {
          error: "uncommitted_changes",
          message: error.message,
          changedFiles: Array.isArray(changedFiles)
            ? changedFiles.filter((file): file is string => typeof file === "string")
            : [],
        },
      };
    }
    return { task: await readApiResponse<Task>(response) };
  }, { task: null }, (previous, result) => result.task
    ? [...(previous ?? []).filter((task) => task.config.id !== result.task!.config.id), result.task]
    : previous), [runMutation]);

  const updateTask = useCallback((id: string, request: UpdateTaskRequest): Promise<Task | null> => runMutation<Task | null>(
    (signal) => apiRequest<Task>(`/api/tasks/${id}`, {
      signal,
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      action: "Update task",
      fallbackMessage: "Failed to update task",
    }),
    null,
    (previous, task) => task ? previous?.map((item) => item.config.id === id ? task : item) : previous,
  ), [runMutation]);

  const deleteTask = useCallback((id: string) => runMutation(
    () => deleteTaskApi(id),
    false,
  ), [runMutation]);
  const acceptTask = useCallback((id: string) => runMutation(
    () => acceptTaskApi(id),
    { success: false },
  ), [runMutation]);
  const pushTask = useCallback((id: string) => runMutation(
    () => pushTaskApi(id),
    { success: false },
  ), [runMutation]);
  const updateBranch = useCallback((id: string) => runMutation(
    () => updateBranchApi(id),
    { success: false },
  ), [runMutation]);
  const discardTask = useCallback((id: string) => runMutation(
    () => discardTaskApi(id),
    false,
  ), [runMutation]);
  const purgeTask = useCallback((id: string) => runMutation(
    () => purgeTaskApi(id),
    false,
    (previous, success) => success ? previous?.filter((task) => task.config.id !== id) : previous,
  ), [runMutation]);
  const purgeArchivedWorkspaceTasks = useCallback((workspaceId: string) => runMutation<PurgeArchivedTasksResult>(
    () => purgeArchivedWorkspaceTasksApi(workspaceId),
    { success: false, workspaceId, totalArchived: 0, purgedCount: 0, purgedTaskIds: [], failures: [] },
    (previous, result) => {
      const purged = new Set(result.purgedTaskIds);
      return previous?.filter((task) => !purged.has(task.config.id));
    },
  ), [runMutation]);
  const addressReviewComments = useCallback((id: string, comments: string, attachments?: MessageAttachment[]) => runMutation(
    () => addressReviewCommentsApi(id, comments, attachments),
    { success: false },
  ), [runMutation]);

  const refreshTaskById = useCallback(async (id: string, signal?: AbortSignal): Promise<boolean | null> => {
    try {
      const task = await mutate(async (operationSignal) => {
        const requestSignal = signal ? AbortSignal.any([signal, operationSignal]) : operationSignal;
        const response = await requestApiResponse(`/api/tasks/${encodeURIComponent(id)}`, {
          signal: requestSignal,
          action: "Verify task",
          fallbackMessage: "Failed to verify task",
          acceptedStatuses: [404],
        });
        const task = response.status === 404 ? null : await readApiResponse<Task>(response);
        requestSignal.throwIfAborted();
        return task;
      }, (previous, task) => {
        const remaining = (previous ?? []).filter((item) => item.config.id !== id);
        return task ? [...remaining, task] : remaining;
      });
      return signal?.aborted ? null : task !== null;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return null;
      setError(String(error));
      return null;
    }
  }, [mutate]);

  const markTaskStarting = useCallback((id: string, status: "starting" | "planning") => {
    setOptimisticStatuses((current) => ({ ...current, [id]: status }));
  }, []);
  const clearOptimisticTaskStart = useCallback((id: string) => {
    setOptimisticStatuses((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);
  const getTask = useCallback((id: string) => tasks.find((task) => task.config.id === id), [tasks]);

  return {
    tasks,
    loading: query.data === undefined && query.loading,
    error: error ?? (query.error && !isAbortError(query.error) ? String(query.error) : null),
    refresh,
    refreshTaskById,
    createTask,
    updateTask,
    deleteTask,
    markTaskStarting,
    clearOptimisticTaskStart,
    acceptTask,
    pushTask,
    updateBranch,
    discardTask,
    purgeTask,
    purgeArchivedWorkspaceTasks,
    addressReviewComments,
    getTask,
  };
}
