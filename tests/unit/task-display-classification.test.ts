import { describe, expect, test } from "bun:test";
import type { Task, TaskStatus, Workspace } from "@/shared";
import { createInitialState } from "@/shared";
import { buildWorkspaceSidebarGroups } from "../../src/components/app-shell/shell-types";
import { groupTasksByStatus } from "../../src/hooks/useTaskGrouping";
import {
  isSidebarHistoryTask,
  isTaskActive,
  isTaskInActiveSection,
} from "../../src/utils";

function task(id: string, status: TaskStatus, workspaceId = "workspace-1"): Task {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    config: {
      id,
      name: id,
      directory: `/tmp/${workspaceId}`,
      prompt: "test",
      createdAt: now,
      updatedAt: now,
      workspaceId,
      model: {
        providerID: "test",
        modelID: "test",
        variant: "",
      },
      maxIterations: 1,
      maxConsecutiveErrors: 1,
      activityTimeoutSeconds: null,
      stopPattern: "",
      git: {
        branchPrefix: "",
        commitScope: "",
      },
      useWorktree: true,
      clearPlanningFolder: false,
      planMode: false,
      mode: "task",
    },
    state: {
      ...createInitialState(id),
      status,
    },
  };
}

function workspace(): Workspace {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "workspace-1",
    name: "Test workspace",
    directory: "/tmp/workspace-1",
    workspaceType: "git",
    executionTargetRevision: 1,
    executionHostBinding: {
      host: { kind: "local", nodeId: "test-local-node" },
      targetKey: "local:test",
      revision: 1,
    },
    serverSettings: {
      agent: {
        provider: "opencode",
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe("task display classification", () => {
  test("keeps stopped tasks visible as active without treating them as running", () => {
    expect(isTaskInActiveSection("stopped")).toBe(true);
    expect(isTaskActive("stopped")).toBe(false);
    expect(isSidebarHistoryTask("stopped")).toBe(false);
  });

  test("preserves sidebar history statuses", () => {
    for (const status of ["failed", "max_iterations", "accepted_local", "merged", "deleted"] as const) {
      expect(isSidebarHistoryTask(status)).toBe(true);
    }

    expect(isSidebarHistoryTask("completed")).toBe(false);
    expect(isSidebarHistoryTask("pushed")).toBe(false);
  });

  test("groups stopped tasks in the dashboard Active section", () => {
    const groups = groupTasksByStatus([
      task("stopped-task", "stopped"),
      task("running-task", "running"),
      task("failed-task", "failed"),
    ]);

    expect(groups.active.map((item) => item.config.id)).toEqual([
      "stopped-task",
      "running-task",
    ]);
    expect(groups.other.map((item) => item.config.id)).toEqual(["failed-task"]);
  });

  test("keeps stopped tasks in sidebar tasks and merged tasks in sidebar history", () => {
    const groups = buildWorkspaceSidebarGroups({
      workspaces: [workspace()],
      tasks: [
        task("stopped-task", "stopped"),
        task("merged-task", "merged"),
      ],
      chats: [],
    });
    const workspaceNode = groups[0]!.workspaces[0]!;

    expect(workspaceNode.tasks.map((item) => item.task.config.id)).toEqual(["stopped-task"]);
    expect(workspaceNode.historyTasks.map((item) => item.task.config.id)).toEqual(["merged-task"]);
    expect(workspaceNode.hasActivity).toBe(true);
  });
});
