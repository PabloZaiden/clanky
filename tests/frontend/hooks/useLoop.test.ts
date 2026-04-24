/**
 * Tests for useLoop hook.
 *
 * Tests single loop state management, WebSocket event handling for
 * messages/toolCalls/progress/logs, and all action methods.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createMockApi, MockApiError } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { createLoop, createLoopWithStatus, createPersistedMessage } from "../helpers/factories";
import { useLoop } from "@/hooks/useLoop";
import type { Loop } from "@/types/loop";

const LOOP_ID = "test-loop-1";
const api = createMockApi();
const ws = createMockWebSocket();

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

/** Set up default GET /api/loops/:id mock. */
function setupLoop(loop: Loop = createLoop({ config: { id: LOOP_ID }, state: { id: LOOP_ID } })) {
  api.get("/api/loops/:id", () => loop);
  return loop;
}

/** Wait for hook to finish initial load. */
async function waitForLoad(result: { current: { loading: boolean } }) {
  await waitFor(() => {
    expect(result.current.loading).toBe(false);
  });
}

/** Wait for WebSocket connections to exist. */
async function waitForWs() {
  await waitFor(() => {
    expect(ws.connections().length).toBeGreaterThan(0);
  });
}

// ─── Initial fetch ───────────────────────────────────────────────────────────

describe("initial fetch", () => {
  test("fetches loop on mount and sets loading to false", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    expect(result.current.loading).toBe(true);

    await waitForLoad(result);

    expect(result.current.loop).not.toBeNull();
    expect(result.current.loop!.config.id).toBe(LOOP_ID);
    expect(result.current.error).toBeNull();
  });

  test("sets error when loop not found (404)", async () => {
    api.get("/api/loops/:id", () => {
      throw new MockApiError(404, { message: "Loop not found" });
    });

    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);

    expect(result.current.loop).toBeNull();
    expect(result.current.error).toBe("Loop not found");
  });

  test("sets error when fetch fails", async () => {
    api.get("/api/loops/:id", () => {
      throw new MockApiError(500, { message: "Server error" });
    });

    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);

    expect(result.current.error).toBeTruthy();
  });

  test("hydrates persisted user image attachments on initial load", async () => {
    const attachment = {
      id: "img-1",
      filename: "screen.png",
      mimeType: "image/png",
      data: "ZmFrZQ==",
      size: 1234,
    };
    setupLoop(createLoop({
      config: { id: LOOP_ID },
      state: {
        id: LOOP_ID,
        messages: [createPersistedMessage({
          id: "msg-1",
          role: "user",
          content: "Please inspect this screenshot",
          attachments: [attachment],
        })],
      },
    }));

    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      id: "msg-1",
      role: "user",
      content: "Please inspect this screenshot",
      attachments: [attachment],
    });
  });

  test("hydrates finalized response markers for persisted response logs", async () => {
    setupLoop(createLoop({
      config: { id: LOOP_ID },
      state: {
        id: LOOP_ID,
        logs: [{
          id: "log-response-1",
          level: "agent",
          message: "AI generating response...",
          details: {
            logKind: "response",
            responseContent: "Done\n<promise>COMPLETE</promise>",
          },
          timestamp: new Date().toISOString(),
        }],
      },
    }));

    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.logs[0]?.finalizedResponse).toEqual({
      content: "Done",
      indicator: {
        marker: "COMPLETE",
        kind: "complete",
        label: "COMPLETED",
      },
    });
  });
});

// ─── WebSocket events: messages ──────────────────────────────────────────────

