/**
 * Integration tests for branch safety with worktrees.
 * With per-task worktrees, tasks never modify the source checkout.
 * These tests verify that task operations work correctly regardless
 * of the source checkout's branch state (worktree isolation).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  remoteBranchExists,
  assertTaskState,
  waitForGitAvailable,
  type TestServerContext,
} from "./helpers";
import type { Task } from "@/shared/task";
import { runGit } from "../../helpers/git-fixtures";

describe("Branch Safety - Worktree Isolation", () => {
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

    test("discard succeeds even when user is on a different branch in source checkout", async () => {
      // Get the original branch
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create a third unrelated branch in the source checkout
      await runGit(ctx.workDir, ["checkout", "-b", "unrelated-branch"]);
      await writeFile(join(ctx.workDir, "unrelated.txt"), "unrelated content");
      await runGit(ctx.workDir, ["add", "."]);
      await runGit(ctx.workDir, ["commit", "-m", "Unrelated commit"]);

      // Switch back to original to create task
      await runGit(ctx.workDir, ["checkout", originalBranch]);

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

      // Now switch to the unrelated branch in source checkout
      await waitForGitAvailable(ctx.workDir);
      await runGit(ctx.workDir, ["checkout", "unrelated-branch"]);
      expect(await getCurrentBranch(ctx.workDir)).toBe("unrelated-branch");

      // Discard should still work - worktree is independent of source checkout
      const { status, body: discardBody } = await discardTaskViaAPI(ctx.baseUrl, task.config.id);

      expect(status).toBe(200);
      expect(discardBody.success).toBe(true);

      // Source checkout stays on whatever branch the user left it on
      expect(await getCurrentBranch(ctx.workDir)).toBe("unrelated-branch");

      // Clean up the unrelated branch
      await runGit(ctx.workDir, ["checkout", originalBranch]);
      await runGit(ctx.workDir, ["branch", "-D", "unrelated-branch"]);
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

    test("accept succeeds regardless of source checkout branch state", async () => {
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

      // Source checkout stays on original branch (worktree isolation)
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Accept should work - merge happens on the source repository
      const { status, body: acceptBody } = await acceptTaskViaAPI(ctx.baseUrl, task.config.id);

      expect(status).toBe(200);
      expect(acceptBody.success).toBe(true);

      // Source checkout stays on original branch after merge
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

    test("push succeeds regardless of source checkout branch state", async () => {
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

      // Source checkout stays on original branch (worktree isolation)
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
