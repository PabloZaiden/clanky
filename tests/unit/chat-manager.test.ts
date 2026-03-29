/**
 * Unit tests for LoopManager chat methods: createChat(), sendChatMessage(),
 * recoverChatEngine(), and startStatePersistence() chat-mode behavior.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { TestContext } from "../setup";
import {
  setupTestContext,
  teardownTestContext,
  testModelFields,
  testWorkspaceId,
  waitForLoopStatus,
} from "../setup";
import { updateLoopState } from "../../src/persistence/loops";
import { ContextAwareMockBackend, NeverCompletingMockBackend } from "../mocks/mock-backend";
import { backendManager } from "../../src/core/backend-manager";

describe("LoopManager - Chat Mode", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({
      initGit: true,
      // Chat responses: each call returns a simple response
      mockResponses: [
        "Hello! How can I help?",
        "Here is my follow-up answer.",
        "Third response.",
      ],
    });
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  describe("createChat", () => {
    test("creates a chat with mode 'chat' and starts it", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Hello, can you help me?",
        workspaceId: testWorkspaceId,
      });

      expect(loop.config.mode).toBe("chat");
      expect(loop.config.planMode).toBe(false);
      expect(loop.config.maxIterations).toBe(1);
      expect(loop.config.clearPlanningFolder).toBe(false);
    });

    test("createChat starts the loop (creates worktree and session)", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Initial chat message",
        workspaceId: testWorkspaceId,
      });

      // Wait for the first turn to complete (startLoop is fire-and-forget)
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      const updated = await ctx.manager.getLoop(loop.config.id);
      expect(updated).not.toBeNull();

      // Should have git state (worktree was created)
      expect(updated!.state.git).toBeDefined();
      expect(updated!.state.git!.worktreePath).toBeDefined();
      expect(updated!.state.git!.workingBranch).toBeDefined();
    });

    test("createChat emits loop.created event", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Test chat",
        workspaceId: testWorkspaceId,
      });

      const createEvents = ctx.events.filter((e) => e.type === "loop.created");
      expect(createEvents.length).toBe(1);
      expect(createEvents[0]!.loopId).toBe(loop.config.id);
    });

    test("createChat runs the first turn automatically", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "What files are here?",
        workspaceId: testWorkspaceId,
      });

      // Wait for the first turn to complete
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      const updated = await ctx.manager.getLoop(loop.config.id);
      expect(updated!.state.status).toMatch(/completed|max_iterations/);
    });

    test("createChat sanitizes and truncates chat titles derived from the prompt", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: `# **${"a".repeat(120)}**\n\n`,
        workspaceId: testWorkspaceId,
      });

      expect(loop.config.name).toHaveLength(100);
      expect(loop.config.name).toBe("a".repeat(100));
    });
  });

  describe("sendChatMessage", () => {
    test("sends a message to an idle chat (completed status)", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "First message",
        workspaceId: testWorkspaceId,
      });

      // Wait for first turn to complete
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      // Send a follow-up message
      await ctx.manager.sendChatMessage(loop.config.id, "Follow-up question");

      // Wait for the second turn to complete
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"], 15000);

      const updated = await ctx.manager.getLoop(loop.config.id);
      expect(updated!.state.status).toMatch(/completed|max_iterations/);
    });

    test("preserves user message history across turns and reload", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "First user message",
        workspaceId: testWorkspaceId,
      });

      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      await ctx.manager.sendChatMessage(loop.config.id, "Second user message");
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"], 15000);

      const inMemoryLoop = await ctx.manager.getLoop(loop.config.id);
      const inMemoryUserMessages = (inMemoryLoop!.state.messages ?? []).filter((message) => message.role === "user");
      expect(inMemoryUserMessages.map((message) => message.content)).toEqual([
        "First user message",
        "Second user message",
      ]);
      expect(new Set(inMemoryUserMessages.map((message) => message.id)).size).toBe(2);

      // Simulate a refresh-after-restart path by forcing a DB load.
      // @ts-expect-error - accessing private field for test purposes
      ctx.manager.engines.delete(loop.config.id);

      const persistedLoop = await ctx.manager.getLoop(loop.config.id);
      const persistedUserMessages = (persistedLoop!.state.messages ?? []).filter((message) => message.role === "user");
      expect(persistedUserMessages.map((message) => message.content)).toEqual([
        "First user message",
        "Second user message",
      ]);
      expect(new Set(persistedUserMessages.map((message) => message.id)).size).toBe(2);
    });

    test("rejects sending message to a non-chat loop", async () => {
      // Create a regular loop (not a chat) and manually set it to completed
      // to avoid needing to run the engine
      const loop = await ctx.manager.createLoop({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Regular loop",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Manually set state to completed so recoverChatEngine can find it
      await updateLoopState(loop.config.id, {
        ...loop.state,
        status: "completed",
        git: {
          originalBranch: "master",
          workingBranch: "test-a1b2c3d",
          worktreePath: ctx.workDir,
          commits: [],
        },
      });

      // sendChatMessage should reject non-chat loops
      await expect(
        ctx.manager.sendChatMessage(loop.config.id, "This should fail"),
      ).rejects.toThrow(/not a chat/);
    });

    test("rejects sending message to a non-existent loop", async () => {
      await expect(
        ctx.manager.sendChatMessage("non-existent-id", "Hello"),
      ).rejects.toThrow(/not found/);
    });

    test("restarts a chat from stopped status", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Test chat",
        workspaceId: testWorkspaceId,
      });

      // Wait for first turn to complete
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      // Stop the chat
      await ctx.manager.stopLoop(loop.config.id);

      await ctx.manager.sendChatMessage(loop.config.id, "Restart after stop");
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"], 15000);

      const updated = await ctx.manager.getLoop(loop.config.id);
      expect(updated!.state.status).toMatch(/completed|max_iterations/);
    });

    test("replays persisted chat history after stop so the next turn remembers earlier context", async () => {
      const continuityBackend = new ContextAwareMockBackend();
      backendManager.setBackendForTesting(continuityBackend);

      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "The first thing I said was: kumquat",
        workspaceId: testWorkspaceId,
      });

      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      await ctx.manager.stopLoop(loop.config.id);
      await ctx.manager.sendChatMessage(loop.config.id, "What was the first thing I said?");
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"], 15000);

      const updated = await ctx.manager.getLoop(loop.config.id);
      const assistantMessages = (updated!.state.messages ?? []).filter((message) => message.role === "assistant");
      expect(assistantMessages[assistantMessages.length - 1]?.content).toContain("kumquat");
    });

    test("recreates the session after interrupting an active chat turn so the follow-up does not inherit a stale aborted session", async () => {
      const continuityBackend = new ContextAwareMockBackend({
        emitEmptyResponseAfterAbort: true,
        hangingPromptPattern: /survey the repo/i,
      });
      backendManager.setBackendForTesting(continuityBackend);

      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "The first thing I said was: starfruit",
        workspaceId: testWorkspaceId,
      });

      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      await ctx.manager.sendChatMessage(loop.config.id, "Please survey the repo in great detail.");

      const runningStart = Date.now();
      while (Date.now() - runningStart < 5000) {
        const current = await ctx.manager.getLoop(loop.config.id);
        if (current?.state.status === "running") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      await ctx.manager.sendChatMessage(loop.config.id, "What was the first thing I said?");
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"], 15000);

      const updated = await ctx.manager.getLoop(loop.config.id);
      const assistantMessages = (updated!.state.messages ?? []).filter((message) => message.role === "assistant");
      expect(assistantMessages[assistantMessages.length - 1]?.content).toContain("starfruit");
      expect(updated!.state.messages?.some((message) => message.role === "assistant" && message.content === "")).toBe(false);
    });

    test("restarts a completed chat even if a stale interruption flag was left on the in-memory engine", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Test chat",
        workspaceId: testWorkspaceId,
      });

      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      // @ts-expect-error - accessing private field for test purposes
      const engine = ctx.manager.engines.get(loop.config.id) as {
        aborted: boolean;
        injectionPending: boolean;
      } | undefined;
      expect(engine).toBeDefined();
      engine!.aborted = true;
      engine!.injectionPending = true;

      await ctx.manager.sendChatMessage(loop.config.id, "Restart after stale interrupt");
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"], 15000);

      const updated = await ctx.manager.getLoop(loop.config.id);
      expect(updated!.state.status).toMatch(/completed|max_iterations/);
    });

    test("restarts a chat from failed status after recovery", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Test chat",
        workspaceId: testWorkspaceId,
      });

      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      const current = await ctx.manager.getLoop(loop.config.id);
      await updateLoopState(loop.config.id, {
        ...current!.state,
        status: "failed",
        error: {
          message: "Previous turn failed",
          iteration: 1,
          timestamp: new Date().toISOString(),
        },
      });

      // @ts-expect-error - accessing private field for test purposes
      ctx.manager.engines.delete(loop.config.id);

      await ctx.manager.sendChatMessage(loop.config.id, "Restart after failure");
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"], 15000);

      const updated = await ctx.manager.getLoop(loop.config.id);
      expect(updated!.state.status).toMatch(/completed|max_iterations/);
    });
  });

  describe("recoverChatEngine", () => {
    test("recovers a chat engine after it is removed from memory", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Chat to recover",
        workspaceId: testWorkspaceId,
      });

      // Wait for first turn to complete
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      // Simulate server restart: remove the engine from the engines map
      // @ts-expect-error - accessing private field for test purposes
      ctx.manager.engines.delete(loop.config.id);

      // Verify engine is not in memory
      expect(ctx.manager.isRunning(loop.config.id)).toBe(false);

      // sendChatMessage should trigger recoverChatEngine and succeed
      await ctx.manager.sendChatMessage(loop.config.id, "After recovery");

      // Wait for the turn to complete
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"], 15000);

      const updated = await ctx.manager.getLoop(loop.config.id);
      expect(updated!.state.status).toMatch(/completed|max_iterations/);
    });

    test("recovers a branch-only chat engine after it is removed from memory", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Branch-only chat to recover",
        workspaceId: testWorkspaceId,
        useWorktree: false,
      });

      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      let updated = await ctx.manager.getLoop(loop.config.id);
      expect(updated!.state.git?.workingBranch).toBeDefined();
      expect(updated!.state.git?.originalBranch).toBeDefined();

      await ctx.git.checkoutBranch(ctx.workDir, updated!.state.git!.originalBranch);

      // @ts-expect-error - accessing private field for test purposes
      ctx.manager.engines.delete(loop.config.id);

      expect(ctx.manager.isRunning(loop.config.id)).toBe(false);

      await ctx.manager.sendChatMessage(loop.config.id, "After branch-only recovery");
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"], 15000);

      updated = await ctx.manager.getLoop(loop.config.id);
      expect(updated!.state.status).toMatch(/completed|max_iterations/);
    });

    test("replays persisted chat history after backend session loss during recovery", async () => {
      const continuityBackend = new ContextAwareMockBackend();
      backendManager.setBackendForTesting(continuityBackend);

      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "The first thing I said was: dragonfruit",
        workspaceId: testWorkspaceId,
      });

      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      await continuityBackend.disconnect();

      // Simulate a restart after the backend process/session disappeared.
      // @ts-expect-error - accessing private field for test purposes
      ctx.manager.engines.delete(loop.config.id);

      await ctx.manager.sendChatMessage(loop.config.id, "What was the first thing I said?");
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"], 15000);

      const updated = await ctx.manager.getLoop(loop.config.id);
      const assistantMessages = (updated!.state.messages ?? []).filter((message) => message.role === "assistant");
      expect(assistantMessages[assistantMessages.length - 1]?.content).toContain("dragonfruit");
    });

    test("rejects recovery of a non-chat loop", async () => {
      const loop = await ctx.manager.createLoop({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Regular loop",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Manually set status to completed
      await updateLoopState(loop.config.id, {
        ...loop.state,
        status: "completed",
      });

      // sendChatMessage should fail because the loop is not a chat
      await expect(
        ctx.manager.sendChatMessage(loop.config.id, "Should fail"),
      ).rejects.toThrow(/not a chat/);
    });
  });

  describe("session preservation (startStatePersistence chat behavior)", () => {
    test("chat engine stays in memory after completing a turn", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Test persistence",
        workspaceId: testWorkspaceId,
      });

      // Wait for first turn to complete
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      // For regular loops, the engine would be deleted from memory.
      // For chats, it should remain alive.
      // Check by accessing the private engines map
      // @ts-expect-error - accessing private field for test purposes
      const engine = ctx.manager.engines.get(loop.config.id);
      expect(engine).toBeDefined();
    });

    test("chat engine is removed from memory on stopped status", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Test stop cleanup",
        workspaceId: testWorkspaceId,
      });

      // Wait for first turn to complete
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      // Stop the chat
      await ctx.manager.stopLoop(loop.config.id);

      // After stop, engine should be cleaned up
      // @ts-expect-error - accessing private field for test purposes
      const engine = ctx.manager.engines.get(loop.config.id);
      expect(engine).toBeUndefined();
    });
  });

  describe("existing actions work for chats", () => {
    test("acceptLoop works for a completed chat", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Chat to accept",
        workspaceId: testWorkspaceId,
      });

      // Wait for first turn to complete
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      // Accept the chat (merges worktree branch into base branch)
      const result = await ctx.manager.acceptLoop(loop.config.id);
      expect(result.success).toBe(true);

      const updated = await ctx.manager.getLoop(loop.config.id);
      expect(updated!.state.status).toBe("merged");
    });

    test("discardLoop works for a completed chat", async () => {
      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Chat to discard",
        workspaceId: testWorkspaceId,
      });

      // Wait for first turn to complete
      await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

      // Discard the chat
      await ctx.manager.deleteLoop(loop.config.id);

      const updated = await ctx.manager.getLoop(loop.config.id);
      expect(updated!.state.status).toBe("deleted");
    });

    test("stopLoop works for a running chat", async () => {
      // Use a backend that never completes to keep the chat in running state
      const neverCompletingBackend = new NeverCompletingMockBackend();
      backendManager.setBackendForTesting(neverCompletingBackend);

      const loop = await ctx.manager.createChat({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Long-running chat",
        workspaceId: testWorkspaceId,
      });

      // Wait for the chat to be running
      await waitForLoopStatus(ctx.manager, loop.config.id, ["running"]);

      // Stop the chat
      await ctx.manager.stopLoop(loop.config.id);

      const updated = await ctx.manager.getLoop(loop.config.id);
      expect(updated!.state.status).toBe("stopped");
    });
  });
});
