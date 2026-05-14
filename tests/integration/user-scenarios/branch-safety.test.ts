/**
 * Integration tests for branch safety with worktrees.
 * With per-loop worktrees, loops never modify the main checkout.
 * These tests verify that loop operations work correctly regardless
 * of the main checkout's branch state (worktree isolation).
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { writeFile } from "fs/promises";
import { join } from "path";
import {
  setupTestServer,
  teardownTestServer,
  createLoopViaAPI,
  waitForLoopStatus,
  acceptLoopViaAPI,
  pushLoopViaAPI,
  discardLoopViaAPI,
  getCurrentBranch,
  branchExists,
  remoteBranchExists,
  assertLoopState,
  waitForGitAvailable,
  type TestServerContext,
} from "./helpers";
import type { Loop } from "../../../src/types/loop";

describe("Branch Safety - Worktree Isolation", () => {
  describe("Loop commits correctly with worktree isolation", () => {
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

    test("loop completes without modifying main checkout branch", async () => {
      // Get the original branch before creating the loop
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create loop
      const { status, body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Complete a multi-step task",
        planMode: false,
      });

      expect(status).toBe(201);
      const loop = body as Loop;

      // Wait for completion
      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");

      // Validate the loop completed successfully
      assertLoopState(completedLoop, {
        status: "completed",
        hasGitBranch: true,
        hasError: false,
      });

      // Main checkout should still be on the original branch (worktree isolation)
      const currentBranch = await getCurrentBranch(ctx.workDir);
      expect(currentBranch).toBe(originalBranch);

      // The working branch should exist (checked out in the worktree)
      expect(await branchExists(ctx.workDir, completedLoop.state.git!.workingBranch)).toBe(true);

      // Clean up
      await discardLoopViaAPI(ctx.baseUrl, loop.config.id);
    });
  });

  describe("Loop discard with worktree isolation", () => {
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

      // Create and wait for loop completion
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false,
      });
      const loop = body as Loop;

      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");

      // Main checkout stays on original branch (worktree isolation)
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Discard the loop
      const { status, body: discardBody } = await discardLoopViaAPI(ctx.baseUrl, loop.config.id);

      expect(status).toBe(200);
      expect(discardBody.success).toBe(true);

      // Main checkout still on original branch
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Verify the loop state is now "deleted"
      const deletedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "deleted");
      assertLoopState(deletedLoop, {
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

      // Switch back to original to create loop
      await Bun.$`git -C ${ctx.workDir} checkout ${originalBranch}`.quiet();

      // Reset mock for this test
      ctx.mockBackend.reset([
        "Working...",
        "Done! <promise>COMPLETE</promise>",
      ]);

      // Create and wait for loop completion
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false,
      });
      const loop = body as Loop;

      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");

      // Now switch to the unrelated branch in main checkout
      await waitForGitAvailable(ctx.workDir);
      await Bun.$`git -C ${ctx.workDir} checkout unrelated-branch`.quiet();
      expect(await getCurrentBranch(ctx.workDir)).toBe("unrelated-branch");

      // Discard should still work - worktree is independent of main checkout
      const { status, body: discardBody } = await discardLoopViaAPI(ctx.baseUrl, loop.config.id);

      expect(status).toBe(200);
      expect(discardBody.success).toBe(true);

      // Main checkout stays on whatever branch the user left it on
      expect(await getCurrentBranch(ctx.workDir)).toBe("unrelated-branch");

      // Clean up the unrelated branch
      await Bun.$`git -C ${ctx.workDir} checkout ${originalBranch}`.quiet();
      await Bun.$`git -C ${ctx.workDir} branch -D unrelated-branch`.quiet();
    });
  });

  describe("Accept loop with worktree isolation", () => {
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

      // Create and wait for loop completion
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false,
      });
      const loop = body as Loop;

      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");

      // Main checkout stays on original branch (worktree isolation)
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Accept should work - merge happens on the main repo
      const { status, body: acceptBody } = await acceptLoopViaAPI(ctx.baseUrl, loop.config.id);

      expect(status).toBe(200);
      expect(acceptBody.success).toBe(true);

      // Main checkout stays on original branch after merge
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Verify the loop state is now "merged"
      const mergedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "accepted_local");
      assertLoopState(mergedLoop, {
        status: "accepted_local",
        hasError: false,
      });
    });
  });

  describe("Push loop with worktree isolation", () => {
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

      // Create and wait for loop completion
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false,
      });
      const loop = body as Loop;

      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      const workingBranch = completedLoop.state.git!.workingBranch;

      // Main checkout stays on original branch (worktree isolation)
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Push should work from the worktree
      const { status, body: pushBody } = await pushLoopViaAPI(ctx.baseUrl, loop.config.id);

      expect(status).toBe(200);
      expect(pushBody.success).toBe(true);
      expect(pushBody.remoteBranch).toBeDefined();

      // Verify the branch exists on the remote
      expect(await remoteBranchExists(ctx.workDir, workingBranch)).toBe(true);

      // Verify the loop state is now "pushed"
      const pushedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "pushed");
      assertLoopState(pushedLoop, {
        status: "pushed",
        hasError: false,
      });

      // Clean up
      await discardLoopViaAPI(ctx.baseUrl, loop.config.id);
    });
  });
});