describe("WebSocket event: loop.message", () => {
  test("accumulates messages from events", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);
    await waitForWs();

    act(() => {
      ws.sendEvent({
        type: "loop.message",
        loopId: LOOP_ID,
        iteration: 1,
        message: {
          id: "msg-1",
          role: "assistant",
          content: "Hello",
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
    });
    expect(result.current.messages[0]!.content).toBe("Hello");
    expect(result.current.messages[0]!.role).toBe("assistant");
  });

  test("clears progress content when message arrives", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);
    await waitForWs();

    // First send progress
    act(() => {
      ws.sendEvent({
        type: "loop.progress",
        loopId: LOOP_ID,
        iteration: 1,
        content: "Partial text...",
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.progressContent).toBe("Partial text...");
    });

    // Then send the complete message
    act(() => {
      ws.sendEvent({
        type: "loop.message",
        loopId: LOOP_ID,
        iteration: 1,
        message: {
          id: "msg-1",
          role: "assistant",
          content: "Full message",
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.progressContent).toBe("");
    });
  });

  test("finalizes the latest response log when an assistant message completes", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);
    await waitForWs();

    act(() => {
      ws.sendEvent({
        type: "loop.log",
        loopId: LOOP_ID,
        id: "response-log-1",
        level: "agent",
        message: "AI generating response...",
        details: {
          logKind: "response",
          responseContent: "Plan created\n<promise>PLAN_READY</promise>",
        },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });
    expect(result.current.logs[0]?.finalizedResponse).toBeUndefined();

    act(() => {
      ws.sendEvent({
        type: "loop.message",
        loopId: LOOP_ID,
        iteration: 1,
        message: {
          id: "msg-1",
          role: "assistant",
          content: "Plan created\n<promise>PLAN_READY</promise>",
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.logs[0]?.finalizedResponse?.indicator.kind).toBe("plan_ready");
    });
    expect(result.current.logs[0]?.finalizedResponse).toEqual({
      content: "Plan created",
      indicator: {
        marker: "PLAN_READY",
        kind: "plan_ready",
        label: "PLAN READY",
      },
    });
  });

  test("preserves finalized response metadata when a later log update replaces the same response entry", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);
    await waitForWs();

    act(() => {
      ws.sendEvent({
        type: "loop.log",
        loopId: LOOP_ID,
        id: "response-log-1",
        level: "agent",
        message: "AI generating response...",
        details: {
          logKind: "response",
          responseContent: "Plan created\n<promise>PLAN_READY</promise>",
        },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });

    act(() => {
      ws.sendEvent({
        type: "loop.message",
        loopId: LOOP_ID,
        iteration: 1,
        message: {
          id: "msg-1",
          role: "assistant",
          content: "Plan created\n<promise>PLAN_READY</promise>",
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.logs[0]?.finalizedResponse?.indicator.kind).toBe("plan_ready");
    });

    act(() => {
      ws.sendEvent({
        type: "loop.log",
        loopId: LOOP_ID,
        id: "response-log-1",
        level: "agent",
        message: "AI response finished",
        details: {
          logKind: "response",
          responseContent: "Plan created\n<promise>PLAN_READY</promise>",
          metadata: "kept",
        },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.logs[0]?.message).toBe("AI response finished");
    });

    expect(result.current.logs[0]?.finalizedResponse).toEqual({
      content: "Plan created",
      indicator: {
        marker: "PLAN_READY",
        kind: "plan_ready",
        label: "PLAN READY",
      },
    });
  });
});

// ─── WebSocket events: tool calls ────────────────────────────────────────────

describe("WebSocket event: loop.tool_call", () => {
  test("accumulates tool calls from events", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);
    await waitForWs();

    act(() => {
      ws.sendEvent({
        type: "loop.tool_call",
        loopId: LOOP_ID,
        iteration: 1,
        tool: {
          id: "tc-1",
          name: "Read",
          input: { filePath: "/src/index.ts" },
          status: "running",
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.toolCalls).toHaveLength(1);
    });
    expect(result.current.toolCalls[0]!.name).toBe("Read");
    expect(result.current.toolCalls[0]!.status).toBe("running");
  });

  test("updates existing tool call by id", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);
    await waitForWs();

    // Send initial tool call
    act(() => {
      ws.sendEvent({
        type: "loop.tool_call",
        loopId: LOOP_ID,
        iteration: 1,
        tool: {
          id: "tc-1",
          name: "Read",
          input: { filePath: "/src/index.ts" },
          status: "running",
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.toolCalls).toHaveLength(1);
    });

    // Update same tool call to completed
    act(() => {
      ws.sendEvent({
        type: "loop.tool_call",
        loopId: LOOP_ID,
        iteration: 1,
        tool: {
          id: "tc-1",
          name: "Read",
          input: { filePath: "/src/index.ts" },
          output: "file contents",
          status: "completed",
          timestamp: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.toolCalls[0]!.status).toBe("completed");
    });
    // Should still be just 1 tool call, not 2
    expect(result.current.toolCalls).toHaveLength(1);
  });
});

// ─── WebSocket events: progress ──────────────────────────────────────────────

describe("WebSocket event: loop.progress", () => {
  test("accumulates progress content", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);
    await waitForWs();

    act(() => {
      ws.sendEvent({
        type: "loop.progress",
        loopId: LOOP_ID,
        iteration: 1,
        content: "Hello ",
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.progressContent).toBe("Hello ");
    });

    act(() => {
      ws.sendEvent({
        type: "loop.progress",
        loopId: LOOP_ID,
        iteration: 1,
        content: "world!",
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.progressContent).toBe("Hello world!");
    });
  });
});

// ─── WebSocket events: logs ──────────────────────────────────────────────────

describe("WebSocket event: loop.log", () => {
  test("adds log entries from events", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);
    await waitForWs();

    act(() => {
      ws.sendEvent({
        type: "loop.log",
        loopId: LOOP_ID,
        id: "log-1",
        level: "info",
        message: "Starting iteration 1",
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });
    expect(result.current.logs[0]!.message).toBe("Starting iteration 1");
    expect(result.current.logs[0]!.level).toBe("info");
  });

  test("updates existing log entry by id", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);
    await waitForWs();

    act(() => {
      ws.sendEvent({
        type: "loop.log",
        loopId: LOOP_ID,
        id: "log-1",
        level: "info",
        message: "Processing...",
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });

    act(() => {
      ws.sendEvent({
        type: "loop.log",
        loopId: LOOP_ID,
        id: "log-1",
        level: "info",
        message: "Processing... done",
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.logs[0]!.message).toBe("Processing... done");
    });
    expect(result.current.logs).toHaveLength(1);
  });
});

// ─── WebSocket events: git changes ──────────────────────────────────────────

describe("WebSocket events: git changes", () => {
  test("loop.iteration.end increments gitChangeCounter", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);
    await waitForWs();

    const initialCounter = result.current.gitChangeCounter;

    act(() => {
      ws.sendEvent({
        type: "loop.iteration.end",
        loopId: LOOP_ID,
        iteration: 1,
        outcome: "continue",
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.gitChangeCounter).toBe(initialCounter + 1);
    });
  });

  test("loop.git.commit increments gitChangeCounter", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);
    await waitForWs();

    const initialCounter = result.current.gitChangeCounter;

    act(() => {
      ws.sendEvent({
        type: "loop.git.commit",
        loopId: LOOP_ID,
        iteration: 1,
        commit: {
          iteration: 1,
          sha: "abc123",
          message: "Fix bug",
          timestamp: new Date().toISOString(),
          filesChanged: 2,
        },
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.gitChangeCounter).toBe(initialCounter + 1);
    });
  });
});

// ─── WebSocket events: lifecycle triggers refresh ────────────────────────────

describe("WebSocket lifecycle events trigger refresh", () => {
  test("loop.completed triggers refresh and updates status", async () => {
    const runningLoop = createLoopWithStatus("running", { config: { id: LOOP_ID }, state: { id: LOOP_ID } });
    const completedLoop = createLoopWithStatus("completed", { config: { id: LOOP_ID }, state: { id: LOOP_ID } });

    let callCount = 0;
    api.get("/api/loops/:id", () => {
      callCount++;
      return callCount === 1 ? runningLoop : completedLoop;
    });

    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);
    expect(result.current.loop!.state.status).toBe("running");

    await waitForWs();

    act(() => {
      ws.sendEvent({
        type: "loop.completed",
        loopId: LOOP_ID,
        totalIterations: 3,
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.loop!.state.status).toBe("completed");
    });
  });
});

// ─── Loop switching isolation ────────────────────────────────────────────────

describe("loop switching isolation", () => {
  test("ignores stale WebSocket messages after switching loops", async () => {
    const secondLoopId = "test-loop-2";
    const loopsById: Record<string, Loop> = {
      [LOOP_ID]: createLoop({ config: { id: LOOP_ID }, state: { id: LOOP_ID } }),
      [secondLoopId]: createLoop({ config: { id: secondLoopId }, state: { id: secondLoopId } }),
    };
    api.get("/api/loops/:id", (req) => {
      const loop = loopsById[req.params["id"]!];
      if (!loop) {
        throw new MockApiError(404, { message: "Loop not found" });
      }
      return loop;
    });

    const { result, rerender } = renderHook(
      ({ loopId }) => useLoop(loopId),
      { initialProps: { loopId: LOOP_ID } },
    );

    await waitForLoad(result);
    await waitFor(() => {
      expect(ws.getLoopConnection(LOOP_ID)?.isOpen).toBe(true);
    });

    const oldConnection = ws.getLoopConnection(LOOP_ID)!;

    act(() => {
      oldConnection.instance.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "loop.log",
            loopId: LOOP_ID,
            id: "initial-log",
            level: "info",
            message: "before switch",
            timestamp: new Date().toISOString(),
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });

    rerender({ loopId: secondLoopId });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.loop?.config.id).toBe(secondLoopId);
    });

    await waitFor(() => {
      const openLoopConnections = ws.connections().filter(
        (connection) => connection.isOpen && !!connection.queryParams["loopId"],
      );
      expect(openLoopConnections).toHaveLength(1);
      expect(openLoopConnections[0]!.queryParams["loopId"]).toBe(secondLoopId);
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(0);
    });

    act(() => {
      oldConnection.instance.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "loop.log",
            loopId: LOOP_ID,
            id: "stale-log",
            level: "info",
            message: "stale log",
            timestamp: new Date().toISOString(),
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(0);
    });
  });

  test("ignores stale push callbacks after switching loops", async () => {
    const secondLoopId = "test-loop-2";
    const loopsById: Record<string, Loop> = {
      [LOOP_ID]: createLoopWithStatus("completed", { config: { id: LOOP_ID }, state: { id: LOOP_ID } }),
      [secondLoopId]: createLoopWithStatus("completed", {
        config: { id: secondLoopId },
        state: { id: secondLoopId },
      }),
    };
    api.get("/api/loops/:id", (req) => {
      const loop = loopsById[req.params["id"]!];
      if (!loop) {
        throw new MockApiError(404, { message: "Loop not found" });
      }
      return loop;
    });
    api.post("/api/loops/:id/push", (req) => ({
      success: true,
      remoteBranch: `branch-${req.params["id"]!}`,
    }));

    const { result, rerender } = renderHook(
      ({ loopId }) => useLoop(loopId),
      { initialProps: { loopId: LOOP_ID } },
    );

    await waitForLoad(result);

    const stalePush = result.current.push;

    rerender({ loopId: secondLoopId });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.loop?.config.id).toBe(secondLoopId);
    });

    let staleResult: { success: boolean; remoteBranch?: string } = { success: true };
    await act(async () => {
      staleResult = await stalePush();
    });

    expect(staleResult.success).toBe(false);
    expect(api.calls("/api/loops/:id/push", "POST")).toHaveLength(0);

    let pushResult: { success: boolean; remoteBranch?: string } = { success: false };
    await act(async () => {
      pushResult = await result.current.push();
    });

    expect(pushResult.success).toBe(true);
    expect(pushResult.remoteBranch).toBe(`branch-${secondLoopId}`);
    const pushCalls = api.calls("/api/loops/:id/push", "POST");
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]!.params["id"]).toBe(secondLoopId);
  });
});

