/**
 * Tests for useTasks hook.
 *
 * Tests CRUD operations, WebSocket event handling, error states,
 * and delegated actions (accept, push, discard, delete, purge, addressComments).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createMockApi, MockApiError } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { createTask, createTaskWithStatus } from "../helpers/factories";
import { AppEventsProvider } from "@/hooks";
import { useTasks } from "@/hooks/useTasks";
import { DEFAULT_TASK_CONFIG, type Task } from "@/types/task";
import type { PurgeArchivedTasksResult } from "@/hooks";

const api = createMockApi();
const ws = createMockWebSocket();
const createTaskRequestBase = {
  attachments: [],
  cheapModel: { mode: "same-as-task" as const },
  maxIterations: null,
  maxConsecutiveErrors: DEFAULT_TASK_CONFIG.maxConsecutiveErrors,
  activityTimeoutSeconds: DEFAULT_TASK_CONFIG.activityTimeoutSeconds,
  stopPattern: DEFAULT_TASK_CONFIG.stopPattern,
  git: {
    branchPrefix: DEFAULT_TASK_CONFIG.git.branchPrefix,
    commitScope: DEFAULT_TASK_CONFIG.git.commitScope,
  },
  baseBranch: "",
  clearPlanningFolder: false,
  autoAcceptPlan: false,
  fullyAutonomous: false,
  draft: false,
};

beforeEach(() => {
  api.reset();
  api.install();
  ws.reset();
  ws.install();
});

afterEach(() => {
  api.uninstall();
  ws.uninstall();
});

/** Default task list for initial fetch. */
function setupTasksList(tasks: Task[] = []) {
  api.get("/api/tasks", () => tasks);
}

// ─── Initial fetch ───────────────────────────────────────────────────────────

