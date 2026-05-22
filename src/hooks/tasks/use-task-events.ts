/**
 * WebSocket event handling for real-time task state updates.
 */

import type { Task, TaskEvent } from "../../types";
import { isTaskEvent, useAppEvents } from "../useAppEvents";
import { useRefreshOnReconnect } from "../useRefreshOnReconnect";

interface UseTaskEventsOptions {
  refresh: () => Promise<void>;
  refreshTask: (id: string) => Promise<void>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
}

export function useTaskEvents({ refresh, refreshTask, setTasks }: UseTaskEventsOptions): void {
  function handleEvent(event: TaskEvent) {
    switch (event.type) {
      case "task.created":
        // Refresh to get the full task data
        refresh();
        break;

      case "task.deleted":
        setTasks((prev) => prev.filter((task) => task.config.id !== event.taskId));
        break;

      case "task.started":
      case "task.stopped":
      case "task.completed":
      case "task.ssh_handoff":
      case "task.merged":
      case "task.accepted":
      case "task.pushed":
      case "task.discarded":
      case "task.error":
      case "task.iteration.start":
      case "task.iteration.end":
      case "task.plan.accepted":
      case "task.plan.ready":
      case "task.plan.feedback":
      case "task.plan.discarded":
      case "task.automatic_pr_flow.updated":
        // Refresh the specific task to get updated state
        refreshTask(event.taskId);
        break;
    }
  }

  const { status } = useAppEvents<TaskEvent>(handleEvent, isTaskEvent);

  useRefreshOnReconnect({
    status,
    onReconnect: refresh,
  });
}