// ─── Actions: update ─────────────────────────────────────────────────────────

describe("update", () => {
  test("sends PATCH request and updates loop state", async () => {
    setupLoop();
    const updated = createLoop({ config: { id: LOOP_ID, name: "New Name" }, state: { id: LOOP_ID } });
    api.patch("/api/loops/:id", () => updated);

    const { result } = renderHook(() => useLoop(LOOP_ID));
    await waitForLoad(result);

    let success = false;
    await act(async () => {
      success = await result.current.update({ name: "New Name" });
    });

    expect(success).toBe(true);
    expect(result.current.loop!.config.name).toBe("New Name");
  });

  test("returns false on failure", async () => {
    setupLoop();
    api.patch("/api/loops/:id", () => {
      throw new MockApiError(400, { message: "Invalid name" });
    });

    const { result } = renderHook(() => useLoop(LOOP_ID));
    await waitForLoad(result);

    let success = false;
    await act(async () => {
      success = await result.current.update({ name: "" });
    });

    expect(success).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
});

// ─── Actions: remove ─────────────────────────────────────────────────────────

describe("remove", () => {
  test("calls deleteLoopApi and sets loop to null", async () => {
    setupLoop();
    api.delete("/api/loops/:id", () => ({ success: true }));

    const { result } = renderHook(() => useLoop(LOOP_ID));
    await waitForLoad(result);
    expect(result.current.loop).not.toBeNull();

    let success = false;
    await act(async () => {
      success = await result.current.remove();
    });

    expect(success).toBe(true);
    expect(result.current.loop).toBeNull();
  });
});

// ─── Actions: purge ──────────────────────────────────────────────────────────

describe("purge", () => {
  test("calls purgeLoopApi and sets loop to null", async () => {
    setupLoop();
    api.post("/api/loops/:id/purge", () => ({ success: true }));

    const { result } = renderHook(() => useLoop(LOOP_ID));
    await waitForLoad(result);

    let success = false;
    await act(async () => {
      success = await result.current.purge();
    });

    expect(success).toBe(true);
    expect(result.current.loop).toBeNull();
  });
});

// ─── Actions: markMerged ─────────────────────────────────────────────────────

describe("markMerged", () => {
  test("calls markMergedApi and refreshes the loop as merged", async () => {
    let currentLoop = createLoop({ config: { id: LOOP_ID }, state: { id: LOOP_ID, status: "pushed" } });
    api.get("/api/loops/:id", () => currentLoop);
    api.post("/api/loops/:id/mark-merged", () => {
      currentLoop = createLoop({ config: { id: LOOP_ID }, state: { id: LOOP_ID, status: "merged" } });
      return { success: true };
    });

    const { result } = renderHook(() => useLoop(LOOP_ID));
    await waitForLoad(result);

    let success = false;
    await act(async () => {
      success = await result.current.markMerged();
    });

    expect(success).toBe(true);
    expect(result.current.loop?.state.status).toBe("merged");
  });

  test("marks the current loop as merged after switching loops", async () => {
    const secondLoopId = "test-loop-2";
    const loopsById: Record<string, Loop> = {
      [LOOP_ID]: createLoop({ config: { id: LOOP_ID }, state: { id: LOOP_ID, status: "pushed" } }),
      [secondLoopId]: createLoop({
        config: { id: secondLoopId },
        state: { id: secondLoopId, status: "pushed" },
      }),
    };
    api.get("/api/loops/:id", (req) => {
      const loop = loopsById[req.params["id"]!];
      if (!loop) {
        throw new MockApiError(404, { message: "Loop not found" });
      }
      return loop;
    });
    api.post("/api/loops/:id/mark-merged", (req) => {
      const loopId = req.params["id"]!;
      loopsById[loopId] = createLoop({
        config: { id: loopId },
        state: { id: loopId, status: "merged" },
      });
      return { success: true };
    });

    const { result, rerender } = renderHook(
      ({ loopId }) => useLoop(loopId),
      { initialProps: { loopId: LOOP_ID } },
    );
    await waitForLoad(result);

    rerender({ loopId: secondLoopId });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.loop?.config.id).toBe(secondLoopId);
    });

    let success = false;
    await act(async () => {
      success = await result.current.markMerged();
    });

    const calls = api.calls("/api/loops/:id/mark-merged", "POST");
    expect(success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params["id"]).toBe(secondLoopId);
    expect(result.current.loop?.config.id).toBe(secondLoopId);
    expect(result.current.loop?.state.status).toBe("merged");
  });
});

