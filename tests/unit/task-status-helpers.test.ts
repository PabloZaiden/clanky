import { describe, expect, test } from "bun:test";
import {
  canAccept,
  canJumpstart,
  canManualComplete,
  canMarkMerged,
  canSendTerminalFollowUp,
  getRecentActivityTimestamp,
  getTaskStatusLabel,
  getTaskStatusPill,
  getTaskStatusPillFromState,
  getPlanningStatusLabel,
  getStatusLabel,
  isArchivedTask,
  isAwaitingFeedback,
  isFinalState,
  isTaskActive,
  isTaskPlanReady,
  isTaskRunning,
  isWorkspaceHistoryTask,
  shouldShowInRecentActivity,
} from "../../src/utils/task-status";
import type { Task, TaskStatus } from "../../src/types/task";

const ALL_STATUSES: TaskStatus[] = [
  "idle",
  "draft",
  "planning",
  "starting",
  "running",
  "waiting",
  "completed",
  "stopped",
  "failed",
  "max_iterations",
  "resolving_conflicts",
  "merged",
  "accepted_local",
  "pushed",
  "deleted",
];
const TEST_BASE_BRANCH = "default-base-branch";
const CONFLICT_SYNC_STATE = {
  status: "conflicts" as const,
  baseBranch: TEST_BASE_BRANCH,
  autoPushOnComplete: false,
};

function createTestTask(
  status: TaskStatus,
  isPlanReady?: boolean,
): Task {
  return {
    config: {
      id: "test-task-1",
      name: "Test Task",
      directory: "/workspaces/test",
      prompt: "Test prompt",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      workspaceId: "ws-1",
    },
    state: {
      status,
      planMode: status === "planning"
        ? {
            active: true,
            feedbackRounds: 0,
            planningFolderCleared: false,
            isPlanReady: isPlanReady ?? false,
          }
        : undefined,
    },
  } as Task;
}

function expectStatuses(
  evaluate: (status: TaskStatus) => boolean,
  truthyStatuses: TaskStatus[],
) {
  const truthy = new Set(truthyStatuses);
  for (const status of ALL_STATUSES) {
    expect(evaluate(status)).toBe(truthy.has(status));
  }
}

describe("getStatusLabel", () => {
  test("returns the expected labels for known statuses", () => {
    const expectedLabels: Record<TaskStatus, string> = {
      idle: "Idle",
      draft: "Draft",
      planning: "Planning",
      starting: "Starting",
      running: "Running",
      waiting: "Waiting",
      completed: "Completed",
      stopped: "Stopped",
      failed: "Failed",
      max_iterations: "Max Iterations",
      resolving_conflicts: "Resolving Conflicts",
      merged: "Merged",
      accepted_local: "Accepted Locally",
      pushed: "Pushed",
      deleted: "Deleted",
    };

    for (const status of ALL_STATUSES) {
      expect(getStatusLabel(status)).toBe(expectedLabels[status]);
    }
  });

  test("overrides active sync-conflict statuses to resolving conflicts", () => {
    for (const status of ["starting", "running", "waiting"] satisfies TaskStatus[]) {
      expect(getStatusLabel(status, CONFLICT_SYNC_STATE)).toBe("Resolving Conflicts");
    }
  });

  test("keeps non-active statuses and unknown values unchanged", () => {
    for (const status of ALL_STATUSES.filter((status) => !["starting", "running", "waiting"].includes(status))) {
      expect(getStatusLabel(status, CONFLICT_SYNC_STATE)).toBe(getStatusLabel(status));
    }
    expect(getStatusLabel("unknown_status" as TaskStatus)).toBe("unknown_status");
  });
});

describe("status action helpers", () => {
  test("exposes the expected accept, merge, final, active, running, and jumpstart states", () => {
    expectStatuses(canAccept, ["completed", "max_iterations"]);
    expectStatuses((status) => canManualComplete(status, true), ["stopped", "failed"]);
    expectStatuses((status) => canMarkMerged(status, true), ["pushed"]);
    expectStatuses(isFinalState, ["accepted_local", "merged", "pushed", "deleted"]);
    expectStatuses(isTaskActive, ["starting", "running", "waiting"]);
    expectStatuses(isTaskRunning, ["starting", "running"]);
    expectStatuses(canJumpstart, ["completed", "stopped", "failed", "max_iterations"]);
  });

  test("never exposes manual-complete when git metadata is missing", () => {
    expectStatuses((status) => canManualComplete(status, false), []);
  });

  test("never exposes mark-as-merged when git metadata is missing", () => {
    expectStatuses((status) => canMarkMerged(status, false), []);
  });

  test("shows active tasks plus completed and pushed tasks in recent activity", () => {
    expectStatuses(shouldShowInRecentActivity, [
      "idle",
      "draft",
      "planning",
      "starting",
      "running",
      "waiting",
      "resolving_conflicts",
      "completed",
      "accepted_local",
      "pushed",
    ]);
  });

  test("only moves merged and deleted tasks into workspace history", () => {
    expectStatuses(isWorkspaceHistoryTask, ["merged", "deleted"]);
  });
});

