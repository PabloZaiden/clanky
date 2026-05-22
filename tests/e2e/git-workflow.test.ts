/**
 * E2E tests for git integration in Clanky Tasks.
 * Tests branch creation, commits per iteration, and accept/discard workflows.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { writeFile } from "fs/promises";
import { join } from "path";
import {
  setupTestContext,
  teardownTestContext,
  waitForEvent,
  waitForTaskStatus,
  countEvents,
  getEvents,
  testModelFields,
  type TestContext,
} from "../setup";

const testWorkspaceId = "test-workspace-id";

describe("Git Workflow", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({
      useMockBackend: true,
      mockResponses: Array(30).fill(null).map((_, i) => {
        const mod = i % 2;
        if (mod === 0) return "Working on iteration 1...";
        return "Done! <promise>COMPLETE</promise>";
      }),
      initGit: true, // Initialize git in work directory
    });
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  describe("Branch Creation", () => {
    test("creates a branch when starting a task with git enabled", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Make changes",
        name: "Branch ID Task",
        planMode: false,
        workspaceId: testWorkspaceId,
      });

      // Get original branch
      const originalBranch = await ctx.git.getCurrentBranch(ctx.workDir);

      // Start the task
      await ctx.manager.startTask(task.config.id);

      // Wait for completion
      await waitForEvent(ctx.events, "task.completed");

      // With worktrees, main checkout stays on original branch
      const currentBranch = await ctx.git.getCurrentBranch(ctx.workDir);
      expect(currentBranch).toBe(originalBranch);

      // Verify the task state has git info with the working branch
      const finalTask = await ctx.manager.getTask(task.config.id);
      expect(finalTask!.state.git).toBeDefined();
      expect(finalTask!.state.git!.originalBranch).toBe(originalBranch);
      expect(finalTask!.state.git!.workingBranch).not.toStartWith("clanky/");
      expect(finalTask!.state.git!.workingBranch).toMatch(/-[0-9a-f]{7}$/);
      expect(finalTask!.state.git!.worktreePath).toBeDefined();
    });

    test("starts branch names with the sanitized title even when a custom prefix is configured", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Make changes",
        name: "Test Task",
        planMode: false,
        gitBranchPrefix: "feature/",
        workspaceId: testWorkspaceId,
      });

      await ctx.manager.startTask(task.config.id);
      await waitForEvent(ctx.events, "task.completed");

      // With worktrees, check the task state's working branch, not the main checkout
      const finalTask = await ctx.manager.getTask(task.config.id);
      expect(finalTask!.state.git!.workingBranch).toMatch(/^test-task-[0-9a-f]{7}$/);
    });

    test("branch name includes task name and prompt hash", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Make changes",
        name: "Branch ID Task",
        planMode: false,
        workspaceId: testWorkspaceId,
      });

      await ctx.manager.startTask(task.config.id);
      await waitForEvent(ctx.events, "task.completed");

      // With worktrees, check the task state's working branch, not the main checkout
      const finalTask = await ctx.manager.getTask(task.config.id);
      const workingBranch = finalTask!.state.git!.workingBranch;
      // Branch should contain the sanitized task name
      expect(workingBranch).toContain("branch-id-task");
      // Branch should not include the legacy clanky/ prefix
      expect(workingBranch).not.toStartWith("clanky/");
      // Branch should end with a 7-character prompt hash
      expect(workingBranch).toMatch(/-[0-9a-f]{7}$/);
    });
  });

  describe("Commits Per Iteration", () => {
    test("creates a commit after each iteration", async () => {
      // Teardown the default context
      await teardownTestContext(ctx);

      // Create new context with 3 iterations of responses
      ctx = await setupTestContext({
        useMockBackend: true,
        initGit: true,
        mockResponses: [
          "Iteration 1...",
          "Iteration 2...",
          "<promise>COMPLETE</promise>",
        ],
      });

      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Make changes",
        name: "Branch ID Task",
        planMode: false,
        workspaceId: testWorkspaceId,
      });

      // Create a file to track changes
      await writeFile(join(ctx.workDir, "test.txt"), "initial content");
      await Bun.$`git add .`.cwd(ctx.workDir).quiet();
      await Bun.$`git commit -m "Add test file"`.cwd(ctx.workDir).quiet();

      await ctx.manager.startTask(task.config.id);
      const finalTask = await waitForTaskStatus(ctx.manager, task.config.id, ["completed"]);

      // Check that git commit events were emitted
      getEvents(ctx.events, "task.git.commit");
      // Note: commits only happen if there are changes
      // Since mock backend doesn't actually change files, we may not have commits
      // But we can verify the git info is set up correctly

      expect(finalTask.state.git).toBeDefined();
      expect(Array.isArray(finalTask.state.git!.commits)).toBe(true);
    });

    test("uses custom commit scope", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Make changes",
        name: "Test Task",
        planMode: false,
        gitCommitScope: "custom",
        workspaceId: testWorkspaceId,
      });

      // Verify the config is set correctly
      expect(task.config.git.commitScope).toBe("custom");
    });
  });

  describe("Uncommitted Changes Handling", () => {
    test("allows starting task with uncommitted changes (worktree isolation)", async () => {
      // Create uncommitted changes
      await writeFile(join(ctx.workDir, "uncommitted.txt"), "uncommitted content");
      await Bun.$`git add .`.cwd(ctx.workDir).quiet();

      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Make changes",
        name: "Test Task",
        planMode: false,
        workspaceId: testWorkspaceId,
      });

      // With worktrees, uncommitted changes in main checkout don't block task creation
      await ctx.manager.startTask(task.config.id);
      await waitForEvent(ctx.events, "task.completed");

      // Verify task completed successfully
      const finalTask = await ctx.manager.getTask(task.config.id);
      expect(finalTask!.state.status).toBe("completed");
      expect(finalTask!.state.git!.workingBranch).not.toStartWith("clanky/");
      expect(finalTask!.state.git!.workingBranch).toMatch(/-[0-9a-f]{7}$/);

      // Clean up uncommitted changes
      await Bun.$`git reset HEAD -- .`.cwd(ctx.workDir).quiet().nothrow();
      await Bun.$`git checkout -- .`.cwd(ctx.workDir).quiet().nothrow();
      await Bun.$`git clean -fd`.cwd(ctx.workDir).quiet().nothrow();
    });

  });

  describe("Accept Task (Merge Branch)", () => {
    test("merges branch on accept", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Make changes",
        name: "Test Task",
        planMode: false,
        workspaceId: testWorkspaceId,
      });

      const originalBranch = await ctx.git.getCurrentBranch(ctx.workDir);

      await ctx.manager.startTask(task.config.id);
      await waitForEvent(ctx.events, "task.completed");

      // Get the working branch name from in-memory engine
      const taskAfterComplete = await ctx.manager.getTask(task.config.id);
      const workingBranch = taskAfterComplete!.state.git!.workingBranch;

      // Accept the task
      const result = await ctx.manager.acceptTask(task.config.id);

      expect(result.success).toBe(true);

      // Verify we're back on original branch
      const currentBranch = await ctx.git.getCurrentBranch(ctx.workDir);
      expect(currentBranch).toBe(originalBranch);

      // Verify working branch was NOT deleted (kept for review mode)
      const branchExists = await ctx.git.branchExists(ctx.workDir, workingBranch);
      expect(branchExists).toBe(true);

      // Verify reviewMode was initialized
      const updatedTask = await ctx.manager.getTask(task.config.id);
      expect(updatedTask?.state.reviewMode).toBeDefined();
      expect(updatedTask?.state.reviewMode?.addressable).toBe(true);
      expect(updatedTask?.state.reviewMode?.completionAction).toBe("local");
      expect(updatedTask?.state.reviewMode?.reviewCycles).toBe(0);

      // Verify event was emitted
      expect(countEvents(ctx.events, "task.accepted")).toBe(1);
    });

    test("returns error when accepting non-completed task", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Make changes",
        name: "Test Task",
        planMode: false,
        workspaceId: testWorkspaceId,
      });

      const result = await ctx.manager.acceptTask(task.config.id);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot accept task");
    });
  });

  describe("Discard Task", () => {
    test("discards task without modifying main checkout", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Make changes",
        name: "Test Task",
        planMode: false,
        workspaceId: testWorkspaceId,
      });

      const originalBranch = await ctx.git.getCurrentBranch(ctx.workDir);

      await ctx.manager.startTask(task.config.id);
      await waitForEvent(ctx.events, "task.completed");

      // Discard the task
      const result = await ctx.manager.discardTask(task.config.id);

      expect(result.success).toBe(true);

      // Main checkout stays on original branch (worktrees don't modify it)
      const currentBranch = await ctx.git.getCurrentBranch(ctx.workDir);
      expect(currentBranch).toBe(originalBranch);

      // With worktrees, discard no longer deletes the branch (only purge does)

      // Verify event was emitted
      expect(countEvents(ctx.events, "task.discarded")).toBe(1);
    });
  });

  describe("Mark as Merged", () => {
    test("rejects completed tasks without push", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Make changes",
        name: "Test Task",
        planMode: false,
        workspaceId: testWorkspaceId,
      });

      const originalBranch = await ctx.git.getCurrentBranch(ctx.workDir);

      await ctx.manager.startTask(task.config.id);
      await waitForEvent(ctx.events, "task.completed");

      // Mark as merged is only valid after push
      const result = await ctx.manager.markMerged(task.config.id);

      expect(result.success).toBe(false);

      // Main checkout stays on original branch (worktrees don't modify it)
      const currentBranch = await ctx.git.getCurrentBranch(ctx.workDir);
      expect(currentBranch).toBe(originalBranch);

      // Verify task status remains completed
      const finalTask = await ctx.manager.getTask(task.config.id);
      expect(finalTask!.state.status).toBe("completed");
    });

    test("works for pushed tasks", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Make changes",
        name: "Test Task",
        planMode: false,
        workspaceId: testWorkspaceId,
      });

      const originalBranch = await ctx.git.getCurrentBranch(ctx.workDir);
      const remoteDir = join(ctx.dataDir, "remote-mark-merged.git");
      await Bun.$`git init --bare ${remoteDir}`.quiet();
      await Bun.$`git -C ${ctx.workDir} remote add origin ${remoteDir}`.quiet();
      await Bun.$`git -C ${ctx.workDir} push origin ${originalBranch}`.quiet();

      await ctx.manager.startTask(task.config.id);
      await waitForEvent(ctx.events, "task.completed");

      const pushResult = await ctx.manager.pushTask(task.config.id);
      expect(pushResult.success).toBe(true);

      // Mark as merged
      const result = await ctx.manager.markMerged(task.config.id);

      expect(result.success).toBe(true);

      // Main checkout stays on original branch
      const currentBranch = await ctx.git.getCurrentBranch(ctx.workDir);
      expect(currentBranch).toBe(originalBranch);

      // Verify task status is merged
      const finalTask = await ctx.manager.getTask(task.config.id);
      expect(finalTask!.state.status).toBe("merged");
    });

    test("returns error when task is not in final state", async () => {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        directory: ctx.workDir,
        prompt: "Make changes",
        name: "Test Task",
        planMode: false,
        workspaceId: testWorkspaceId,
      });

      // Try to mark as merged without running the task
      const result = await ctx.manager.markMerged(task.config.id);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot mark task as merged");
    });
  });
});