// ─── Actions: manualCompleteLoop ──────────────────────────────────────────────

describe("manualCompleteLoop", () => {
  test("calls manualCompleteLoopApi and refreshes the loop as completed", async () => {
    let currentLoop = createLoopWithStatus("failed", { config: { id: LOOP_ID }, state: { id: LOOP_ID } });
    api.get("/api/loops/:id", () => currentLoop);
    api.post("/api/loops/:id/manual-complete", () => {
      currentLoop = createLoopWithStatus("completed", {
        config: { id: LOOP_ID },
        state: { id: LOOP_ID, error: undefined },
      });
      return { success: true };
    });

    const { result } = renderHook(() => useLoop(LOOP_ID));
    await waitForLoad(result);

    let success = false;
    await act(async () => {
      success = await result.current.manualCompleteLoop();
    });

    expect(success).toBe(true);
    expect(result.current.loop?.state.status).toBe("completed");
    expect(result.current.loop?.state.error).toBeUndefined();
  });
});

// ─── Actions: getDiff ────────────────────────────────────────────────────────

describe("getDiff", () => {
  test("fetches diff from API", async () => {
    setupLoop();
    const diffs = [
      { path: "src/index.ts", status: "modified", additions: 5, deletions: 2 },
    ];
    api.get("/api/loops/:id/diff", () => diffs);

    const { result } = renderHook(() => useLoop(LOOP_ID));
    await waitForLoad(result);

    let diff: unknown[] = [];
    await act(async () => {
      diff = await result.current.getDiff();
    });

    expect(diff).toHaveLength(1);
    expect((diff[0] as { path: string }).path).toBe("src/index.ts");
  });

  test("returns empty array on 400 (no git branch)", async () => {
    setupLoop();
    api.get("/api/loops/:id/diff", () => {
      throw new MockApiError(400, { error: "no_git_branch", message: "No branch" });
    });

    const { result } = renderHook(() => useLoop(LOOP_ID));
    await waitForLoad(result);

    let diff: unknown[] = [];
    await act(async () => {
      diff = await result.current.getDiff();
    });

    expect(diff).toEqual([]);
  });
});