describe("initial fetch", () => {
  test("fetches tasks on mount and sets loading to false", async () => {
    const task = createTask();
    setupTasksList([task]);

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0]!.config.id).toBe(task.config.id);
    expect(result.current.error).toBeNull();
  });

  test("sets error when initial fetch fails", async () => {
    api.get("/api/tasks", () => {
      throw new MockApiError(500, { message: "Server error" });
    });

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.tasks).toEqual([]);
  });

  test("returns empty array when no tasks exist", async () => {
    setupTasksList([]);

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.tasks).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

// ─── WebSocket events ────────────────────────────────────────────────────────

describe("WebSocket events", () => {
  test("task.created triggers a full refresh", async () => {
    const task1 = createTask({ config: { id: "task-1" } });
    const task2 = createTask({ config: { id: "task-2" } });

    let callCount = 0;
    api.get("/api/tasks", () => {
      callCount++;
      return callCount === 1 ? [task1] : [task1, task2];
    });

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.tasks).toHaveLength(1);

    // Wait for WebSocket to be connected
    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    // Send task.created event
    act(() => {
      ws.sendEvent({
        type: "task.created",
        taskId: "task-2",
        config: task2.config,
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(2);
    });
  });

  test("task.deleted removes task from state", async () => {
    const task1 = createTask({ config: { id: "task-1" }, state: { id: "task-1" } });
    const task2 = createTask({ config: { id: "task-2" }, state: { id: "task-2" } });
    setupTasksList([task1, task2]);

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(2);
    });

    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    act(() => {
      ws.sendEvent({
        type: "task.deleted",
        taskId: "task-1",
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0]!.config.id).toBe("task-2");
    });
  });

  test("task.merged triggers a single-task refresh", async () => {
    const task = createTask({ config: { id: "task-1" }, state: { id: "task-1", status: "pushed" } });
    const mergedTask = createTask({ config: { id: "task-1" }, state: { id: "task-1", status: "merged" } });
    setupTasksList([task]);
    api.get("/api/tasks/:id", () => mergedTask);

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    act(() => {
      ws.sendEvent({
        type: "task.merged",
        taskId: "task-1",
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.tasks[0]!.state.status).toBe("merged");
    });
  });

  test("task.completed triggers a single-task refresh", async () => {
    const task = createTask({ config: { id: "task-1" }, state: { id: "task-1", status: "running" } });
    const completedTask = createTask({ config: { id: "task-1" }, state: { id: "task-1", status: "completed" } });
    setupTasksList([task]);

    // Mock for single-task refresh
    api.get("/api/tasks/:id", () => completedTask);

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    act(() => {
      ws.sendEvent({
        type: "task.completed",
        taskId: "task-1",
        totalIterations: 3,
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.tasks[0]!.state.status).toBe("completed");
    });
  });

  test("task.automatic_pr_flow.updated triggers a single-task refresh", async () => {
    const initialTask = createTaskWithStatus("pushed", {
      config: { id: "task-1" },
      state: {
        id: "task-1",
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
        },
      },
    });
    const updatedTask = createTaskWithStatus("pushed", {
      config: { id: "task-1" },
      state: {
        id: "task-1",
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
        },
        automaticPrFlow: {
          enabled: true,
          status: "monitoring",
          startedAt: "2026-04-11T04:00:00.000Z",
          updatedAt: "2026-04-11T04:00:00.000Z",
          lastCheckedAt: "2026-04-11T04:00:00.000Z",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.com/example/repo/pull/42",
          handledItems: [],
        },
      },
    });
    setupTasksList([initialTask]);
    api.get("/api/tasks/:id", () => updatedTask);

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    act(() => {
      ws.sendEvent({
        type: "task.automatic_pr_flow.updated",
        taskId: "task-1",
        automaticPrFlow: updatedTask.state.automaticPrFlow,
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.tasks[0]!.state.automaticPrFlow?.enabled).toBe(true);
    });
  });

  test("re-syncs the task list after websocket reconnect", async () => {
    const initialTask = createTask({ config: { id: "task-1" }, state: { id: "task-1", status: "running" } });
    const recoveredTask = createTask({ config: { id: "task-1" }, state: { id: "task-1", status: "completed" } });

    let callCount = 0;
    api.get("/api/tasks", () => {
      callCount++;
      return callCount === 1 ? [initialTask] : [recoveredTask];
    });

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    expect(result.current.tasks[0]!.state.status).toBe("running");
    expect(callCount).toBe(1);

    const initialConnection = ws.connections()[0]!;
    await act(async () => {
      initialConnection.instance.close(1006, "network lost");
    });

    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(1);
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(result.current.tasks[0]!.state.status).toBe("completed");
    });

    expect(callCount).toBe(2);
  });
});

// ─── createTask ──────────────────────────────────────────────────────────────

describe("createTask", () => {
  test("sends POST request and returns created task", async () => {
    setupTasksList([]);
    const newTask = createTask({ config: { id: "new-task" } });
    api.post("/api/tasks", () => newTask);

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let createResult: { task: Task | null } = { task: null };
    await act(async () => {
      createResult = await result.current.createTask({
        ...createTaskRequestBase,
        name: "Do something",
        prompt: "Do something",
        workspaceId: "ws-1",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", variant: "" },
        useWorktree: true,
        planMode: false,
      });
    });

    expect(createResult.task).not.toBeNull();
    expect(createResult.task!.config.id).toBe("new-task");
    const postCalls = api.calls("/api/tasks", "POST");
    expect(postCalls).toHaveLength(1);
      expect(postCalls[0]!.body).toEqual({
        ...createTaskRequestBase,
        name: "Do something",
        prompt: "Do something",
        workspaceId: "ws-1",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", variant: "" },
        useWorktree: true,
        planMode: false,
      });
  });

  test("returns startError on 409 uncommitted changes", async () => {
    setupTasksList([]);
    api.post("/api/tasks", () => {
      throw new MockApiError(409, {
        error: "uncommitted_changes",
        message: "Directory has uncommitted changes",
        changedFiles: ["file1.ts", "file2.ts"],
      });
    });

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let createResult: { task: Task | null; startError?: unknown } = { task: null };
    await act(async () => {
      createResult = await result.current.createTask({
        ...createTaskRequestBase,
        name: "Do something",
        prompt: "Do something",
        workspaceId: "ws-1",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", variant: "" },
        useWorktree: true,
        planMode: false,
      });
    });

    expect(createResult.task).toBeNull();
    expect(createResult.startError).toBeDefined();
    expect((createResult.startError as { error: string }).error).toBe("uncommitted_changes");
  });

  test("sets error and returns null task on other failures", async () => {
    setupTasksList([]);
    api.post("/api/tasks", () => {
      throw new MockApiError(400, { message: "Invalid model" });
    });

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let createResult: { task: Task | null } = { task: null };
    await act(async () => {
      createResult = await result.current.createTask({
        ...createTaskRequestBase,
        name: "Do something",
        prompt: "Do something",
        workspaceId: "ws-1",
        model: { providerID: "bad", modelID: "bad", variant: "" },
        useWorktree: true,
        planMode: false,
      });
    });

    expect(createResult.task).toBeNull();
    expect(result.current.error).toBeTruthy();
  });
});