describe("review-mode helpers", () => {
  test("only treats accepted local and pushed tasks as awaiting feedback when explicitly addressable", () => {
    for (const status of ALL_STATUSES) {
      expect(isAwaitingFeedback(status, true)).toBe(status === "accepted_local" || status === "pushed");
      expect(isAwaitingFeedback(status, false)).toBe(false);
      expect(isAwaitingFeedback(status, undefined)).toBe(false);
    }
  });

  test("only enables terminal follow-up for restartable, addressable, or deleted tasks", () => {
    expectStatuses((status) => canSendTerminalFollowUp(status, false), [
      "completed",
      "stopped",
      "failed",
      "max_iterations",
      "deleted",
    ]);
    expectStatuses((status) => canSendTerminalFollowUp(status, true), [
      "completed",
      "stopped",
      "failed",
      "max_iterations",
      "accepted_local",
      "pushed",
      "deleted",
    ]);
  });

  test("archives only deleted tasks or final non-addressable tasks", () => {
    expectStatuses((status) => isArchivedTask(status, false), ["accepted_local", "merged", "pushed", "deleted"]);
    expectStatuses((status) => isArchivedTask(status, true), ["merged", "deleted"]);
  });
});

describe("planning helpers", () => {
  test("formats planning labels and plan-ready state consistently", () => {
    expect(getPlanningStatusLabel(false)).toBe("Planning");
    expect(getPlanningStatusLabel(true)).toBe("Plan Ready");
    expect(getTaskStatusLabel(createTestTask("planning", false))).toBe("Planning");
    expect(getTaskStatusLabel(createTestTask("planning", true))).toBe("Plan Ready");
    expect(getTaskStatusLabel(createTestTask("running"))).toBe("Running");
  });

  test("builds pill descriptors from a single shared mapping", () => {
    expect(getTaskStatusPill(createTestTask("planning", false))).toEqual({
      key: "planning",
      label: "Planning",
      variant: "planning",
    });
    expect(getTaskStatusPill(createTestTask("planning", true))).toEqual({
      key: "plan_ready",
      label: "Plan Ready",
      variant: "plan_ready",
    });
    expect(getTaskStatusPillFromState({
      status: "running",
      syncState: {
        status: "conflicts",
        baseBranch: TEST_BASE_BRANCH,
        autoPushOnComplete: false,
      },
      planMode: undefined,
    })).toEqual({
      key: "resolving_conflicts",
      label: "Resolving Conflicts",
      variant: "running",
    });
  });

  test("marks only ready planning tasks as plan ready", () => {
    expect(isTaskPlanReady(createTestTask("planning", true))).toBe(true);
    expect(isTaskPlanReady(createTestTask("planning", false))).toBe(false);

    for (const status of ALL_STATUSES.filter((taskStatus) => taskStatus !== "planning")) {
      expect(isTaskPlanReady(createTestTask(status, true))).toBe(false);
    }
  });
});

describe("recent activity timestamps", () => {
  test("prefers last activity, then completion, then config update and creation time", () => {
    const baseTask = createTestTask("completed");

    expect(getRecentActivityTimestamp({
      ...baseTask,
      state: {
        ...baseTask.state,
        lastActivityAt: "2026-01-04T00:00:00.000Z",
        completedAt: "2026-01-03T00:00:00.000Z",
      },
      config: {
        ...baseTask.config,
        updatedAt: "2026-01-02T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    })).toBe("2026-01-04T00:00:00.000Z");

    expect(getRecentActivityTimestamp({
      ...baseTask,
      state: {
        ...baseTask.state,
        lastActivityAt: undefined,
        completedAt: "2026-01-03T00:00:00.000Z",
      },
      config: {
        ...baseTask.config,
        updatedAt: "2026-01-02T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    })).toBe("2026-01-03T00:00:00.000Z");

    expect(getRecentActivityTimestamp({
      ...baseTask,
      state: {
        ...baseTask.state,
        lastActivityAt: undefined,
        completedAt: undefined,
      },
      config: {
        ...baseTask.config,
        updatedAt: "2026-01-02T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    })).toBe("2026-01-02T00:00:00.000Z");

    expect(getRecentActivityTimestamp({
      ...baseTask,
      state: {
        ...baseTask.state,
        lastActivityAt: undefined,
        completedAt: undefined,
      },
      config: {
        ...baseTask.config,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    })).toBe("2026-01-01T00:00:00.000Z");
  });
});