// ─── Actions: getPlan / getStatusFile ────────────────────────────────────────

describe("getPlan / getStatusFile", () => {
  test("getPlan fetches plan content", async () => {
    setupLoop();
    api.get("/api/loops/:id/plan", () => ({ content: "# My Plan", exists: true }));

    const { result } = renderHook(() => useLoop(LOOP_ID));
    await waitForLoad(result);

    let plan = { content: "", exists: false };
    await act(async () => {
      plan = await result.current.getPlan();
    });

    expect(plan.content).toBe("# My Plan");
    expect(plan.exists).toBe(true);
  });

  test("getStatusFile fetches status content", async () => {
    setupLoop();
    api.get("/api/loops/:id/status-file", () => ({ content: "In progress", exists: true }));

    const { result } = renderHook(() => useLoop(LOOP_ID));
    await waitForLoad(result);

    let status = { content: "", exists: false };
    await act(async () => {
      status = await result.current.getStatusFile();
    });

    expect(status.content).toBe("In progress");
    expect(status.exists).toBe(true);
  });
});

describe("WebSocket event: loop.automatic_pr_flow.updated", () => {
  test("refreshes loop state when automatic PR flow is enabled after push", async () => {
    const initialLoop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID },
      state: {
        id: LOOP_ID,
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
          reviewBranches: [],
        },
      },
    });
    const updatedLoop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID },
      state: {
        id: LOOP_ID,
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

    let requestCount = 0;
    api.get("/api/loops/:id", () => {
      requestCount += 1;
      return requestCount === 1 ? initialLoop : updatedLoop;
    });

    const { result } = renderHook(() => useLoop(LOOP_ID));
    await waitForLoad(result);
    await waitForWs();

    act(() => {
      ws.sendEvent({
        type: "loop.automatic_pr_flow.updated",
        loopId: LOOP_ID,
        automaticPrFlow: updatedLoop.state.automaticPrFlow,
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(result.current.loop?.state.automaticPrFlow?.enabled).toBe(true);
    });
    expect(result.current.loop?.state.automaticPrFlow?.pullRequestNumber).toBe(42);
  });
});

// ─── Actions: setPending / clearPending ──────────────────────────────────────

// ─── Connection status ───────────────────────────────────────────────────────

describe("connectionStatus", () => {
  test("reflects WebSocket connection status", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("open");
    });
  });
});

// ─── WebSocket connects with loopId ──────────────────────────────────────────

describe("WebSocket connection", () => {
  test("creates loop-specific WebSocket connection with loopId query param", async () => {
    setupLoop();
    const { result } = renderHook(() => useLoop(LOOP_ID));

    await waitForLoad(result);
    await waitForWs();

    const loopConn = ws.getLoopConnection(LOOP_ID);
    expect(loopConn).toBeDefined();
  });
});
