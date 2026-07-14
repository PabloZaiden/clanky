/**
 * Tasks state management hook.
 * Provides CRUD operations and real-time state updates for tasks.
 */

export type { CreateTaskResult } from "./use-task-mutations";
export type { UseTasksStateResult } from "./use-tasks-state";

import { useTasksState } from "./use-tasks-state";
import { useTaskEvents } from "./use-task-events";
import { useTaskMutations, type CreateTaskResult } from "./use-task-mutations";
import { useTaskActions } from "./use-task-actions";
import type { AcceptTaskResult, PushTaskResult, AddressCommentsResult, PurgeArchivedTasksResult } from "../taskActions";
import type { Task } from "@/shared";
import type { CreateTaskRequest, UpdateTaskRequest } from "@/contracts";
import type { MessageImageAttachment } from "@/shared/message-attachments";

export interface UseTasksResult {
  /** Array of all tasks */
  tasks: Task[];
  /** Whether tasks are currently loading */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Refresh tasks from the server */
  refresh: () => Promise<void>;
  /** Create a new task (tasks are always started immediately) */
  createTask: (request: CreateTaskRequest) => Promise<CreateTaskResult>;
  /** Update an existing task */
  updateTask: (id: string, request: UpdateTaskRequest) => Promise<Task | null>;
  /** Delete a task */
  deleteTask: (id: string) => Promise<boolean>;
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
  addressReviewComments: (id: string, comments: string, attachments?: MessageImageAttachment[]) => Promise<AddressCommentsResult>;
  /** Get a task by ID */
  getTask: (id: string) => Task | undefined;
}

/**
 * Hook for managing tasks state with real-time updates via WebSocket.
 */
export function useTasks(): UseTasksResult {
  const { tasks, loading, error, setTasks, setError, refresh, refreshTask, getTask } = useTasksState();

  useTaskEvents({ refresh, refreshTask, setTasks });

  const { createTask, updateTask, deleteTask } = useTaskMutations({ setError, setTasks });

  const { acceptTask, pushTask, updateBranch, discardTask, purgeTask, purgeArchivedWorkspaceTasks, addressReviewComments } =
    useTaskActions({ setError, setTasks, refreshTask });

  return {
    tasks,
    loading,
    error,
    refresh,
    createTask,
    updateTask,
    deleteTask,
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
