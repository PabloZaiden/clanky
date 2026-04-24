/**
 * Tests for useLoops hook.
 *
 * Tests CRUD operations, WebSocket event handling, error states,
 * and delegated actions (accept, push, discard, delete, purge, addressComments).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createMockApi, MockApiError } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { createLoop, createLoopWithStatus } from "../helpers/factories";
import { useLoops } from "@/hooks/useLoops";
import { DEFAULT_LOOP_CONFIG, type Loop } from "@/types/loop";
import type { PurgeArchivedLoopsResult } from "@/hooks";

const api = createMockApi();
const ws = createMockWebSocket();
const createLoopRequestBase = {
  attachments: [],
  cheapModel: { mode: "same-as-loop" as const },
  maxIterations: null,
  maxConsecutiveErrors: DEFAULT_LOOP_CONFIG.maxConsecutiveErrors,
  activityTimeoutSeconds: DEFAULT_LOOP_CONFIG.activityTimeoutSeconds,
  stopPattern: DEFAULT_LOOP_CONFIG.stopPattern,
  git: {
    branchPrefix: DEFAULT_LOOP_CONFIG.git.branchPrefix,
    commitScope: DEFAULT_LOOP_CONFIG.git.commitScope,
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

/** Default loop list for initial fetch. */
function setupLoopsList(loops: Loop[] = []) {
  api.get("/api/loops", () => loops);
}

// ─── Initial fetch ───────────────────────────────────────────────────────────

describe("initial fetch", () => {
  test("fetches loops on mount and sets loading to false", async () => {
    const loop = createLoop();
    setupLoopsList([loop]);

    const { result } = renderHook(() => useLoops());

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.loops).toHaveLength(1);
    expect(result.current.loops[0]!.config.id).toBe(loop.config.id);
    expect(result.current.error).toBeNull();
  });

  test("sets error when initial fetch fails", async () => {
    api.get("/api/loops", () => {
      throw new MockApiError(500, { message: "Server error" });
    });

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.loops).toEqual([]);
  });

  test("returns empty array when no loops exist", async () => {
    setupLoopsList([]);

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.loops).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

// ─── WebSocket events ────────────────────────────────────────────────────────

describe("WebSocket events", () => {
  test("loop.created triggers a full refresh", async () => {
    const loop1 = createLoop({ config: { id: "loop-1" } });
    const loop2 = createLoop({ config: { id: "loop-2" } });

    let callCount = 0;
    api.get("/api/loops", () => {
      callCount++;
      return callCount === 1 ? [loop1] : [loop1, loop2];
    });

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.loops).toHaveLength(1);

    // Wait for WebSocket to be connected
    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    // Send loop.created event
    act(() => {
      ws.sendEvent({
        type: "loop.created",
        loopId: "loop-2",
        config: loop2.config,
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(2);
    });
  });

  test("loop.deleted removes loop from state", async () => {
    const loop1 = createLoop({ config: { id: "loop-1" }, state: { id: "loop-1" } });
    const loop2 = createLoop({ config: { id: "loop-2" }, state: { id: "loop-2" } });
    setupLoopsList([loop1, loop2]);

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(2);
    });

    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    act(() => {
      ws.sendEvent({
        type: "loop.deleted",
        loopId: "loop-1",
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(1);
      expect(result.current.loops[0]!.config.id).toBe("loop-2");
    });
  });

  test("loop.merged triggers a single-loop refresh", async () => {
    const loop = createLoop({ config: { id: "loop-1" }, state: { id: "loop-1", status: "pushed" } });
    const mergedLoop = createLoop({ config: { id: "loop-1" }, state: { id: "loop-1", status: "merged" } });
    setupLoopsList([loop]);
    api.get("/api/loops/:id", () => mergedLoop);

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(1);
    });

    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    act(() => {
      ws.sendEvent({
        type: "loop.merged",
        loopId: "loop-1",
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.loops[0]!.state.status).toBe("merged");
    });
  });

  test("loop.completed triggers a single-loop refresh", async () => {
    const loop = createLoop({ config: { id: "loop-1" }, state: { id: "loop-1", status: "running" } });
    const completedLoop = createLoop({ config: { id: "loop-1" }, state: { id: "loop-1", status: "completed" } });
    setupLoopsList([loop]);

    // Mock for single-loop refresh
    api.get("/api/loops/:id", () => completedLoop);

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(1);
    });

    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    act(() => {
      ws.sendEvent({
        type: "loop.completed",
        loopId: "loop-1",
        totalIterations: 3,
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.loops[0]!.state.status).toBe("completed");
    });
  });

  test("loop.automatic_pr_flow.updated triggers a single-loop refresh", async () => {
    const initialLoop = createLoopWithStatus("pushed", {
      config: { id: "loop-1" },
      state: {
        id: "loop-1",
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
          reviewBranches: [],
        },
      },
    });
    const updatedLoop = createLoopWithStatus("pushed", {
      config: { id: "loop-1" },
      state: {
        id: "loop-1",
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
          reviewBranches: [],
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
    setupLoopsList([initialLoop]);
    api.get("/api/loops/:id", () => updatedLoop);

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(1);
    });

    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    act(() => {
      ws.sendEvent({
        type: "loop.automatic_pr_flow.updated",
        loopId: "loop-1",
        automaticPrFlow: updatedLoop.state.automaticPrFlow,
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.loops[0]!.state.automaticPrFlow?.enabled).toBe(true);
    });
  });

  test("re-syncs the loop list after websocket reconnect", async () => {
    const initialLoop = createLoop({ config: { id: "loop-1" }, state: { id: "loop-1", status: "running" } });
    const recoveredLoop = createLoop({ config: { id: "loop-1" }, state: { id: "loop-1", status: "completed" } });

    let callCount = 0;
    api.get("/api/loops", () => {
      callCount++;
      return callCount === 1 ? [initialLoop] : [recoveredLoop];
    });

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    expect(result.current.loops[0]!.state.status).toBe("running");
    expect(callCount).toBe(1);

    const initialConnection = ws.connections()[0]!;
    await act(async () => {
      initialConnection.instance.close(1006, "network lost");
    });

    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(1);
    }, { timeout: 3000 });
    await waitFor(() => {
      expect(result.current.loops[0]!.state.status).toBe("completed");
    });

    expect(callCount).toBe(2);
  });
});

