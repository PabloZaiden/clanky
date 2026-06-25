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

export function shouldRefreshTaskSnapshotForEvent(event: TaskEvent): boolean {
  switch (event.type) {
    case "task.created":
    case "task.deleted":
    case "task.log":
    case "task.message":
    case "task.progress":
    case "task.tool_call":
    case "task.tool_call.extra":
      return false;

    case "task.started":
    case "task.stopped":
    case "task.completed":
    case "task.ssh_handoff":
    case "task.session_aborted":
    case "task.merged":
    case "task.accepted":
    case "task.pushed":
    case "task.discarded":
    case "task.error":
    case "task.iteration.start":
    case "task.iteration.end":
    case "task.git.commit":
    case "task.sync.started":
    case "task.sync.clean":
    case "task.sync.conflicts":
    case "task.sync.failed":
    case "task.plan.accepted":
    case "task.plan.ready":
    case "task.plan.feedback":
    case "task.plan.discarded":
    case "task.pending.updated":
    case "task.automatic_pr_flow.updated":
      return true;
  }
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

      default:
        if (shouldRefreshTaskSnapshotForEvent(event)) {
          // Refresh the specific task summary to keep dashboard/sidebar state in sync.
          refreshTask(event.taskId);
        }
    }
  }

  const { status } = useAppEvents<TaskEvent>(handleEvent, isTaskEvent);

  useRefreshOnReconnect({
    status,
    onReconnect: refresh,
  });
}
