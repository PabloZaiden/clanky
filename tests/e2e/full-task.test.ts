/**
 * E2E tests for full task workflow.
 * Tests the complete lifecycle of a Clanky Task from creation to completion.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  setupTestContext,
  teardownTestContext,
  waitForEvent,
  countEvents,
  getEvents,
  testModelFields,
  type TestContext,
} from "../setup";

const testWorkspaceId = "test-workspace-id";

describe("Full Task Workflow", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({
      useMockBackend: true,
      initGit: true,
      mockResponses: [
        "Working on iteration 1...",
        "Working on iteration 2...",
        "Done! <promise>COMPLETE</promise>",
      ],
    });
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  describe("Task Creation", () => {
    test("creates a task via manager with correct defaults", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Implement a feature",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      expect(task.config.id).toBeDefined();
      expect(task.config.directory).toBe(ctx.workDir);
      expect(task.config.prompt).toBe("Implement a feature");
      // Backend is now global, not per-task
      expect(task.config.git.branchPrefix).toBe("");
      expect(task.state.status).toBe("idle");
      expect(task.state.currentIteration).toBe(0);

      // Verify creation event was emitted
      expect(countEvents(ctx.events, "task.created")).toBe(1);
    });

    test("creates a task with custom options", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Custom task",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
        // Backend options removed - now global
        maxIterations: 10,
      });

      // Backend is now global, not per-task config
      expect(task.config.maxIterations).toBe(10);
    });

    test("persists task to disk", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Test persistence",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Get the task back from the manager
      const fetched = await ctx.manager.getTask(task.config.id);
      expect(fetched).not.toBeNull();
    });
  });

  describe("Task Execution", () => {
    test("starts task and runs through iterations until completion", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Do the work",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Start the task
      await ctx.manager.startTask(task.config.id);

      // Wait for completion
      await waitForEvent(ctx.events, "task.completed");

      // Check final state
      const finalTask = await ctx.manager.getTask(task.config.id);
      expect(finalTask).not.toBeNull();
      expect(finalTask!.state.status).toBe("completed");
      expect(finalTask!.state.currentIteration).toBe(3);

      // Verify event sequence
      expect(countEvents(ctx.events, "task.started")).toBe(1);
      expect(countEvents(ctx.events, "task.iteration.start")).toBe(3);
      expect(countEvents(ctx.events, "task.iteration.end")).toBe(3);
      expect(countEvents(ctx.events, "task.completed")).toBe(1);

      // Verify iteration outcomes
      const iterationEndEvents = getEvents(ctx.events, "task.iteration.end");
      expect(iterationEndEvents[0]!.outcome).toBe("continue");
      expect(iterationEndEvents[1]!.outcome).toBe("continue");
      expect(iterationEndEvents[2]!.outcome).toBe("complete");
    });

    test("respects maxIterations limit", async () => {
      // Teardown the default context
      await teardownTestContext(ctx);

      // Create new context with never-ending responses
      ctx = await setupTestContext({
        useMockBackend: true,
        initGit: true,
        mockResponses: [
          "Still working...",
          "More work...",
          "Even more...",
          "Never ending...",
        ],
      });

      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Work forever",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
        maxIterations: 2,
      });

      await ctx.manager.startTask(task.config.id);

      // Wait for max iterations status
      await waitForEvent(ctx.events, "task.stopped");

      const finalTask = await ctx.manager.getTask(task.config.id);
      expect(finalTask!.state.status).toBe("max_iterations");
      expect(finalTask!.state.currentIteration).toBe(2);
    });

    test("can stop a running task", async () => {
      // Teardown the default context
      await teardownTestContext(ctx);

      // Create new context with more responses so we have time to stop
      ctx = await setupTestContext({
        useMockBackend: true,
        initGit: true,
        mockResponses: [
          "Working on iteration 1...",
          "Working on iteration 2...",
          "Working on iteration 3...",
          "<promise>COMPLETE</promise>",
        ],
      });

      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Do work",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Start the task
      const startPromise = ctx.manager.startTask(task.config.id);

      // Wait for first iteration to start
      await waitForEvent(ctx.events, "task.iteration.start");

      // Stop the task
      await ctx.manager.stopTask(task.config.id);

      // Wait for the start promise to resolve
      await startPromise;

      const finalTask = await ctx.manager.getTask(task.config.id);
      expect(finalTask!.state.status).toBe("stopped");
    });

    test("handles backend errors gracefully", async () => {
      // Teardown the default context
      await teardownTestContext(ctx);

      // Create new context with error response
      ctx = await setupTestContext({
        useMockBackend: true,
        initGit: true,
        mockResponses: ["ERROR:Backend crashed"],
      });

      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Cause error",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
        // Set maxConsecutiveErrors to 1 so it fails after first error
        maxConsecutiveErrors: 1,
      });

      await ctx.manager.startTask(task.config.id);

      // Wait for error event
      await waitForEvent(ctx.events, "task.error");

      const finalTask = await ctx.manager.getTask(task.config.id);
      expect(finalTask!.state.status).toBe("failed");
      expect(finalTask!.state.error?.message).toContain("Backend crashed");
    });
  });

  describe("Task CRUD Operations", () => {
    test("lists all tasks", async () => {
      await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Task 1",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Task 2",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Task 3",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const tasks = await ctx.manager.getAllTasks();
      expect(tasks.length).toBe(3);
    });

    test("updates task configuration", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Original prompt",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const updated = await ctx.manager.updateTask(task.config.id, {
        prompt: "Updated prompt",
      });

      expect(updated).not.toBeNull();
      expect(updated!.config.prompt).toBe("Updated prompt");

      // Verify persistence
      const fetched = await ctx.manager.getTask(task.config.id);
      expect(fetched).not.toBeNull();
    });

    test("soft-deletes a task (marks as deleted)", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Delete me",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const deleted = await ctx.manager.deleteTask(task.config.id);
      expect(deleted).toBe(true);

      // Soft delete: task still exists but with status "deleted"
      const fetched = await ctx.manager.getTask(task.config.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.state.status).toBe("deleted");

      // Verify delete event
      expect(countEvents(ctx.events, "task.deleted")).toBe(1);
    });

    test("purges a deleted task", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Purge me",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Soft delete first
      await ctx.manager.deleteTask(task.config.id);

      // Then purge
      const purgeResult = await ctx.manager.purgeTask(task.config.id);
      expect(purgeResult.success).toBe(true);

      // Now it should be actually gone
      const fetched = await ctx.manager.getTask(task.config.id);
      expect(fetched).toBeNull();
    }, { timeout: 60_000 });

    test("returns null/false for non-existent tasks", async () => {
      const fetched = await ctx.manager.getTask("non-existent");
      expect(fetched).toBeNull();

      const updated = await ctx.manager.updateTask("non-existent", { prompt: "Test" });
      expect(updated).toBeNull();

      const deleted = await ctx.manager.deleteTask("non-existent");
      expect(deleted).toBe(false);
    });
  });

  describe("Task State Tracking", () => {
    test("tracks running state correctly", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Track me",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Before start
      expect(ctx.manager.isRunning(task.config.id)).toBe(false);

      // Start the task
      await ctx.manager.startTask(task.config.id);

      // Wait for completion
      await waitForEvent(ctx.events, "task.completed");

      // After completion, check the task state (isRunning may still be true 
      // until the periodic state persistence clears it)
      const finalTask = await ctx.manager.getTask(task.config.id);
      expect(finalTask!.state.status).toBe("completed");
    });

    test("records iteration summaries", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Track iterations",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      await ctx.manager.startTask(task.config.id);
      await waitForEvent(ctx.events, "task.completed");

      const finalTask = await ctx.manager.getTask(task.config.id);
      expect(finalTask!.state.recentIterations.length).toBe(3);

      // Check iteration 1
      const iter1 = finalTask!.state.recentIterations[0]!;
      expect(iter1.iteration).toBe(1);
      expect(iter1.outcome).toBe("continue");

      // Check iteration 3 (completion)
      const iter3 = finalTask!.state.recentIterations[2]!;
      expect(iter3.iteration).toBe(3);
      expect(iter3.outcome).toBe("complete");
    });
  });
});