// ─── createLoop ──────────────────────────────────────────────────────────────

describe("createLoop", () => {
  test("sends POST request and returns created loop", async () => {
    setupLoopsList([]);
    const newLoop = createLoop({ config: { id: "new-loop" } });
    api.post("/api/loops", () => newLoop);

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let createResult: { loop: Loop | null } = { loop: null };
    await act(async () => {
      createResult = await result.current.createLoop({
        ...createLoopRequestBase,
        name: "Do something",
        prompt: "Do something",
        workspaceId: "ws-1",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", variant: "" },
        useWorktree: true,
        planMode: false,
      });
    });

    expect(createResult.loop).not.toBeNull();
    expect(createResult.loop!.config.id).toBe("new-loop");
    const postCalls = api.calls("/api/loops", "POST");
    expect(postCalls).toHaveLength(1);
      expect(postCalls[0]!.body).toEqual({
        ...createLoopRequestBase,
        name: "Do something",
        prompt: "Do something",
        workspaceId: "ws-1",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", variant: "" },
        useWorktree: true,
        planMode: false,
      });
  });

  test("returns startError on 409 uncommitted changes", async () => {
    setupLoopsList([]);
    api.post("/api/loops", () => {
      throw new MockApiError(409, {
        error: "uncommitted_changes",
        message: "Directory has uncommitted changes",
        changedFiles: ["file1.ts", "file2.ts"],
      });
    });

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let createResult: { loop: Loop | null; startError?: unknown } = { loop: null };
    await act(async () => {
      createResult = await result.current.createLoop({
        ...createLoopRequestBase,
        name: "Do something",
        prompt: "Do something",
        workspaceId: "ws-1",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", variant: "" },
        useWorktree: true,
        planMode: false,
      });
    });

    expect(createResult.loop).toBeNull();
    expect(createResult.startError).toBeDefined();
    expect((createResult.startError as { error: string }).error).toBe("uncommitted_changes");
  });

  test("sets error and returns null loop on other failures", async () => {
    setupLoopsList([]);
    api.post("/api/loops", () => {
      throw new MockApiError(400, { message: "Invalid model" });
    });

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let createResult: { loop: Loop | null } = { loop: null };
    await act(async () => {
      createResult = await result.current.createLoop({
        ...createLoopRequestBase,
        name: "Do something",
        prompt: "Do something",
        workspaceId: "ws-1",
        model: { providerID: "bad", modelID: "bad", variant: "" },
        useWorktree: true,
        planMode: false,
      });
    });

    expect(createResult.loop).toBeNull();
    expect(result.current.error).toBeTruthy();
  });
});

