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
  getTask: (id: string) => Task | undefined;
}

export function useTasksState(): UseTasksStateResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // AbortController for cancelling in-flight fetch requests on unmount
  const abortControllerRef = useRef<AbortController | null>(null);

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
      setTasks(data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(String(err));
    } finally {
      if (!controller.signal.aborted && showLoading) {
        setLoading(false);
      }
    }
  }, []);

  const refreshTask = useCallback(async (id: string) => {
    try {
      const response = await appFetch(`/api/tasks/${id}/snapshot?limit=1`);
      if (!response.ok) {
        if (response.status === 404) {
          // Task was deleted
          setTasks((prev) => prev.filter((task) => task.config.id !== id));
          return;
        }
        throw new Error(`Failed to fetch task: ${response.statusText}`);
      }
      const snapshot = (await response.json()) as { task: Task };
      const task = snapshot.task;
      setTasks((prev) => {
        const index = prev.findIndex((l) => l.config.id === id);
        if (index >= 0) {
          const newTasks = [...prev];
          newTasks[index] = task;
          return newTasks;
        }
        return [...prev, task];
      });
    } catch (err) {
      log.error("Failed to refresh task:", err);
    }
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

  return { tasks, loading, error, setTasks, setError, refresh, refreshTask, getTask };
}
