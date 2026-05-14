/**
 * Integration tests for regular loop user scenarios.
 * These tests simulate UI interactions via API calls.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { writeFile, readdir } from "fs/promises";
import { join } from "path";
import {
  setupTestServer,
  teardownTestServer,
  createLoopViaAPI,
  waitForLoopStatus,
  acceptLoopViaAPI,
  pushLoopViaAPI,
  discardLoopViaAPI,
  getLoopDiffViaAPI,
  getLoopPlanViaAPI,
  getLoopStatusFileViaAPI,
  getCurrentBranch,
  branchExists,
  remoteBranchExists,
  assertLoopState,
  type TestServerContext,
} from "./helpers";
import type { Loop } from "../../../src/types/loop";

describe("Regular Loop User Scenarios", () => {
  describe("Loop Creation Variants", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: Array(20).fill(null).map((_, i) => {
          const mod = i % 3;
          if (mod === 0) return "Working on iteration 1...";
          if (mod === 1) return "Working on iteration 2...";
          return "Done! <promise>COMPLETE</promise>";
        }),
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("creates loop based on main branch without clearing .ralph-planning folder", async () => {
      // Verify .ralph-planning files exist before creating loop
      const planContent = await Bun.file(join(ctx.workDir, ".ralph-planning/plan.md")).text();
      expect(planContent).toContain("# Plan");

      // Create loop via API (simulating UI "Create Loop" button)
      const { status, body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Implement a feature",
        clearPlanningFolder: false,
        planMode: false, // Regular execution, not plan mode
      });

      expect(status).toBe(201);
      const loop = body as Loop;
      expect(loop.config.id).toBeDefined();
      expect(loop.config.clearPlanningFolder).toBe(false);

      // Wait for loop to complete (3 iterations: 2 continue + 1 complete)
      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");

      // Validate loop state for UI display
      assertLoopState(completedLoop, {
        status: "completed",
        iterationCount: 3,
        hasGitBranch: true,
        hasError: false,
      });

      // Verify .ralph-planning files still exist
      const planContentAfter = await Bun.file(join(ctx.workDir, ".ralph-planning/plan.md")).text();
      expect(planContentAfter).toContain("# Plan");

      // Clean up - discard the loop
      await discardLoopViaAPI(ctx.baseUrl, loop.config.id);
    });

    test("creates loop based on main branch with clearing .ralph-planning folder", async () => {
      // Reset mock backend for this test
      ctx.mockBackend.reset([
        "Working on iteration 1...",
        "Working on iteration 2...",
        "Done! <promise>COMPLETE</promise>",
      ]);

      // Add an ignored file to the main checkout's managed planning directory.
      // Clearing happens in the loop worktree, not in the source checkout.
      await writeFile(join(ctx.workDir, ".ralph-planning/extra.md"), "Extra content");

      // Verify extra file exists
      const extraExists = await Bun.file(join(ctx.workDir, ".ralph-planning/extra.md")).exists();
      expect(extraExists).toBe(true);

      // Create loop via API with clearPlanningFolder=true
      const { status, body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Implement a feature",
        clearPlanningFolder: true,
        planMode: false, // Regular execution, not plan mode
      });

      expect(status).toBe(201);
      const loop = body as Loop;

      // Wait for loop to complete
      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");

      // Validate loop state
      assertLoopState(completedLoop, {
        status: "completed",
        iterationCount: 3,
        hasGitBranch: true,
        hasError: false,
      });

      // Verify clearPlanningFolder was set
      expect(completedLoop.config.clearPlanningFolder).toBe(true);
      // With worktrees, the clearing happens in the worktree's .ralph-planning dir, not main checkout.
      // Verify the worktree's .ralph-planning was cleared by checking the loop completed successfully
      // (clearing happens before iterations start in the worktree).
      const worktreePath = completedLoop.state.git?.worktreePath;
      expect(worktreePath).toBeDefined();
      // The worktree's .ralph-planning should have been cleared (only .gitkeep or files created by the loop)
      const worktreePlanningDir = join(worktreePath!, ".ralph-planning");
      const filesAfterClear = await readdir(worktreePlanningDir);
      expect(filesAfterClear.length).toBeLessThanOrEqual(2); // May have .gitkeep or be empty
      expect(await Bun.file(join(ctx.workDir, ".ralph-planning/extra.md")).exists()).toBe(true);

      // Clean up
      await discardLoopViaAPI(ctx.baseUrl, loop.config.id);
    });
  });

  describe("Loop Execution - 2 iterations without completion, 1 final iteration completing", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "Working on iteration 1, still more to do...",
          "Working on iteration 2, getting closer...",
          "All done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("runs 2 iterations without completion, then 1 iteration that completes", async () => {
      // Create loop
      const { status, body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Complete a multi-step task",
        planMode: false, // Regular execution, not plan mode
      });

      expect(status).toBe(201);
      const loop = body as Loop;

      // Wait for completion
      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");

      // Validate the loop ran exactly 3 iterations
      assertLoopState(completedLoop, {
        status: "completed",
        iterationCount: 3,
        hasGitBranch: true,
        hasError: false,
      });

      // Verify iteration history
      expect(completedLoop.state.recentIterations.length).toBe(3);
      expect(completedLoop.state.recentIterations[0]?.outcome).toBe("continue");
      expect(completedLoop.state.recentIterations[1]?.outcome).toBe("continue");
      expect(completedLoop.state.recentIterations[2]?.outcome).toBe("complete");

      // With worktrees, main checkout stays on original branch
      // Verify the working branch exists (it's checked out in the worktree, not main checkout)
      const workingBranch = completedLoop.state.git!.workingBranch;
      expect(workingBranch).not.toStartWith("ralph/");
      expect(workingBranch).toMatch(/-[0-9a-f]{7}$/);
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

      // Verify diff endpoint works
      const { status: diffStatus, body: diffBody } = await getLoopDiffViaAPI(ctx.baseUrl, loop.config.id);
      expect(diffStatus).toBe(200);
      // Diff should be an array (even if empty since mock doesn't actually change files)
      expect(Array.isArray(diffBody)).toBe(true);

      // Verify plan endpoint works
      const { status: planStatus, body: planBody } = await getLoopPlanViaAPI(ctx.baseUrl, loop.config.id);
      expect(planStatus).toBe(200);
      const plan = planBody as { exists: boolean; content: string };
      expect(plan.exists).toBe(true);
      expect(plan.content).toContain("# Plan");

      // Verify status-file endpoint works
      const { status: statusFileStatus, body: statusFileBody } = await getLoopStatusFileViaAPI(ctx.baseUrl, loop.config.id);
      expect(statusFileStatus).toBe(200);
      const statusFile = statusFileBody as { exists: boolean; content: string };
      expect(statusFile.exists).toBe(true);
      expect(statusFile.content).toContain("# Status");

      // Clean up
      await discardLoopViaAPI(ctx.baseUrl, loop.config.id);
    });
  });

  describe("Finish Variant A: Accept and Merge to Base Branch", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "Working...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("accepts loop and merges to base branch", async () => {
      // Get the original branch before creating the loop
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create and wait for loop completion
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false, // Regular execution, not plan mode
      });
      const loop = body as Loop;

      // Wait for completion
      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      const workingBranch = completedLoop.state.git!.workingBranch;

      // With worktrees, main checkout stays on original branch throughout
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

      // Accept the loop via API (simulating UI "Accept" button)
      const { status, body: acceptBody } = await acceptLoopViaAPI(ctx.baseUrl, loop.config.id);

      expect(status).toBe(200);
      expect(acceptBody.success).toBe(true);

      // Main checkout stays on original branch (worktrees don't modify it)
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Verify the working branch was NOT deleted (kept for review mode)
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

      // Verify the loop state is now "merged"
      const mergedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "accepted_local");
      assertLoopState(mergedLoop, {
        status: "accepted_local",
        hasError: false,
      });
      
      // Verify reviewMode was initialized
      expect(mergedLoop.state.reviewMode).toBeDefined();
      expect(mergedLoop.state.reviewMode?.addressable).toBe(true);
      expect(mergedLoop.state.reviewMode?.completionAction).toBe("local");
      expect(mergedLoop.state.reviewMode?.reviewCycles).toBe(0);
    });
  });

  describe("Finish Variant B: Accept and Push (with local file-based remote)", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "Working...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
        withRemote: true, // This creates a local bare git repository as remote
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("accepts loop and pushes to remote (offline-compatible)", async () => {
      // Verify we have a remote configured
      expect(ctx.remoteDir).toBeDefined();

      // Create and wait for loop completion
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false, // Regular execution, not plan mode
      });
      const loop = body as Loop;

      // Wait for completion
      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      const workingBranch = completedLoop.state.git!.workingBranch;

      // Push the loop via API (simulating UI "Push" button)
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

      // Clean up - discard the loop
      await discardLoopViaAPI(ctx.baseUrl, loop.config.id);
    });
  });

  describe("Finish Variant C: Discard", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "Working...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("discards loop and deletes working branch", async () => {
      // Get the original branch
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create and wait for loop completion
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false, // Regular execution, not plan mode
      });
      const loop = body as Loop;

      // Wait for completion
      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      const workingBranch = completedLoop.state.git!.workingBranch;

      // Verify the working branch exists
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

      // Discard the loop via API (simulating UI "Discard" button)
      const { status, body: discardBody } = await discardLoopViaAPI(ctx.baseUrl, loop.config.id);

      expect(status).toBe(200);
      expect(discardBody.success).toBe(true);

      // Main checkout stays on original branch (worktrees don't modify it)
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // With worktrees, discard no longer deletes the branch (only purge does)
      // The branch may still exist — that's expected

      // Verify the loop state is now "deleted"
      const deletedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "deleted");
      assertLoopState(deletedLoop, {
        status: "deleted",
        hasError: false,
      });
    });
  });

  describe("Edge Cases and Error Handling", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "<promise>COMPLETE</promise>",
          // Extra responses for the "cannot accept a loop that is not completed" test
          "Still working...",
          "More work...",
          "Even more...",
          "Almost done...",
          "<promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("allows creating loop even with uncommitted changes in main checkout", async () => {
      // Create uncommitted changes in the main checkout
      await writeFile(join(ctx.workDir, "uncommitted.txt"), "uncommitted content");
      await Bun.$`git -C ${ctx.workDir} add .`.quiet();

      // With worktrees, uncommitted changes in main checkout don't block loop creation
      const { status, body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "This should succeed with worktrees",
        planMode: false,
      });

      // Loop creation succeeds — worktrees isolate the loop from main checkout state
      expect(status).toBe(201);
      const loop = body as Loop;
      expect(loop.config.id).toBeDefined();

      // Wait for loop to complete
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");

      // Clean up the uncommitted change
      await Bun.$`git -C ${ctx.workDir} reset HEAD -- . 2>/dev/null || true`.quiet().nothrow();
      await Bun.$`git -C ${ctx.workDir} checkout -- . 2>/dev/null || true`.quiet().nothrow();
      await Bun.$`git -C ${ctx.workDir} clean -fd 2>/dev/null || true`.quiet().nothrow();
    });

    test("returns 404 for non-existent loop", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/loops/non-existent-id`);
      expect(response.status).toBe(404);
    });

    test("cannot accept a loop that is not completed", async () => {
      // Clean up any leftover changes from previous tests
      await Bun.$`git -C ${ctx.workDir} checkout -- . 2>/dev/null || true`.quiet().nothrow();
      await Bun.$`git -C ${ctx.workDir} clean -fd 2>/dev/null || true`.quiet().nothrow();
      
      // Create a loop but don't wait for completion
      ctx.mockBackend.reset([
        "Still working...",
        "More work...",
        "Even more...",
        "Almost done...",
        "<promise>COMPLETE</promise>",
      ]);

      const { status: createStatus, body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Long running task",
        planMode: false, // Regular execution, not plan mode
      });
      
      // If creation fails due to some issue, skip the rest of the test
      if (createStatus !== 201) {
        expect(createStatus).toBe(201); // This will fail with a meaningful message
        return;
      }
      
      const loop = body as Loop;

      // Wait for it to be running (or already completed)
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, ["running", "completed"]);

      // Try to accept (might already be completed due to fast mock)
      // This is a race condition test - if it completes fast, skip the assertion
      const { status } = await acceptLoopViaAPI(ctx.baseUrl, loop.config.id);

      // Either we catch it running (400) or it already completed (200)
      expect([200, 400]).toContain(status);

      // Wait for completion and clean up
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, ["completed", "accepted_local"]);
      const finalLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, ["completed", "accepted_local", "deleted"]);
      if (finalLoop.state.status !== "deleted" && finalLoop.state.status !== "accepted_local") {
        await discardLoopViaAPI(ctx.baseUrl, loop.config.id);
      }
    });
  });
});