// ─── updateLoop ──────────────────────────────────────────────────────────────

describe("updateLoop", () => {
  test("sends PATCH request and updates loop in state", async () => {
    const loop = createLoop({ config: { id: "loop-1", prompt: "Old prompt" }, state: { id: "loop-1" } });
    setupLoopsList([loop]);

    const updatedLoop = createLoop({ config: { id: "loop-1", prompt: "New prompt" }, state: { id: "loop-1" } });
    api.patch("/api/loops/:id", () => updatedLoop);

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(1);
    });

    let updated: Loop | null = null;
    await act(async () => {
      updated = await result.current.updateLoop("loop-1", { prompt: "New prompt" });
    });

    expect(updated).not.toBeNull();
    expect(updated!.config.id).toBe("loop-1");
    expect(updated!.config.prompt).toBe("New prompt");
    expect(result.current.loops[0]!.config.prompt).toBe("New prompt");
  });

  test("sets error and returns null on failure", async () => {
    setupLoopsList([]);
    api.patch("/api/loops/:id", () => {
      throw new MockApiError(404, { message: "Loop not found" });
    });

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let updated: Loop | null = null;
    await act(async () => {
      updated = await result.current.updateLoop("nonexistent", { prompt: "test" });
    });

    expect(updated).toBeNull();
    expect(result.current.error).toBeTruthy();
  });
});

// ─── deleteLoop ──────────────────────────────────────────────────────────────

describe("deleteLoop", () => {
  test("calls deleteLoopApi and returns true on success", async () => {
    const loop = createLoop({ config: { id: "loop-1" }, state: { id: "loop-1" } });
    setupLoopsList([loop]);
    api.delete("/api/loops/:id", () => ({ success: true }));

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(1);
    });

    let deleted = false;
    await act(async () => {
      deleted = await result.current.deleteLoop("loop-1");
    });

    expect(deleted).toBe(true);
  });

  test("sets error and returns false on failure", async () => {
    setupLoopsList([]);
    api.delete("/api/loops/:id", () => {
      throw new MockApiError(500, { message: "Delete failed" });
    });

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let deleted = false;
    await act(async () => {
      deleted = await result.current.deleteLoop("loop-1");
    });

    expect(deleted).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
});

// ─── acceptLoop ──────────────────────────────────────────────────────────────

describe("acceptLoop", () => {
  test("calls acceptLoopApi and refreshes the loop", async () => {
    const loop = createLoopWithStatus("completed", { config: { id: "loop-1" }, state: { id: "loop-1" } });
    const mergedLoop = createLoopWithStatus("merged", { config: { id: "loop-1" }, state: { id: "loop-1" } });
    setupLoopsList([loop]);

    api.post("/api/loops/:id/accept", () => ({
      success: true,
      mergeCommit: "abc123",
    }));
    api.get("/api/loops/:id", () => mergedLoop);

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(1);
    });

    let acceptResult: { success: boolean; mergeCommit?: string } = { success: false };
    await act(async () => {
      acceptResult = await result.current.acceptLoop("loop-1");
    });

    expect(acceptResult.success).toBe(true);
    expect(acceptResult.mergeCommit).toBe("abc123");
  });

  test("returns success: false on error", async () => {
    setupLoopsList([]);
    api.post("/api/loops/:id/accept", () => {
      throw new MockApiError(500, { message: "Merge conflict" });
    });

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let acceptResult = { success: false };
    await act(async () => {
      acceptResult = await result.current.acceptLoop("loop-1");
    });

    expect(acceptResult.success).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
});

