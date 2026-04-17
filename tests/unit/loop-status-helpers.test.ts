import { describe, expect, test } from "bun:test";
import {
  canAccept,
  canJumpstart,
  canManualComplete,
  canMarkMerged,
  canSendTerminalFollowUp,
  getRecentActivityTimestamp,
  getLoopStatusLabel,
  getPlanningStatusLabel,
  getStatusLabel,
  isArchivedLoop,
  isAwaitingFeedback,
  isFinalState,
  isLoopActive,
  isLoopPlanReady,
  isLoopRunning,
  isWorkspaceHistoryLoop,
  shouldShowInRecentActivity,
} from "../../src/utils/loop-status";
import type { Loop, LoopStatus } from "../../src/types/loop";

const ALL_STATUSES: LoopStatus[] = [
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
  "pushed",
  "deleted",
];

function createTestLoop(
  status: LoopStatus,
  isPlanReady?: boolean,
): Loop {
  return {
    config: {
      id: "test-loop-1",
      name: "Test Loop",
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
  } as Loop;
}

function expectStatuses(
  evaluate: (status: LoopStatus) => boolean,
  truthyStatuses: LoopStatus[],
) {
  const truthy = new Set(truthyStatuses);
  for (const status of ALL_STATUSES) {
    expect(evaluate(status)).toBe(truthy.has(status));
  }
}

describe("getStatusLabel", () => {
  test("returns the expected labels for known statuses", () => {
    const expectedLabels: Record<LoopStatus, string> = {
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
      pushed: "Pushed",
      deleted: "Deleted",
    };

    for (const status of ALL_STATUSES) {
      expect(getStatusLabel(status)).toBe(expectedLabels[status]);
    }
  });

  test("overrides active sync-conflict statuses to resolving conflicts", () => {
    for (const status of ["starting", "running", "waiting"] satisfies LoopStatus[]) {
      expect(getStatusLabel(status, { status: "conflicts" })).toBe("Resolving Conflicts");
    }
  });

  test("keeps non-active statuses and unknown values unchanged", () => {
    for (const status of ALL_STATUSES.filter((status) => !["starting", "running", "waiting"].includes(status))) {
      expect(getStatusLabel(status, { status: "conflicts" })).toBe(getStatusLabel(status));
    }
    expect(getStatusLabel("unknown_status" as LoopStatus)).toBe("unknown_status");
  });
});

describe("status action helpers", () => {
  test("exposes the expected accept, merge, final, active, running, and jumpstart states", () => {
    expectStatuses(canAccept, ["completed", "max_iterations"]);
    expectStatuses((status) => canManualComplete(status, true), ["stopped", "failed"]);
    expectStatuses((status) => canMarkMerged(status, true), ["completed", "max_iterations", "pushed"]);
    expectStatuses(isFinalState, ["merged", "pushed", "deleted"]);
    expectStatuses(isLoopActive, ["starting", "running", "waiting"]);
    expectStatuses(isLoopRunning, ["starting", "running"]);
    expectStatuses(canJumpstart, ["completed", "stopped", "failed", "max_iterations"]);
  });

  test("never exposes manual-complete when git metadata is missing", () => {
    expectStatuses((status) => canManualComplete(status, false), []);
  });

  test("never exposes mark-as-merged when git metadata is missing", () => {
    expectStatuses((status) => canMarkMerged(status, false), []);
  });

  test("shows active loops plus completed and pushed loops in recent activity", () => {
    expectStatuses(shouldShowInRecentActivity, [
      "idle",
      "draft",
      "planning",
      "starting",
      "running",
      "waiting",
      "resolving_conflicts",
      "completed",
      "pushed",
    ]);
  });

  test("only moves merged and deleted loops into workspace history", () => {
    expectStatuses(isWorkspaceHistoryLoop, ["merged", "deleted"]);
  });
});

describe("review-mode helpers", () => {
  test("only treats merged and pushed loops as awaiting feedback when explicitly addressable", () => {
    for (const status of ALL_STATUSES) {
      expect(isAwaitingFeedback(status, true)).toBe(status === "merged" || status === "pushed");
      expect(isAwaitingFeedback(status, false)).toBe(false);
      expect(isAwaitingFeedback(status, undefined)).toBe(false);
    }
  });

  test("only enables terminal follow-up for restartable, addressable, or deleted loops", () => {
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
      "merged",
      "pushed",
      "deleted",
    ]);
  });

  test("archives only deleted loops or merged/pushed loops that are no longer addressable", () => {
    expectStatuses((status) => isArchivedLoop(status, false), ["merged", "pushed", "deleted"]);
    expectStatuses((status) => isArchivedLoop(status, true), ["deleted"]);
  });
});

describe("planning helpers", () => {
  test("formats planning labels and plan-ready state consistently", () => {
    expect(getPlanningStatusLabel(false)).toBe("Planning");
    expect(getPlanningStatusLabel(true)).toBe("Plan Ready");
    expect(getLoopStatusLabel(createTestLoop("planning", false))).toBe("Planning");
    expect(getLoopStatusLabel(createTestLoop("planning", true))).toBe("Plan Ready");
    expect(getLoopStatusLabel(createTestLoop("running"))).toBe("Running");
  });

  test("marks only ready planning loops as plan ready", () => {
    expect(isLoopPlanReady(createTestLoop("planning", true))).toBe(true);
    expect(isLoopPlanReady(createTestLoop("planning", false))).toBe(false);

    for (const status of ALL_STATUSES.filter((loopStatus) => loopStatus !== "planning")) {
      expect(isLoopPlanReady(createTestLoop(status, true))).toBe(false);
    }
  });
});

describe("recent activity timestamps", () => {
  test("prefers last activity, then completion, then config update and creation time", () => {
    const baseLoop = createTestLoop("completed");

    expect(getRecentActivityTimestamp({
      ...baseLoop,
      state: {
        ...baseLoop.state,
        lastActivityAt: "2026-01-04T00:00:00.000Z",
        completedAt: "2026-01-03T00:00:00.000Z",
      },
      config: {
        ...baseLoop.config,
        updatedAt: "2026-01-02T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    })).toBe("2026-01-04T00:00:00.000Z");

    expect(getRecentActivityTimestamp({
      ...baseLoop,
      state: {
        ...baseLoop.state,
        lastActivityAt: undefined,
        completedAt: "2026-01-03T00:00:00.000Z",
      },
      config: {
        ...baseLoop.config,
        updatedAt: "2026-01-02T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    })).toBe("2026-01-03T00:00:00.000Z");

    expect(getRecentActivityTimestamp({
      ...baseLoop,
      state: {
        ...baseLoop.state,
        lastActivityAt: undefined,
        completedAt: undefined,
      },
      config: {
        ...baseLoop.config,
        updatedAt: "2026-01-02T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    })).toBe("2026-01-02T00:00:00.000Z");

    expect(getRecentActivityTimestamp({
      ...baseLoop,
      state: {
        ...baseLoop.state,
        lastActivityAt: undefined,
        completedAt: undefined,
      },
      config: {
        ...baseLoop.config,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    })).toBe("2026-01-01T00:00:00.000Z");
  });
});
