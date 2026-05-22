/**
 * Integration tests for branch safety with worktrees.
 * With per-task worktrees, tasks never modify the main checkout.
 * These tests verify that task operations work correctly regardless
 * of the main checkout's branch state (worktree isolation).
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { writeFile } from "fs/promises";
import { join } from "path";
import {
  setupTestServer,
  teardownTestServer,
  createTaskViaAPI,
  waitForTaskStatus,
  acceptTaskViaAPI,
  pushTaskViaAPI,
  discardTaskViaAPI,
  getCurrentBranch,
  branchExists,
  remoteBranchExists,
  assertTaskState,
  waitForGitAvailable,
  type TestServerContext,
} from "./helpers";
import type { Task } from "../../../src/types/task";

describe("Branch Safety - Worktree Isolation", () => {
  describe("Task commits correctly with worktree isolation", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "Working on iteration 1...",
          "Working on iteration 2...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("task completes without modifying main checkout branch", async () => {
      // Get the original branch before creating the task
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create task
      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Complete a multi-step task",
        planMode: false,
      });

      expect(status).toBe(201);
      const task = body as Task;

      // Wait for completion
      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

      // Validate the task completed successfully
      assertTaskState(completedTask, {
        status: "completed",
        hasGitBranch: true,
        hasError: false,
      });

      // Main checkout should still be on the original branch (worktree isolation)
      const currentBranch = await getCurrentBranch(ctx.workDir);
      expect(currentBranch).toBe(originalBranch);

      // The working branch should exist (checked out in the worktree)
      expect(await branchExists(ctx.workDir, completedTask.state.git!.workingBranch)).toBe(true);

      // Clean up
      await discardTaskViaAPI(ctx.baseUrl, task.config.id);
    });
  });

  describe("Task discard with worktree isolation", () => {
    let ctx: TestServerContext;

    beforeEach(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "Working...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterEach(async () => {
      await teardownTestServer(ctx);
    });

    test("discard succeeds and main checkout stays unchanged", async () => {
      // Get the original branch
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create and wait for task completion
      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false,
      });
      const task = body as Task;

      await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

      // Main checkout stays on original branch (worktree isolation)
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Discard the task
      const { status, body: discardBody } = await discardTaskViaAPI(ctx.baseUrl, task.config.id);

      expect(status).toBe(200);
      expect(discardBody.success).toBe(true);

      // Main checkout still on original branch
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Verify the task state is now "deleted"
      const deletedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "deleted");
      assertTaskState(deletedTask, {
        status: "deleted",
        hasError: false,
      });
    });

    test("discard succeeds even when user is on a different branch in main checkout", async () => {
      // Get the original branch
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create a third unrelated branch in the main checkout
      await Bun.$`git -C ${ctx.workDir} checkout -b unrelated-branch`.quiet();
      await writeFile(join(ctx.workDir, "unrelated.txt"), "unrelated content");
      await Bun.$`git -C ${ctx.workDir} add .`.quiet();
      await Bun.$`git -C ${ctx.workDir} commit -m "Unrelated commit"`.quiet();

      // Switch back to original to create task
      await Bun.$`git -C ${ctx.workDir} checkout ${originalBranch}`.quiet();

      // Reset mock for this test
      ctx.mockBackend.reset([
        "Working...",
        "Done! <promise>COMPLETE</promise>",
      ]);

      // Create and wait for task completion
      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false,
      });
      const task = body as Task;

      await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

      // Now switch to the unrelated branch in main checkout
      await waitForGitAvailable(ctx.workDir);
      await Bun.$`git -C ${ctx.workDir} checkout unrelated-branch`.quiet();
      expect(await getCurrentBranch(ctx.workDir)).toBe("unrelated-branch");

      // Discard should still work - worktree is independent of main checkout
      const { status, body: discardBody } = await discardTaskViaAPI(ctx.baseUrl, task.config.id);

      expect(status).toBe(200);
      expect(discardBody.success).toBe(true);

      // Main checkout stays on whatever branch the user left it on
      expect(await getCurrentBranch(ctx.workDir)).toBe("unrelated-branch");

      // Clean up the unrelated branch
      await Bun.$`git -C ${ctx.workDir} checkout ${originalBranch}`.quiet();
      await Bun.$`git -C ${ctx.workDir} branch -D unrelated-branch`.quiet();
    });
  });

  describe("Accept task with worktree isolation", () => {
    let ctx: TestServerContext;

    beforeEach(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "Working...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterEach(async () => {
      await teardownTestServer(ctx);
    });

    test("accept succeeds regardless of main checkout branch state", async () => {
      // Get the original branch
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create and wait for task completion
      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false,
      });
      const task = body as Task;

      await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

      // Main checkout stays on original branch (worktree isolation)
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Accept should work - merge happens on the main repo
      const { status, body: acceptBody } = await acceptTaskViaAPI(ctx.baseUrl, task.config.id);

      expect(status).toBe(200);
      expect(acceptBody.success).toBe(true);

      // Main checkout stays on original branch after merge
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Verify the task state is now "merged"
      const mergedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "accepted_local");
      assertTaskState(mergedTask, {
        status: "accepted_local",
        hasError: false,
      });
    });
  });

  describe("Push task with worktree isolation", () => {
    let ctx: TestServerContext;

    beforeEach(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "Working...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
        withRemote: true,
      });
    });

    afterEach(async () => {
      await teardownTestServer(ctx);
    });

    test("push succeeds regardless of main checkout branch state", async () => {
      // Verify we have a remote configured
      expect(ctx.remoteDir).toBeDefined();

      // Get the original branch
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create and wait for task completion
      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false,
      });
      const task = body as Task;

      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      const workingBranch = completedTask.state.git!.workingBranch;

      // Main checkout stays on original branch (worktree isolation)
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Push should work from the worktree
      const { status, body: pushBody } = await pushTaskViaAPI(ctx.baseUrl, task.config.id);

      expect(status).toBe(200);
      expect(pushBody.success).toBe(true);
      expect(pushBody.remoteBranch).toBeDefined();

      // Verify the branch exists on the remote
      expect(await remoteBranchExists(ctx.workDir, workingBranch)).toBe(true);

      // Verify the task state is now "pushed"
      const pushedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "pushed");
      assertTaskState(pushedTask, {
        status: "pushed",
        hasError: false,
      });

      // Clean up
      await discardTaskViaAPI(ctx.baseUrl, task.config.id);
    });
  });
});