// ─── pushLoop ────────────────────────────────────────────────────────────────

describe("pushLoop", () => {
  test("calls pushLoopApi and refreshes the loop", async () => {
    const loop = createLoopWithStatus("completed", { config: { id: "loop-1" }, state: { id: "loop-1" } });
    const pushedLoop = createLoopWithStatus("pushed", { config: { id: "loop-1" }, state: { id: "loop-1" } });
    setupLoopsList([loop]);

    api.post("/api/loops/:id/push", () => ({
      success: true,
      remoteBranch: "feature-a1b2c3d",
    }));
    api.get("/api/loops/:id", () => pushedLoop);

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(1);
    });

    let pushResult: { success: boolean; remoteBranch?: string } = { success: false };
    await act(async () => {
      pushResult = await result.current.pushLoop("loop-1");
    });

    expect(pushResult.success).toBe(true);
    expect(pushResult.remoteBranch).toBe("feature-a1b2c3d");
  });
});

// ─── discardLoop ─────────────────────────────────────────────────────────────

describe("discardLoop", () => {
  test("calls discardLoopApi and refreshes the loop", async () => {
    const loop = createLoopWithStatus("completed", { config: { id: "loop-1" }, state: { id: "loop-1" } });
    const deletedLoop = createLoopWithStatus("deleted", { config: { id: "loop-1" }, state: { id: "loop-1" } });
    setupLoopsList([loop]);

    api.post("/api/loops/:id/discard", () => ({ success: true }));
    api.get("/api/loops/:id", () => deletedLoop);

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(1);
    });

    let discarded = false;
    await act(async () => {
      discarded = await result.current.discardLoop("loop-1");
    });

    expect(discarded).toBe(true);
  });
});

// ─── purgeLoop ───────────────────────────────────────────────────────────────

describe("purgeLoop", () => {
  test("calls purgeLoopApi and removes loop from state", async () => {
    const loop = createLoopWithStatus("deleted", { config: { id: "loop-1" }, state: { id: "loop-1" } });
    setupLoopsList([loop]);

    api.post("/api/loops/:id/purge", () => ({ success: true }));

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(1);
    });

    let purged = false;
    await act(async () => {
      purged = await result.current.purgeLoop("loop-1");
    });

    expect(purged).toBe(true);
    expect(result.current.loops).toHaveLength(0);
  });

  test("sets error and returns false on failure", async () => {
    setupLoopsList([]);
    api.post("/api/loops/:id/purge", () => {
      throw new MockApiError(500, { message: "Purge failed" });
    });

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let purged = false;
    await act(async () => {
      purged = await result.current.purgeLoop("loop-1");
    });

    expect(purged).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
});