// ─── updateTask ──────────────────────────────────────────────────────────────

describe("updateTask", () => {
  test("sends PATCH request and updates task in state", async () => {
    const task = createTask({ config: { id: "task-1", prompt: "Old prompt" }, state: { id: "task-1" } });
    setupTasksList([task]);

    const updatedTask = createTask({ config: { id: "task-1", prompt: "New prompt" }, state: { id: "task-1" } });
    api.patch("/api/tasks/:id", () => updatedTask);

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    let updated: Task | null = null;
    await act(async () => {
      updated = await result.current.updateTask("task-1", { prompt: "New prompt" });
    });

    expect(updated).not.toBeNull();
    expect(updated!.config.id).toBe("task-1");
    expect(updated!.config.prompt).toBe("New prompt");
    expect(result.current.tasks[0]!.config.prompt).toBe("New prompt");
  });

  test("sets error and returns null on failure", async () => {
    setupTasksList([]);
    api.patch("/api/tasks/:id", () => {
      throw new MockApiError(404, { message: "Task not found" });
    });

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let updated: Task | null = null;
    await act(async () => {
      updated = await result.current.updateTask("nonexistent", { prompt: "test" });
    });

    expect(updated).toBeNull();
    expect(result.current.error).toBeTruthy();
  });
});

// ─── deleteTask ──────────────────────────────────────────────────────────────

