/**
 * Integration tests for base branch invariants in plan mode.
 * Ensures originalBranch is stable throughout plan -> execute flows.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  setupTestServer,
  teardownTestServer,
  createLoopViaAPI,
  waitForLoopStatus,
  waitForPlanReady,
  acceptPlanViaAPI,
  acceptLoopViaAPI,
  pushLoopViaAPI,
  getCurrentBranch,
  branchExists,
  remoteBranchExists,
  type TestServerContext,
} from "./helpers";
import type { Loop } from "../../../src/types/loop";

function createPlanModeMockResponses(options: {
  planIterations?: number;
  executionResponses?: string[];
  loopName?: string;
}): string[] {
  const {
    planIterations = 1,
    executionResponses = ["<promise>COMPLETE</promise>"],
    loopName: _loopName = "unused",
  } = options;

  const responses: string[] = [];

  for (let i = 0; i < planIterations; i++) {
    responses.push("Planning... <promise>PLAN_READY</promise>");
  }

  responses.push(...executionResponses);
  return responses;
}

describe("Base Branch Invariant - Plan Mode", () => {
  describe("Basic Plan Flow", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: createPlanModeMockResponses({
          planIterations: 1,
          executionResponses: [
            "Working on iteration 1...",
            "Done! <promise>COMPLETE</promise>",
          ],
        }),
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("originalBranch remains constant after plan acceptance", async () => {
      const originalBranch = await getCurrentBranch(ctx.workDir);

      const { status, body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Create a plan and execute it",
        planMode: true,
      });

      expect(status).toBe(201);
      const loop = body as Loop;

      const planningLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "planning");
      // Git state is now set during startPlanMode (worktree+branch created early)
      expect(planningLoop.state.git).toBeDefined();
      expect(planningLoop.state.git?.originalBranch).toBe(originalBranch);
      expect(planningLoop.state.git?.workingBranch).toBeDefined();
      expect(planningLoop.state.git?.worktreePath).toBeDefined();
      // Main checkout should still be on the original branch (worktree is separate)
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      await waitForPlanReady(ctx.baseUrl, loop.config.id);
      const { status: acceptStatus } = await acceptPlanViaAPI(ctx.baseUrl, loop.config.id);
      expect(acceptStatus).toBe(200);

      const runningLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, ["running", "completed"]);
      expect(runningLoop.state.git?.originalBranch).toBe(originalBranch);
      expect(runningLoop.state.git?.workingBranch).toBeDefined();
      expect(runningLoop.state.git?.workingBranch).not.toBe(originalBranch);

      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      expect(completedLoop.state.git?.originalBranch).toBe(originalBranch);
      expect(completedLoop.state.git?.workingBranch).toBeDefined();
      expect(completedLoop.state.git?.workingBranch).not.toBe(originalBranch);

      // Clean up
      await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/discard`, { method: "POST" });
    });
  });

  describe("Accept and Merge Flow", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: createPlanModeMockResponses({
          planIterations: 1,
          executionResponses: [
            "Working...",
            "Done! <promise>COMPLETE</promise>",
          ],
        }),
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("merge returns to originalBranch", async () => {
      const originalBranch = await getCurrentBranch(ctx.workDir);

      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Plan and merge",
        planMode: true,
      });
      const loop = body as Loop;

      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "planning");
      await waitForPlanReady(ctx.baseUrl, loop.config.id);
      await acceptPlanViaAPI(ctx.baseUrl, loop.config.id);

      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      expect(completedLoop.state.git?.originalBranch).toBe(originalBranch);

      const workingBranch = completedLoop.state.git?.workingBranch ?? "";
      const { status: acceptStatus, body: acceptBody } = await acceptLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(acceptStatus).toBe(200);
      expect(acceptBody.success).toBe(true);

      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

      const mergedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "accepted_local");
      expect(mergedLoop.state.git?.originalBranch).toBe(originalBranch);

      // Clean up
      await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/discard`, { method: "POST" });
    });
  });

  describe("Push Flow", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: createPlanModeMockResponses({
          planIterations: 1,
          executionResponses: [
            "Working...",
            "Done! <promise>COMPLETE</promise>",
          ],
        }),
        withPlanningDir: true,
        withRemote: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("push uses same working branch and preserves originalBranch", async () => {
      const originalBranch = await getCurrentBranch(ctx.workDir);

      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Plan then push",
        planMode: true,
      });
      const loop = body as Loop;

      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "planning");
      await waitForPlanReady(ctx.baseUrl, loop.config.id);
      await acceptPlanViaAPI(ctx.baseUrl, loop.config.id);

      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      const workingBranch = completedLoop.state.git?.workingBranch ?? "";
      expect(completedLoop.state.git?.originalBranch).toBe(originalBranch);
      expect(workingBranch).not.toBe("");

      const { status, body: pushBody } = await pushLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(status).toBe(200);
      expect(pushBody.success).toBe(true);

      expect(await remoteBranchExists(ctx.workDir, workingBranch)).toBe(true);
      const pushedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "pushed");
      expect(pushedLoop.state.git?.originalBranch).toBe(originalBranch);
      expect(pushedLoop.state.git?.workingBranch).toBe(workingBranch);

      // Clean up
      await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/discard`, { method: "POST" });
    });
  });
});

describe("Default Base Branch - Auto-Detection", () => {
  describe("Loop creation without explicit baseBranch", () => {
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

    test("loop created without baseBranch uses repository's default branch", async () => {
      // Create a feature branch and switch to it
      await Bun.$`git -C ${ctx.workDir} checkout -b feature/some-work`.quiet();
      
      // Verify we're on the feature branch
      const currentBranch = await getCurrentBranch(ctx.workDir);
      expect(currentBranch).toBe("feature/some-work");

      // Create a loop WITHOUT specifying baseBranch
      const { status, body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Do some work",
        planMode: false, // Regular execution, not plan mode
        // Note: baseBranch is NOT specified
      });

      expect(status).toBe(201);
      const loop = body as Loop;

      // The loop's baseBranch should be the repository's default branch (main/master),
      // NOT the current branch (feature/some-work)
      expect(loop.config.baseBranch).toBeDefined();
      expect(["main", "master"]).toContain(loop.config.baseBranch ?? "");
      expect(loop.config.baseBranch).not.toBe("feature/some-work");

      // Wait for completion and verify git state
      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      
      // originalBranch should be the default branch
      expect(completedLoop.state.git?.originalBranch).toBe(ctx.defaultBranch);
      expect(completedLoop.state.git?.originalBranch).not.toBe("feature/some-work");

      // Clean up
      await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/discard`, { method: "POST" });
    });
  });

  describe("Loop creation with explicit baseBranch override", () => {
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

    test("loop created with explicit baseBranch uses that branch", async () => {
      // Create a develop branch
      await Bun.$`git -C ${ctx.workDir} checkout -b develop`.quiet();
      await Bun.$`git -C ${ctx.workDir} checkout ${ctx.defaultBranch}`.quiet();

      // Verify we're on the default branch
      const currentBranch = await getCurrentBranch(ctx.workDir);
      expect(currentBranch).toBe(ctx.defaultBranch);

      // Create a loop WITH explicit baseBranch pointing to develop
      const { status, body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Do some work on develop",
        baseBranch: "develop",  // Explicit override
        planMode: false, // Regular execution, not plan mode
      });

      expect(status).toBe(201);
      const loop = body as Loop;

      // The loop's baseBranch should be the explicitly specified branch
      expect(loop.config.baseBranch).toBe("develop");

      // Wait for completion and verify git state
      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      
      // originalBranch should be the explicitly specified branch (develop)
      expect(completedLoop.state.git?.originalBranch).toBe("develop");

      // Clean up
      await fetch(`${ctx.baseUrl}/api/loops/${loop.config.id}/discard`, { method: "POST" });
    });
  });
});
