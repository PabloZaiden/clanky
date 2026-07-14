/**
 * Integration tests for base branch invariants in plan mode.
 * Ensures originalBranch is stable throughout plan -> execute flows.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  setupTestServer,
  teardownTestServer,
  createTaskViaAPI,
  waitForTaskStatus,
  waitForPlanReady,
  acceptPlanViaAPI,
  acceptTaskViaAPI,
  pushTaskViaAPI,
  getCurrentBranch,
  branchExists,
  remoteBranchExists,
  type TestServerContext,
} from "./helpers";
import type { Task } from "@/shared/task";

function createPlanModeMockResponses(options: {
  planIterations?: number;
  executionResponses?: string[];
  taskName?: string;
}): string[] {
  const {
    planIterations = 1,
    executionResponses = ["<promise>COMPLETE</promise>"],
    taskName: _taskName = "unused",
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

      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Create a plan and execute it",
        planMode: true,
      });

      expect(status).toBe(201);
      const task = body as Task;

      const planningTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");
      // Git state is now set during startPlanMode (worktree+branch created early)
      expect(planningTask.state.git).toBeDefined();
      expect(planningTask.state.git?.originalBranch).toBe(originalBranch);
      expect(planningTask.state.git?.workingBranch).toBeDefined();
      expect(planningTask.state.git?.worktreePath).toBeDefined();
      // Main checkout should still be on the original branch (worktree is separate)
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      await waitForPlanReady(ctx.baseUrl, task.config.id);
      const { status: acceptStatus } = await acceptPlanViaAPI(ctx.baseUrl, task.config.id);
      expect(acceptStatus).toBe(200);

      const runningTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, ["running", "completed"]);
      expect(runningTask.state.git?.originalBranch).toBe(originalBranch);
      expect(runningTask.state.git?.workingBranch).toBeDefined();
      expect(runningTask.state.git?.workingBranch).not.toBe(originalBranch);

      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      expect(completedTask.state.git?.originalBranch).toBe(originalBranch);
      expect(completedTask.state.git?.workingBranch).toBeDefined();
      expect(completedTask.state.git?.workingBranch).not.toBe(originalBranch);

      // Clean up
      await fetch(`${ctx.baseUrl}/api/tasks/${task.config.id}/discard`, { method: "POST" });
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

      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Plan and merge",
        planMode: true,
      });
      const task = body as Task;

      await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");
      await waitForPlanReady(ctx.baseUrl, task.config.id);
      await acceptPlanViaAPI(ctx.baseUrl, task.config.id);

      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      expect(completedTask.state.git?.originalBranch).toBe(originalBranch);

      const workingBranch = completedTask.state.git?.workingBranch ?? "";
      const { status: acceptStatus, body: acceptBody } = await acceptTaskViaAPI(ctx.baseUrl, task.config.id);
      expect(acceptStatus).toBe(200);
      expect(acceptBody.success).toBe(true);

      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

      const mergedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "accepted_local");
      expect(mergedTask.state.git?.originalBranch).toBe(originalBranch);

      // Clean up
      await fetch(`${ctx.baseUrl}/api/tasks/${task.config.id}/discard`, { method: "POST" });
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

      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Plan then push",
        planMode: true,
      });
      const task = body as Task;

      await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");
      await waitForPlanReady(ctx.baseUrl, task.config.id);
      await acceptPlanViaAPI(ctx.baseUrl, task.config.id);

      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      const workingBranch = completedTask.state.git?.workingBranch ?? "";
      expect(completedTask.state.git?.originalBranch).toBe(originalBranch);
      expect(workingBranch).not.toBe("");

      const { status, body: pushBody } = await pushTaskViaAPI(ctx.baseUrl, task.config.id);
      expect(status).toBe(200);
      expect(pushBody.success).toBe(true);

      expect(await remoteBranchExists(ctx.workDir, workingBranch)).toBe(true);
      const pushedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "pushed");
      expect(pushedTask.state.git?.originalBranch).toBe(originalBranch);
      expect(pushedTask.state.git?.workingBranch).toBe(workingBranch);

      // Clean up
      await fetch(`${ctx.baseUrl}/api/tasks/${task.config.id}/discard`, { method: "POST" });
    });
  });
});

describe("Default Base Branch - Auto-Detection", () => {
  describe("Task creation without explicit baseBranch", () => {
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

    test("task created without baseBranch uses repository's default branch", async () => {
      // Create a feature branch and switch to it
      await Bun.$`git -C ${ctx.workDir} checkout -b feature/some-work`.quiet();
      
      // Verify we're on the feature branch
      const currentBranch = await getCurrentBranch(ctx.workDir);
      expect(currentBranch).toBe("feature/some-work");

      // Create a task WITHOUT specifying baseBranch
      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Do some work",
        planMode: false, // Regular execution, not plan mode
        // Note: baseBranch is NOT specified
      });

      expect(status).toBe(201);
      const task = body as Task;

      // The task's baseBranch should be the repository's default branch (main/master),
      // NOT the current branch (feature/some-work)
      expect(task.config.baseBranch).toBeDefined();
      expect(["main", "master"]).toContain(task.config.baseBranch ?? "");
      expect(task.config.baseBranch).not.toBe("feature/some-work");

      // Wait for completion and verify git state
      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      
      // originalBranch should be the default branch
      expect(completedTask.state.git?.originalBranch).toBe(ctx.defaultBranch);
      expect(completedTask.state.git?.originalBranch).not.toBe("feature/some-work");

      // Clean up
      await fetch(`${ctx.baseUrl}/api/tasks/${task.config.id}/discard`, { method: "POST" });
    });
  });

  describe("Task creation with explicit baseBranch override", () => {
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

    test("task created with explicit baseBranch uses that branch", async () => {
      // Create a develop branch
      await Bun.$`git -C ${ctx.workDir} checkout -b develop`.quiet();
      await Bun.$`git -C ${ctx.workDir} checkout ${ctx.defaultBranch}`.quiet();

      // Verify we're on the default branch
      const currentBranch = await getCurrentBranch(ctx.workDir);
      expect(currentBranch).toBe(ctx.defaultBranch);

      // Create a task WITH explicit baseBranch pointing to develop
      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Do some work on develop",
        baseBranch: "develop",  // Explicit override
        planMode: false, // Regular execution, not plan mode
      });

      expect(status).toBe(201);
      const task = body as Task;

      // The task's baseBranch should be the explicitly specified branch
      expect(task.config.baseBranch).toBe("develop");

      // Wait for completion and verify git state
      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      
      // originalBranch should be the explicitly specified branch (develop)
      expect(completedTask.state.git?.originalBranch).toBe("develop");

      // Clean up
      await fetch(`${ctx.baseUrl}/api/tasks/${task.config.id}/discard`, { method: "POST" });
    });
  });
});
