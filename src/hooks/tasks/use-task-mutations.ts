/**
 * Task CRUD mutations: create, update, delete.
 */

import { useCallback } from "react";
import type { Task } from "@/shared";
import type { CreateTaskRequest, UpdateTaskRequest, UncommittedChangesError } from "@/contracts";
import { createLogger } from "@pablozaiden/webapp/web";
import { parseApiError } from "../../lib/api-error";
import { apiRequest, readApiResponse, requestApiResponse } from "../../lib/api-client";
import { deleteTaskApi } from "../taskActions";

export interface CreateTaskResult {
  /** The created task, or null if creation failed */
  task: Task | null;
  /** Error if the task was created but failed to start (e.g., uncommitted changes) */
  startError?: UncommittedChangesError;
}

interface UseTaskMutationsOptions {
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
}

export interface UseTaskMutationsResult {
  createTask: (request: CreateTaskRequest) => Promise<CreateTaskResult>;
  updateTask: (id: string, request: UpdateTaskRequest) => Promise<Task | null>;
  deleteTask: (id: string) => Promise<boolean>;
}

export function useTaskMutations({ setError, setTasks }: UseTaskMutationsOptions): UseTaskMutationsResult {
  const log = createLogger("useTaskMutations");
  const createTask = useCallback(async (request: CreateTaskRequest): Promise<CreateTaskResult> => {
    try {
      const response = await requestApiResponse("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Create task",
        fallbackMessage: "Failed to create task",
        acceptedStatuses: [409],
      });

      if (response.status === 409) {
        const error = await parseApiError(response, "Failed to create task");
        if (error.code === "uncommitted_changes") {
          const changedFiles = error.data?.["changedFiles"];
          return {
            task: null,
            startError: {
              error: "uncommitted_changes",
              message: error.message,
              changedFiles: Array.isArray(changedFiles)
                ? changedFiles.filter((file): file is string => typeof file === "string")
                : [],
            } satisfies UncommittedChangesError,
          };
        }
        throw error;
      }

      const task = await readApiResponse<Task>(response);
      // Don't add to state here - let the WebSocket event handle it
      // to avoid duplicate entries during the brief moment before refresh completes
      return { task };
    } catch (err) {
      log.error("Failed to create task", {
        workspaceId: request.workspaceId,
        useWorktree: request.useWorktree,
        error: String(err),
      });
      setError(String(err));
      return { task: null };
    }
  }, [setError]);

  const updateTask = useCallback(async (id: string, request: UpdateTaskRequest): Promise<Task | null> => {
    try {
      const task = await apiRequest<Task>(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Update task",
        fallbackMessage: "Failed to update task",
      });
      // Update state immediately for config changes (no WebSocket event for PATCH)
      setTasks((prev) => prev.map((l) => (l.config.id === id ? task : l)));
      return task;
    } catch (err) {
      log.error("Failed to update task", { taskId: id, error: String(err) });
      setError(String(err));
      return null;
    }
  }, [setError, setTasks]);

  const deleteTask = useCallback(async (id: string): Promise<boolean> => {
    try {
      await deleteTaskApi(id);
      // Don't remove from state here - let the WebSocket event handle it
      // to avoid race conditions with state updates
      return true;
    } catch (err) {
      log.error("Failed to delete task", { taskId: id, error: String(err) });
      setError(String(err));
      return false;
    }
  }, [setError]);

  return { createTask, updateTask, deleteTask };
}
