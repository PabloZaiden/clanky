/**
 * Core tasks state: data fetching, refresh, and getTask.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "@/shared";
import { log } from "@pablozaiden/webapp/web";
import { appFetch } from "../../lib/public-path";

export interface UseTasksStateResult {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  refresh: (options?: { showLoading?: boolean }) => Promise<void>;
  refreshTask: (id: string) => Promise<void>;
  markTaskStarting: (id: string, status: "starting" | "planning") => void;
  clearOptimisticTaskStart: (id: string) => void;
  getTask: (id: string) => Task | undefined;
}

export function useTasksState(): UseTasksStateResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // AbortController for cancelling in-flight fetch requests on unmount
  const abortControllerRef = useRef<AbortController | null>(null);
  const optimisticTaskStatusesRef = useRef<Map<string, "starting" | "planning">>(new Map());

  const reconcileTasks = useCallback((
    nextTasks: Task[],
    options: { removeMissingOptimisticTasks?: boolean } = {},
  ): Task[] => {
    const returnedTaskIds = new Set<string>();
    const reconciledTasks = nextTasks.map((task) => {
      const taskId = task.config.id;
      returnedTaskIds.add(taskId);
      const optimisticStatus = optimisticTaskStatusesRef.current.get(taskId);
      if (!optimisticStatus) {
        return task;
      }

      if (task.state.status !== "draft") {
        optimisticTaskStatusesRef.current.delete(taskId);
        return task;
      }

      return {
        ...task,
        state: {
          ...task.state,
          status: optimisticStatus,
        },
      };
    });

    if (options.removeMissingOptimisticTasks ?? true) {
      for (const taskId of optimisticTaskStatusesRef.current.keys()) {
        if (!returnedTaskIds.has(taskId)) {
          optimisticTaskStatusesRef.current.delete(taskId);
        }
      }
    }

    return reconciledTasks;
  }, []);

  const refresh = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading ?? true;
    // Cancel any in-flight request
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      if (showLoading) {
        setLoading(true);
      }
      setError(null);
      const response = await appFetch("/api/tasks", { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        throw new Error(`Failed to fetch tasks: ${response.statusText}`);
      }
      const data = (await response.json()) as Task[];
      setTasks(reconcileTasks(data));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(String(err));
    } finally {
      if (!controller.signal.aborted && showLoading) {
        setLoading(false);
      }
    }
  }, [reconcileTasks]);

  const refreshTask = useCallback(async (id: string) => {
    try {
      const response = await appFetch("/api/tasks");
      if (!response.ok) {
        if (response.status === 404) {
          // Task was deleted
          optimisticTaskStatusesRef.current.delete(id);
          setTasks((prev) => prev.filter((task) => task.config.id !== id));
          return;
        }
        throw new Error(`Failed to fetch task: ${response.statusText}`);
      }
      const tasks = await response.json() as Task[];
      const task = tasks.find((item) => item.config.id === id);
      if (!task) {
        optimisticTaskStatusesRef.current.delete(id);
        setTasks((prev) => prev.filter((item) => item.config.id !== id));
        return;
      }
      const reconciledTask = reconcileTasks([task], {
        removeMissingOptimisticTasks: false,
      })[0] ?? task;
      setTasks((prev) => {
        const index = prev.findIndex((l) => l.config.id === id);
        if (index >= 0) {
          const newTasks = [...prev];
          newTasks[index] = reconciledTask;
          return newTasks;
        }
        return [...prev, reconciledTask];
      });
    } catch (err) {
      log.error("Failed to refresh task:", err);
    }
  }, [reconcileTasks]);

  const markTaskStarting = useCallback((id: string, status: "starting" | "planning") => {
    optimisticTaskStatusesRef.current.set(id, status);
    setTasks((prev) => prev.map((task) => (
      task.config.id === id
        ? {
            ...task,
            state: {
              ...task.state,
              status,
            },
          }
        : task
    )));
  }, []);

  const clearOptimisticTaskStart = useCallback((id: string) => {
    optimisticTaskStatusesRef.current.delete(id);
  }, []);

  const getTask = useCallback(
    (id: string): Task | undefined => {
      return tasks.find((task) => task.config.id === id);
    },
    [tasks]
  );

  // Initial fetch and cleanup
  useEffect(() => {
    refresh();
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [refresh]);

  return {
    tasks,
    loading,
    error,
    setTasks,
    setError,
    refresh,
    refreshTask,
    markTaskStarting,
    clearOptimisticTaskStart,
    getTask,
  };
}
