/**
 * Custom hook for grouping and sorting tasks by status.
 * Provides memoized task grouping logic for the Dashboard.
 */

import { useMemo } from "react";
import type { Task, Workspace } from "../types";
import { isArchivedTask, isAwaitingFeedback, isTaskPlanReady } from "../utils";

export interface StatusGroups {
  draft: Task[];
  active: Task[];
  needsReview: Task[];
  planning: Task[];
  completed: Task[];
  awaitingFeedback: Task[];
  archived: Task[];
  other: Task[];
}

export type StatusSectionKey = keyof StatusGroups;

export interface SectionConfig {
  key: StatusSectionKey;
  label: string;
  defaultCollapsed: boolean;
}

export interface WorkspaceGroup {
  workspace: Workspace;
  tasks: Task[];
  statusGroups: StatusGroups;
}

/** Section configuration: defines order, labels, and default collapsed state */
export const sectionConfig: SectionConfig[] = [
  { key: "active", label: "Active", defaultCollapsed: false },
  { key: "needsReview", label: "Needs Review", defaultCollapsed: false },
  { key: "planning", label: "Planning", defaultCollapsed: false },
  { key: "completed", label: "Completed", defaultCollapsed: false },
  { key: "awaitingFeedback", label: "Awaiting Feedback", defaultCollapsed: false },
  { key: "other", label: "Other", defaultCollapsed: false },
  { key: "draft", label: "Drafts", defaultCollapsed: false },
  { key: "archived", label: "Archived", defaultCollapsed: true },
];

/**
 * Groups tasks by status.
 * Pre-computes plan readiness once per task to avoid duplicate calls to isTaskPlanReady
 * (which performs structured logging) across multiple filter passes.
 */
export function groupTasksByStatus(tasksToGroup: Task[]): StatusGroups {
  // Compute plan readiness once per task to avoid duplicate trace log entries
  const planReadySet = new Set(
    tasksToGroup.filter((task) => isTaskPlanReady(task)).map((task) => task.config.id)
  );

  return {
    draft: tasksToGroup.filter((task) => task.state.status === "draft"),
    active: tasksToGroup.filter(
      (task) =>
        task.state.status === "running" ||
        task.state.status === "waiting" ||
        task.state.status === "starting"
    ),
    needsReview: tasksToGroup.filter((task) => planReadySet.has(task.config.id)),
    planning: tasksToGroup.filter(
      (task) => task.state.status === "planning" && !planReadySet.has(task.config.id)
    ),
    completed: tasksToGroup.filter((task) => task.state.status === "completed"),
    awaitingFeedback: tasksToGroup.filter((task) =>
      isAwaitingFeedback(task.state.status, task.state.reviewMode?.addressable)
    ),
    archived: tasksToGroup.filter((task) => isArchivedTask(task.state.status, task.state.reviewMode?.addressable)),
    other: tasksToGroup.filter(
      (task) =>
        !["draft", "running", "waiting", "starting", "completed", "accepted_local", "merged", "pushed", "deleted", "planning"].includes(
          task.state.status
        )
    ),
  };
}

export interface UseTaskGroupingResult {
  workspaceGroups: WorkspaceGroup[];
  unassignedTasks: Task[];
  unassignedStatusGroups: StatusGroups;
}

/**
 * Hook that memoizes task grouping by workspace and status.
 */
export function useTaskGrouping(
  tasks: Task[],
  workspaces: Workspace[],
  workspacesLoaded = true,
): UseTaskGroupingResult {
  const workspaceIds = useMemo(() => new Set(workspaces.map((workspace) => workspace.id)), [workspaces]);

  const workspaceGroups = useMemo(() => {
    return workspaces
      .map((workspace, index) => {
        const workspaceTasks = tasks.filter((task) => task.config.workspaceId === workspace.id);
        return {
          workspace,
          tasks: workspaceTasks,
          statusGroups: groupTasksByStatus(workspaceTasks),
          index,
        };
      })
      .sort((left, right) => {
        const taskCountDifference = right.tasks.length - left.tasks.length;
        if (taskCountDifference !== 0) {
          return taskCountDifference;
        }

        return left.index - right.index;
      })
      .map(({ workspace, tasks: workspaceTasks, statusGroups }) => ({
        workspace,
        tasks: workspaceTasks,
        statusGroups,
      }));
  }, [tasks, workspaces]);

  const unassignedTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (!task.config.workspaceId) {
        return true;
      }
      return workspacesLoaded && !workspaceIds.has(task.config.workspaceId);
    });
  }, [tasks, workspaceIds, workspacesLoaded]);

  const unassignedStatusGroups = useMemo(() => {
    return groupTasksByStatus(unassignedTasks);
  }, [unassignedTasks]);

  return {
    workspaceGroups,
    unassignedTasks,
    unassignedStatusGroups,
  };
}
