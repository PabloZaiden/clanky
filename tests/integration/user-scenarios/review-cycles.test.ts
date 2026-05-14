/**
 * Integration tests for review cycle scenarios.
 * Tests the ability to address reviewer comments after push/merge.
 */

import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import {
  setupTestServer,
  teardownTestServer,
  createLoopViaAPI,
  waitForLoopStatus,
  pushLoopViaAPI,
  acceptLoopViaAPI,
  getCurrentBranch,
  branchExists,
  type TestServerContext,
} from "./helpers";
import type { Loop } from "../../../src/types/loop";

describe("Review Cycle User Scenarios", () => {
  describe("Pushed Loop with Single Review Cycle", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          // First iteration: complete the initial work
          "Initial work done! <promise>COMPLETE</promise>",
          // Second iteration: address reviewer comments
          "Addressed reviewer comments! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
        withRemote: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("pushed loop can receive and address reviewer comments", async () => {
      // Create and complete initial loop
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Implement a feature",
        planMode: false, // Regular execution, not plan mode
      });
      const loop = body as Loop;

      // Wait for completion
      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      const workingBranch = completedLoop.state.git!.workingBranch;

      // Push the loop
      const { status: pushStatus, body: pushBody } = await pushLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(pushStatus).toBe(200);
      expect(pushBody.success).toBe(true);

      // Verify loop is now "pushed" with review mode
      const pushedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "pushed");
      expect(pushedLoop.state.reviewMode).toBeDefined();
      expect(pushedLoop.state.reviewMode?.addressable).toBe(true);
      expect(pushedLoop.state.reviewMode?.completionAction).toBe("push");
      expect(pushedLoop.state.reviewMode?.reviewCycles).toBe(0);

      // With worktrees, main checkout stays on original branch — verify branch exists in git
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

      // Address reviewer comments
      const addressResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: "Please add error handling and improve documentation", attachments: [] }),
      });
      expect(addressResponse.status).toBe(200);
      const addressResult = await addressResponse.json();
      expect(addressResult.success).toBe(true);
      expect(addressResult.reviewCycle).toBe(1);

      // Wait for addressing to complete
      const addressedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");

      // Verify review cycle was incremented
      expect(addressedLoop.state.reviewMode?.reviewCycles).toBe(1);

      // Verify still on same branch (pushed loops don't create new branches)
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

      // Can push again after addressing comments
      const { status: push2Status, body: push2Body } = await pushLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(push2Status).toBe(200);
      expect(push2Body.success).toBe(true);

      // Verify pushed status maintained
      const rePushedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "pushed");
      expect(rePushedLoop.state.reviewMode?.reviewCycles).toBe(1);
      expect(rePushedLoop.state.reviewMode?.addressable).toBe(true);
    });
  });

  describe("Pushed Loop with Multiple Review Cycles", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          // Initial work
          "Initial work! <promise>COMPLETE</promise>",
          // Review cycle 1
          "Addressed round 1! <promise>COMPLETE</promise>",
          // Review cycle 2
          "Addressed round 2! <promise>COMPLETE</promise>",
          // Review cycle 3
          "Addressed round 3! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
        withRemote: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("pushed loop handles 3+ review cycles on same branch", async () => {
      // Create and complete initial loop
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Build a complex feature",
        planMode: false, // Regular execution, not plan mode
      });
      const loop = body as Loop;

      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      const workingBranch = completedLoop.state.git!.workingBranch;

      // Push initial work
      await pushLoopViaAPI(ctx.baseUrl, loop.config.id);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "pushed");

      // Review cycle 1
      let addressResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: "Round 1: Add tests", attachments: [] }),
      });
      let addressResult = await addressResponse.json();
      expect(addressResult.reviewCycle).toBe(1);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      await pushLoopViaAPI(ctx.baseUrl, loop.config.id);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "pushed");

      // Review cycle 2
      addressResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: "Round 2: Improve error messages", attachments: [] }),
      });
      addressResult = await addressResponse.json();
      expect(addressResult.reviewCycle).toBe(2);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      await pushLoopViaAPI(ctx.baseUrl, loop.config.id);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "pushed");

      // Review cycle 3
      addressResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: "Round 3: Update documentation", attachments: [] }),
      });
      addressResult = await addressResponse.json();
      expect(addressResult.reviewCycle).toBe(3);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");

      // Verify review history
      const historyResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/review-history`);
      const history = await historyResponse.json();
      expect(history.success).toBe(true);
      expect(history.history.reviewCycles).toBe(3);
      expect(history.history.addressable).toBe(true);
      expect(history.history.completionAction).toBe("push");

      // All cycles should be on same branch — verify the branch still exists
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);
    });
  });

  describe("Merged Loop with Single Review Cycle", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          // Initial work
          "Initial work done! <promise>COMPLETE</promise>",
          // Review cycle 1
          "Addressed reviewer comments! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("merged loop creates new branch for addressing comments", async () => {
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create and complete initial loop
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Implement a feature",
        planMode: false, // Regular execution, not plan mode
      });
      const loop = body as Loop;

      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      const firstWorkingBranch = completedLoop.state.git!.workingBranch;

      // Accept the loop locally
      const { status: acceptStatus } = await acceptLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(acceptStatus).toBe(200);

      // Verify we're back on original branch
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Verify loop is accepted locally with review mode
      const acceptedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "accepted_local");
      expect(acceptedLoop.state.reviewMode).toBeDefined();
      expect(acceptedLoop.state.reviewMode?.addressable).toBe(true);
      expect(acceptedLoop.state.reviewMode?.completionAction).toBe("local");
      expect(acceptedLoop.state.reviewMode?.reviewCycles).toBe(0);

      // Address reviewer comments
      const addressResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: "Please add tests and improve error handling", attachments: [] }),
      });
      expect(addressResponse.status).toBe(200);
      const addressResult = await addressResponse.json();
      expect(addressResult.success).toBe(true);
      expect(addressResult.reviewCycle).toBe(1);
      expect(addressResult.branch).toBe(firstWorkingBranch);

      // Wait for addressing to complete
      const addressedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");

      // Verify review cycle was incremented
      expect(addressedLoop.state.reviewMode?.reviewCycles).toBe(1);

      // Verify the same branch was reused
      const reviewBranch = addressedLoop.state.git!.workingBranch;
      expect(reviewBranch).toBe(firstWorkingBranch);
      expect(await branchExists(ctx.workDir, reviewBranch)).toBe(true);

      // Can accept locally again
      const { status: accept2Status } = await acceptLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(accept2Status).toBe(200);
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);
    });
  });

  describe("Merged Loop with Multiple Review Cycles", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          // Initial work
          "Initial work! <promise>COMPLETE</promise>",
          // Review cycle 1
          "Round 1 done! <promise>COMPLETE</promise>",
          // Review cycle 2
          "Round 2 done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("local accepted loop reuses the same branch for each review cycle", async () => {
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create and complete initial loop
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Complex feature",
        planMode: false, // Regular execution, not plan mode
      });
      const loop = body as Loop;

      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      const initialBranch = (await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}`).then(r => r.json())).state.git.workingBranch;

      // Initial local accept
      await acceptLoopViaAPI(ctx.baseUrl, loop.config.id);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "accepted_local");

      // Review cycle 1
      let addressResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: "Round 1 feedback", attachments: [] }),
      });
      let addressResult = await addressResponse.json();
      expect(addressResult.reviewCycle).toBe(1);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      
      const afterReview1 = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}`).then(r => r.json());
      const review1Branch = afterReview1.state.git.workingBranch;
      expect(review1Branch).toBe(initialBranch);

      // Accept locally again
      await acceptLoopViaAPI(ctx.baseUrl, loop.config.id);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "accepted_local");
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Review cycle 2
      addressResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: "Round 2 feedback", attachments: [] }),
      });
      addressResult = await addressResponse.json();
      expect(addressResult.reviewCycle).toBe(2);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");

      const afterReview2 = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}`).then(r => r.json());
      const review2Branch = afterReview2.state.git.workingBranch;
      expect(review2Branch).toBe(initialBranch);

      // Verify review history tracks review cycles without per-cycle branches
      const historyResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/review-history`);
      const history = await historyResponse.json();
      expect(history.history.reviewCycles).toBe(2);
    }, { timeout: 45_000 });
  });

  describe("Comment History Persistence", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          // Initial work
          "Initial work! <promise>COMPLETE</promise>",
          // Review cycle 1
          "Round 1 done! <promise>COMPLETE</promise>",
          // Review cycle 2
          "Round 2 done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("comments are preserved across multiple merge cycles", async () => {
      // This test verifies the bug fix for comment history not being preserved.
      // The bug was: INSERT OR REPLACE on loops table triggered ON DELETE CASCADE
      // which deleted all comments whenever loop state was updated.

      // Create and complete initial loop
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Build a feature",
        planMode: false, // Regular execution, not plan mode
      });
      const loop = body as Loop;

      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");

      // Accept (merge) the initial work
      await acceptLoopViaAPI(ctx.baseUrl, loop.config.id);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "accepted_local");

      // Submit first round of feedback
      const comment1Text = "Please add error handling for edge cases";
      const address1Response = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: comment1Text, attachments: [] }),
      });
      expect(address1Response.status).toBe(200);
      const address1Result = await address1Response.json();
      expect(address1Result.reviewCycle).toBe(1);
      expect(address1Result.commentIds).toHaveLength(1);
      const comment1Id = address1Result.commentIds[0];

      // Wait for first review cycle to complete and merge
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      await acceptLoopViaAPI(ctx.baseUrl, loop.config.id);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "accepted_local");

      // Verify first comment is still in history after merge
      let commentsResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/comments`);
      let commentsResult = await commentsResponse.json();
      expect(commentsResult.success).toBe(true);
      expect(commentsResult.comments).toHaveLength(1);
      expect(commentsResult.comments[0].id).toBe(comment1Id);
      expect(commentsResult.comments[0].commentText).toBe(comment1Text);
      expect(commentsResult.comments[0].reviewCycle).toBe(1);

      // Submit second round of feedback
      const comment2Text = "Please also add unit tests for the new code";
      const address2Response = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: comment2Text, attachments: [] }),
      });
      expect(address2Response.status).toBe(200);
      const address2Result = await address2Response.json();
      expect(address2Result.reviewCycle).toBe(2);
      expect(address2Result.commentIds).toHaveLength(1);
      const comment2Id = address2Result.commentIds[0];

      // Wait for second review cycle to complete and merge
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      await acceptLoopViaAPI(ctx.baseUrl, loop.config.id);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "accepted_local");

      // CRITICAL: Both comments should still be in history after all merges
      commentsResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/comments`);
      commentsResult = await commentsResponse.json();
      expect(commentsResult.success).toBe(true);
      expect(commentsResult.comments).toHaveLength(2);

      // Comments are ordered by review_cycle DESC, so newest first
      const comment2 = commentsResult.comments.find((c: { id: string }) => c.id === comment2Id);
      const comment1 = commentsResult.comments.find((c: { id: string }) => c.id === comment1Id);
      
      expect(comment1).toBeDefined();
      expect(comment1.commentText).toBe(comment1Text);
      expect(comment1.reviewCycle).toBe(1);
      
      expect(comment2).toBeDefined();
      expect(comment2.commentText).toBe(comment2Text);
      expect(comment2.reviewCycle).toBe(2);

      // Verify review history also shows correct cycle count
      const historyResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/review-history`);
      const history = await historyResponse.json();
      expect(history.history.reviewCycles).toBe(2);
    });
  });

  describe("Review Mode Edge Cases", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          // Test 1: "cannot address comments on non-addressable loop"
          "edge-case-test-1",  // name generation
          "Done! <promise>COMPLETE</promise>",
          // Test 2: "cannot address comments with empty comment string"
          "edge-case-test-2",  // name generation
          "Done! <promise>COMPLETE</promise>",
          // Test 3: "review history returns correct info"
          "edge-case-test-3",  // name generation
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
        withRemote: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    // Clean up any active loops after each test to prevent blocking subsequent tests
    afterEach(async () => {
      const { listLoops, updateLoopState, loadLoop } = await import("../../../src/persistence/loops");
      const { loopManager } = await import("../../../src/core/loop-manager");
      
      // Clear all running engines first to prevent interference with subsequent tests
      loopManager.resetForTesting();
      
      const loops = await listLoops();
      const activeStatuses = ["idle", "planning", "starting", "running", "waiting"];
      
      for (const loop of loops) {
        if (activeStatuses.includes(loop.state.status)) {
          // Load full loop to get current state
          const fullLoop = await loadLoop(loop.config.id);
          if (fullLoop) {
            // Mark as deleted to make it a terminal state
            await updateLoopState(loop.config.id, {
              ...fullLoop.state,
              status: "deleted",
            });
          }
        }
      }
    });

    test("cannot address comments on non-addressable loop", async () => {
      // Create loop but don't push or merge
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Do something",
        planMode: false, // Regular execution, not plan mode
      });
      const loop = body as Loop;

      // Try to address comments - should fail
      const addressResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: "This should fail", attachments: [] }),
      });
      expect(addressResponse.status).toBe(400);
      const result = await addressResponse.json();
      expect(result.success).toBe(false);
      expect(result.error).toContain("not addressable");
    });

    test("cannot address comments with empty comment string", async () => {
      // Create and push loop
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Do something",
        planMode: false, // Regular execution, not plan mode
      });
      const loop = body as Loop;

      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      await pushLoopViaAPI(ctx.baseUrl, loop.config.id);

      // Try to address with empty comments
      const addressResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: "", attachments: [] }),
      });
      expect(addressResponse.status).toBe(400);
      const result = await addressResponse.json();
      // Error responses have { error, message } format, not { success: false }
      expect(result.error).toBe("validation_error");
      expect(result.message).toContain("empty");
    });

    test("review history returns correct info for non-addressable loop", async () => {
      // Create loop but don't push or merge
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Do something",
        planMode: false, // Regular execution, not plan mode
      });
      const loop = body as Loop;

      // Get history
      const historyResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/review-history`);
      const history = await historyResponse.json();
      expect(history.success).toBe(true);
      expect(history.history.addressable).toBe(false);
      expect(history.history.reviewCycles).toBe(0);
    });
  });

  describe("Review Mode Execution Verification", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          // Initial work
          "Initial work done! <promise>COMPLETE</promise>",
          // Review cycle - takes some time to complete
          "Addressed comments! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("address-comments API waits for loop to start before returning", async () => {
      // This test verifies that the address-comments API properly awaits
      // the engine.start() call instead of using fire-and-forget pattern.
      // The bug was: API returned success:true immediately before loop started,
      // causing the loop to appear "running" but not actually execute.

      // Create and complete initial loop
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Implement a feature",
        planMode: false, // Regular execution, not plan mode
      });
      const loop = body as Loop;

      // Wait for initial completion and merge
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      await acceptLoopViaAPI(ctx.baseUrl, loop.config.id);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "accepted_local");

      // Address comments - this should only return AFTER the loop has started
      const addressResponse = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: "Please add error handling", attachments: [] }),
      });
      expect(addressResponse.status).toBe(200);
      const addressResult = await addressResponse.json();
      expect(addressResult.success).toBe(true);

      // CRITICAL: Immediately after the API returns success, the loop should
      // be in a running state (or already completed if very fast).
      // If the API used fire-and-forget, the loop might still be in "merged" status.
      const loopAfterAddress = await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}`);
      const loopState = await loopAfterAddress.json();
      
      // The loop should NOT still be in "merged" status - it should have transitioned
      // to running, starting, or already completed
      expect(loopState.state.status).not.toBe("merged");
      expect(loopState.state.status).not.toBe("pushed");
      expect(["starting", "running", "completed"]).toContain(loopState.state.status);

      // Wait for final completion
      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      expect(completedLoop.state.reviewMode?.reviewCycles).toBe(1);
    });
  });
});