describe("purgeArchivedWorkspaceLoops", () => {
  test("removes all purged archived loops from state", async () => {
    const archivedLoop1 = createLoopWithStatus("deleted", {
      config: { id: "loop-1", workspaceId: "ws-1" },
      state: { id: "loop-1" },
    });
    const archivedLoop2 = createLoopWithStatus("merged", {
      config: { id: "loop-2", workspaceId: "ws-1" },
      state: { id: "loop-2" },
    });
    const remainingLoop = createLoopWithStatus("running", {
      config: { id: "loop-3", workspaceId: "ws-1" },
      state: { id: "loop-3" },
    });
    setupLoopsList([archivedLoop1, archivedLoop2, remainingLoop]);

    api.post("/api/workspaces/:id/archived-loops/purge", () => ({
      success: true,
      workspaceId: "ws-1",
      totalArchived: 2,
      purgedCount: 2,
      purgedLoopIds: ["loop-1", "loop-2"],
      failures: [],
    }));

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(3);
    });

    let purgeResult: PurgeArchivedLoopsResult = {
      success: false,
      workspaceId: "",
      totalArchived: 0,
      purgedCount: 0,
      purgedLoopIds: [],
      failures: [],
    };
    await act(async () => {
      purgeResult = await result.current.purgeArchivedWorkspaceLoops("ws-1");
    });

    expect(purgeResult.success).toBe(true);
    expect(purgeResult.purgedLoopIds).toEqual(["loop-1", "loop-2"]);
    expect(result.current.loops.map((loop) => loop.config.id)).toEqual(["loop-3"]);
  });

  test("sets error and returns failure result when bulk purge fails", async () => {
    setupLoopsList([]);
    api.post("/api/workspaces/:id/archived-loops/purge", () => {
      throw new MockApiError(500, { message: "Bulk purge failed" });
    });

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let purgeResult: PurgeArchivedLoopsResult = {
      success: true,
      workspaceId: "ws-1",
      totalArchived: 1,
      purgedCount: 1,
      purgedLoopIds: ["loop-1"],
      failures: [],
    };
    await act(async () => {
      purgeResult = await result.current.purgeArchivedWorkspaceLoops("ws-1");
    });

    expect(purgeResult.success).toBe(false);
    expect(purgeResult.workspaceId).toBe("ws-1");
    expect(result.current.error).toContain("Bulk purge failed");
  });
});

// ─── addressReviewComments ───────────────────────────────────────────────────

describe("addressReviewComments", () => {
  test("calls addressReviewCommentsApi and refreshes the loop", async () => {
    const loop = createLoopWithStatus("pushed", { config: { id: "loop-1" }, state: { id: "loop-1" } });
    const runningLoop = createLoopWithStatus("running", { config: { id: "loop-1" }, state: { id: "loop-1" } });
    setupLoopsList([loop]);

    api.post("/api/loops/:id/address-comments", () => ({
      success: true,
      reviewCycle: 1,
      branch: "loop-1-a1b2c3d-review-1",
    }));
    api.get("/api/loops/:id", () => runningLoop);

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(1);
    });

    let addressResult: { success: boolean; reviewCycle?: number } = { success: false };
    await act(async () => {
      addressResult = await result.current.addressReviewComments("loop-1", "Fix the typo");
    });

    expect(addressResult.success).toBe(true);
    expect(addressResult.reviewCycle).toBe(1);
  });

  test("returns success: false on error", async () => {
    setupLoopsList([]);
    api.post("/api/loops/:id/address-comments", () => {
      throw new MockApiError(400, { message: "Not addressable" });
    });

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let addressResult = { success: false };
    await act(async () => {
      addressResult = await result.current.addressReviewComments("loop-1", "comments");
    });

    expect(addressResult.success).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
});

// ─── getLoop ─────────────────────────────────────────────────────────────────

describe("getLoop", () => {
  test("finds a loop by ID", async () => {
    const loop1 = createLoop({ config: { id: "loop-1" }, state: { id: "loop-1" } });
    const loop2 = createLoop({ config: { id: "loop-2" }, state: { id: "loop-2" } });
    setupLoopsList([loop1, loop2]);

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(2);
    });

    expect(result.current.getLoop("loop-1")?.config.id).toBe("loop-1");
    expect(result.current.getLoop("loop-2")?.config.id).toBe("loop-2");
    expect(result.current.getLoop("nonexistent")).toBeUndefined();
  });
});

// ─── refresh ─────────────────────────────────────────────────────────────────

describe("refresh", () => {
  test("re-fetches loops list", async () => {
    const loop1 = createLoop({ config: { id: "loop-1" } });
    const loop2 = createLoop({ config: { id: "loop-2" } });

    let callCount = 0;
    api.get("/api/loops", () => {
      callCount++;
      return callCount === 1 ? [loop1] : [loop1, loop2];
    });

    const { result } = renderHook(() => useLoops());

    await waitFor(() => {
      expect(result.current.loops).toHaveLength(1);
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.loops).toHaveLength(2);
  });
});
