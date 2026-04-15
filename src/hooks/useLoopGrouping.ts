/**
 * Custom hook for grouping and sorting loops by status.
 * Provides memoized loop grouping logic for the Dashboard.
 */

import { useMemo } from "react";
import type { Loop, Workspace } from "../types";
import { isArchivedLoop, isAwaitingFeedback, isLoopPlanReady } from "../utils";

export interface StatusGroups {
  draft: Loop[];
  active: Loop[];
  needsReview: Loop[];
  planning: Loop[];
  completed: Loop[];
  awaitingFeedback: Loop[];
  archived: Loop[];
  other: Loop[];
}

export type StatusSectionKey = keyof StatusGroups;

export interface SectionConfig {
  key: StatusSectionKey;
  label: string;
  defaultCollapsed: boolean;
}

export interface WorkspaceGroup {
  workspace: Workspace;
  loops: Loop[];
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
 * Groups loops by status.
 * Pre-computes plan readiness once per loop to avoid duplicate calls to isLoopPlanReady
 * (which performs structured logging) across multiple filter passes.
 */
export function groupLoopsByStatus(loopsToGroup: Loop[]): StatusGroups {
  // Compute plan readiness once per loop to avoid duplicate trace log entries
  const planReadySet = new Set(
    loopsToGroup.filter((loop) => isLoopPlanReady(loop)).map((loop) => loop.config.id)
  );

  return {
    draft: loopsToGroup.filter((loop) => loop.state.status === "draft"),
    active: loopsToGroup.filter(
      (loop) =>
        loop.state.status === "running" ||
        loop.state.status === "waiting" ||
        loop.state.status === "starting"
    ),
    needsReview: loopsToGroup.filter((loop) => planReadySet.has(loop.config.id)),
    planning: loopsToGroup.filter(
      (loop) => loop.state.status === "planning" && !planReadySet.has(loop.config.id)
    ),
    completed: loopsToGroup.filter((loop) => loop.state.status === "completed"),
    awaitingFeedback: loopsToGroup.filter((loop) =>
      isAwaitingFeedback(loop.state.status, loop.state.reviewMode?.addressable)
    ),
    archived: loopsToGroup.filter((loop) => isArchivedLoop(loop.state.status, loop.state.reviewMode?.addressable)),
    other: loopsToGroup.filter(
      (loop) =>
        !["draft", "running", "waiting", "starting", "completed", "merged", "pushed", "deleted", "planning"].includes(
          loop.state.status
        )
    ),
  };
}

export interface UseLoopGroupingResult {
  workspaceGroups: WorkspaceGroup[];
  unassignedLoops: Loop[];
  unassignedStatusGroups: StatusGroups;
}

/**
 * Hook that memoizes loop grouping by workspace and status.
 */
export function useLoopGrouping(
  loops: Loop[],
  workspaces: Workspace[],
  workspacesLoaded = true,
): UseLoopGroupingResult {
  const workspaceIds = useMemo(() => new Set(workspaces.map((workspace) => workspace.id)), [workspaces]);

  const workspaceGroups = useMemo(() => {
    return workspaces
      .map((workspace, index) => {
        const workspaceLoops = loops.filter((loop) => loop.config.workspaceId === workspace.id);
        return {
          workspace,
          loops: workspaceLoops,
          statusGroups: groupLoopsByStatus(workspaceLoops),
          index,
        };
      })
      .sort((left, right) => {
        const loopCountDifference = right.loops.length - left.loops.length;
        if (loopCountDifference !== 0) {
          return loopCountDifference;
        }

        return left.index - right.index;
      })
      .map(({ workspace, loops: workspaceLoops, statusGroups }) => ({
        workspace,
        loops: workspaceLoops,
        statusGroups,
      }));
  }, [loops, workspaces]);

  const unassignedLoops = useMemo(() => {
    return loops.filter((loop) => {
      if (!loop.config.workspaceId) {
        return true;
      }
      return workspacesLoaded && !workspaceIds.has(loop.config.workspaceId);
    });
  }, [loops, workspaceIds, workspacesLoaded]);

  const unassignedStatusGroups = useMemo(() => {
    return groupLoopsByStatus(unassignedLoops);
  }, [unassignedLoops]);

  return {
    workspaceGroups,
    unassignedLoops,
    unassignedStatusGroups,
  };
}