describe("deleteTask", () => {
  test("calls deleteTaskApi and returns true on success", async () => {
    const task = createTask({ config: { id: "task-1" }, state: { id: "task-1" } });
    setupTasksList([task]);
    api.delete("/api/tasks/:id", () => ({ success: true }));

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    let deleted = false;
    await act(async () => {
      deleted = await result.current.deleteTask("task-1");
    });

    expect(deleted).toBe(true);
  });

  test("sets error and returns false on failure", async () => {
    setupTasksList([]);
    api.delete("/api/tasks/:id", () => {
      throw new MockApiError(500, { message: "Delete failed" });
    });

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let deleted = false;
    await act(async () => {
      deleted = await result.current.deleteTask("task-1");
    });

    expect(deleted).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
});

// ─── acceptTask ──────────────────────────────────────────────────────────────

describe("acceptTask", () => {
  test("calls acceptTaskApi and refreshes the task", async () => {
    const task = createTaskWithStatus("completed", { config: { id: "task-1" }, state: { id: "task-1" } });
    const acceptedTask = createTaskWithStatus("accepted_local", { config: { id: "task-1" }, state: { id: "task-1" } });
    setupTasksList([task]);

    api.post("/api/tasks/:id/accept", () => ({
      success: true,
    }));
    api.get("/api/tasks/:id", () => acceptedTask);

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    let acceptResult: { success: boolean } = { success: false };
    await act(async () => {
      acceptResult = await result.current.acceptTask("task-1");
    });

    expect(acceptResult.success).toBe(true);
  });

  test("returns success: false on error", async () => {
    setupTasksList([]);
    api.post("/api/tasks/:id/accept", () => {
      throw new MockApiError(500, { message: "Merge conflict" });
    });

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let acceptResult = { success: false };
    await act(async () => {
      acceptResult = await result.current.acceptTask("task-1");
    });

    expect(acceptResult.success).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
});

// ─── pushTask ────────────────────────────────────────────────────────────────

describe("pushTask", () => {
  test("calls pushTaskApi and refreshes the task", async () => {
    const task = createTaskWithStatus("completed", { config: { id: "task-1" }, state: { id: "task-1" } });
    const pushedTask = createTaskWithStatus("pushed", { config: { id: "task-1" }, state: { id: "task-1" } });
    setupTasksList([task]);

    api.post("/api/tasks/:id/push", () => ({
      success: true,
      remoteBranch: "feature-a1b2c3d",
    }));
    api.get("/api/tasks/:id", () => pushedTask);

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    let pushResult: { success: boolean; remoteBranch?: string } = { success: false };
    await act(async () => {
      pushResult = await result.current.pushTask("task-1");
    });

    expect(pushResult.success).toBe(true);
    expect(pushResult.remoteBranch).toBe("feature-a1b2c3d");
  });
});

// ─── discardTask ─────────────────────────────────────────────────────────────

describe("discardTask", () => {
  test("calls discardTaskApi and refreshes the task", async () => {
    const task = createTaskWithStatus("completed", { config: { id: "task-1" }, state: { id: "task-1" } });
    const deletedTask = createTaskWithStatus("deleted", { config: { id: "task-1" }, state: { id: "task-1" } });
    setupTasksList([task]);

    api.post("/api/tasks/:id/discard", () => ({ success: true }));
    api.get("/api/tasks/:id", () => deletedTask);

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    let discarded = false;
    await act(async () => {
      discarded = await result.current.discardTask("task-1");
    });

    expect(discarded).toBe(true);
  });
});

// ─── purgeTask ───────────────────────────────────────────────────────────────

describe("purgeTask", () => {
  test("calls purgeTaskApi and removes task from state", async () => {
    const task = createTaskWithStatus("deleted", { config: { id: "task-1" }, state: { id: "task-1" } });
    setupTasksList([task]);

    api.post("/api/tasks/:id/purge", () => ({ success: true }));

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    let purged = false;
    await act(async () => {
      purged = await result.current.purgeTask("task-1");
    });

    expect(purged).toBe(true);
    expect(result.current.tasks).toHaveLength(0);
  });

  test("sets error and returns false on failure", async () => {
    setupTasksList([]);
    api.post("/api/tasks/:id/purge", () => {
      throw new MockApiError(500, { message: "Purge failed" });
    });

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let purged = false;
    await act(async () => {
      purged = await result.current.purgeTask("task-1");
    });

    expect(purged).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
});

describe("purgeArchivedWorkspaceTasks", () => {
  test("removes all purged archived tasks from state", async () => {
    const archivedTask1 = createTaskWithStatus("deleted", {
      config: { id: "task-1", workspaceId: "ws-1" },
      state: { id: "task-1" },
    });
    const archivedTask2 = createTaskWithStatus("merged", {
      config: { id: "task-2", workspaceId: "ws-1" },
      state: { id: "task-2" },
    });
    const remainingTask = createTaskWithStatus("running", {
      config: { id: "task-3", workspaceId: "ws-1" },
      state: { id: "task-3" },
    });
    setupTasksList([archivedTask1, archivedTask2, remainingTask]);

    api.post("/api/workspaces/:id/archived-tasks/purge", () => ({
      success: true,
      workspaceId: "ws-1",
      totalArchived: 2,
      purgedCount: 2,
      purgedTaskIds: ["task-1", "task-2"],
      failures: [],
    }));

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(3);
    });

    let purgeResult: PurgeArchivedTasksResult = {
      success: false,
      workspaceId: "",
      totalArchived: 0,
      purgedCount: 0,
      purgedTaskIds: [],
      failures: [],
    };
    await act(async () => {
      purgeResult = await result.current.purgeArchivedWorkspaceTasks("ws-1");
    });

    expect(purgeResult.success).toBe(true);
    expect(purgeResult.purgedTaskIds).toEqual(["task-1", "task-2"]);
    expect(result.current.tasks.map((task) => task.config.id)).toEqual(["task-3"]);
  });

  test("sets error and returns failure result when bulk purge fails", async () => {
    setupTasksList([]);
    api.post("/api/workspaces/:id/archived-tasks/purge", () => {
      throw new MockApiError(500, { message: "Bulk purge failed" });
    });

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let purgeResult: PurgeArchivedTasksResult = {
      success: true,
      workspaceId: "ws-1",
      totalArchived: 1,
      purgedCount: 1,
      purgedTaskIds: ["task-1"],
      failures: [],
    };
    await act(async () => {
      purgeResult = await result.current.purgeArchivedWorkspaceTasks("ws-1");
    });

    expect(purgeResult.success).toBe(false);
    expect(purgeResult.workspaceId).toBe("ws-1");
    expect(result.current.error).toContain("Bulk purge failed");
  });
});

// ─── addressReviewComments ───────────────────────────────────────────────────

describe("addressReviewComments", () => {
  test("calls addressReviewCommentsApi and refreshes the task", async () => {
    const task = createTaskWithStatus("pushed", { config: { id: "task-1" }, state: { id: "task-1" } });
    const runningTask = createTaskWithStatus("running", { config: { id: "task-1" }, state: { id: "task-1" } });
    setupTasksList([task]);

    api.post("/api/tasks/:id/address-comments", () => ({
      success: true,
      reviewCycle: 1,
      branch: "task-1-a1b2c3d-review-1",
    }));
    api.get("/api/tasks/:id", () => runningTask);

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    let addressResult: { success: boolean; reviewCycle?: number } = { success: false };
    await act(async () => {
      addressResult = await result.current.addressReviewComments("task-1", "Fix the typo");
    });

    expect(addressResult.success).toBe(true);
    expect(addressResult.reviewCycle).toBe(1);
  });

  test("returns success: false on error", async () => {
    setupTasksList([]);
    api.post("/api/tasks/:id/address-comments", () => {
      throw new MockApiError(400, { message: "Not addressable" });
    });

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let addressResult = { success: false };
    await act(async () => {
      addressResult = await result.current.addressReviewComments("task-1", "comments");
    });

    expect(addressResult.success).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
});

// ─── getTask ─────────────────────────────────────────────────────────────────

describe("getTask", () => {
  test("finds a task by ID", async () => {
    const task1 = createTask({ config: { id: "task-1" }, state: { id: "task-1" } });
    const task2 = createTask({ config: { id: "task-2" }, state: { id: "task-2" } });
    setupTasksList([task1, task2]);

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(2);
    });

    expect(result.current.getTask("task-1")?.config.id).toBe("task-1");
    expect(result.current.getTask("task-2")?.config.id).toBe("task-2");
    expect(result.current.getTask("nonexistent")).toBeUndefined();
  });
});

// ─── refresh ─────────────────────────────────────────────────────────────────

describe("refresh", () => {
  test("re-fetches tasks list", async () => {
    const task1 = createTask({ config: { id: "task-1" } });
    const task2 = createTask({ config: { id: "task-2" } });

    let callCount = 0;
    api.get("/api/tasks", () => {
      callCount++;
      return callCount === 1 ? [task1] : [task1, task2];
    });

    const { result } = renderHook(() => useTasks(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.tasks).toHaveLength(2);
  });
});
