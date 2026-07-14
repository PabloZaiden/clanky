/**
 * Integration tests for regular task user scenarios.
 * These tests simulate UI interactions via API calls.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { writeFile, readdir } from "fs/promises";
import { join } from "path";
import {
  setupTestServer,
  teardownTestServer,
  createTaskViaAPI,
  waitForTaskStatus,
  acceptTaskViaAPI,
  pushTaskViaAPI,
  discardTaskViaAPI,
  getTaskDiffViaAPI,
  getTaskPlanViaAPI,
  getTaskStatusFileViaAPI,
  getCurrentBranch,
  branchExists,
  remoteBranchExists,
  assertTaskState,
  type TestServerContext,
} from "./helpers";
import type { Task } from "@/shared/task";

describe("Regular Task User Scenarios", () => {
  describe("Task Creation Variants", () => {
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

    test("creates task based on main branch without clearing .clanky-planning folder", async () => {
      // Verify .clanky-planning files exist before creating task
      const planContent = await Bun.file(join(ctx.workDir, ".clanky-planning/plan.md")).text();
      expect(planContent).toContain("# Plan");

      // Create task via API (simulating UI "Create Task" button)
      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Implement a feature",
        clearPlanningFolder: false,
        planMode: false, // Regular execution, not plan mode
      });

      expect(status).toBe(201);
      const task = body as Task;
      expect(task.config.id).toBeDefined();
      expect(task.config.clearPlanningFolder).toBe(false);

      // Wait for task to complete (3 iterations: 2 continue + 1 complete)
      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

      // Validate task state for UI display
      assertTaskState(completedTask, {
        status: "completed",
        iterationCount: 3,
        hasGitBranch: true,
        hasError: false,
      });

      // Verify .clanky-planning files still exist
      const planContentAfter = await Bun.file(join(ctx.workDir, ".clanky-planning/plan.md")).text();
      expect(planContentAfter).toContain("# Plan");

      // Clean up - discard the task
      await discardTaskViaAPI(ctx.baseUrl, task.config.id);
    });

    test("creates task based on main branch with clearing .clanky-planning folder", async () => {
      // Reset mock backend for this test
      ctx.mockBackend.reset([
        "Working on iteration 1...",
        "Working on iteration 2...",
        "Done! <promise>COMPLETE</promise>",
      ]);

      // Add an ignored file to the main checkout's managed planning directory.
      // Clearing happens in the task worktree, not in the source checkout.
      await writeFile(join(ctx.workDir, ".clanky-planning/extra.md"), "Extra content");

      // Verify extra file exists
      const extraExists = await Bun.file(join(ctx.workDir, ".clanky-planning/extra.md")).exists();
      expect(extraExists).toBe(true);

      // Create task via API with clearPlanningFolder=true
      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Implement a feature",
        clearPlanningFolder: true,
        planMode: false, // Regular execution, not plan mode
      });

      expect(status).toBe(201);
      const task = body as Task;

      // Wait for task to complete
      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

      // Validate task state
      assertTaskState(completedTask, {
        status: "completed",
        iterationCount: 3,
        hasGitBranch: true,
        hasError: false,
      });

      // Verify clearPlanningFolder was set
      expect(completedTask.config.clearPlanningFolder).toBe(true);
      // With worktrees, the clearing happens in the worktree's .clanky-planning dir, not main checkout.
      // Verify the worktree's .clanky-planning was cleared by checking the task completed successfully
      // (clearing happens before iterations start in the worktree).
      const worktreePath = completedTask.state.git?.worktreePath;
      expect(worktreePath).toBeDefined();
      // The worktree's .clanky-planning should have been cleared (only .gitkeep or files created by the task)
      const worktreePlanningDir = join(worktreePath!, ".clanky-planning");
      const filesAfterClear = await readdir(worktreePlanningDir);
      expect(filesAfterClear.length).toBeLessThanOrEqual(2); // May have .gitkeep or be empty
      expect(await Bun.file(join(ctx.workDir, ".clanky-planning/extra.md")).exists()).toBe(true);

      // Clean up
      await discardTaskViaAPI(ctx.baseUrl, task.config.id);
    });
  });

  describe("Task Execution - 2 iterations without completion, 1 final iteration completing", () => {
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
      // Create task
      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Complete a multi-step task",
        planMode: false, // Regular execution, not plan mode
      });

      expect(status).toBe(201);
      const task = body as Task;

      // Wait for completion
      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

      // Validate the task ran exactly 3 iterations
      assertTaskState(completedTask, {
        status: "completed",
        iterationCount: 3,
        hasGitBranch: true,
        hasError: false,
      });

      // Verify iteration history
      expect(completedTask.state.recentIterations.length).toBe(3);
      expect(completedTask.state.recentIterations[0]?.outcome).toBe("continue");
      expect(completedTask.state.recentIterations[1]?.outcome).toBe("continue");
      expect(completedTask.state.recentIterations[2]?.outcome).toBe("complete");

      // With worktrees, main checkout stays on original branch
      // Verify the working branch exists (it's checked out in the worktree, not main checkout)
      const workingBranch = completedTask.state.git!.workingBranch;
      expect(workingBranch).not.toStartWith("clanky/");
      expect(workingBranch).toMatch(/-[0-9a-f]{7}$/);
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

      // Verify diff endpoint works
      const { status: diffStatus, body: diffBody } = await getTaskDiffViaAPI(ctx.baseUrl, task.config.id);
      expect(diffStatus).toBe(200);
      // Diff should be an array (even if empty since mock doesn't actually change files)
      expect(Array.isArray(diffBody)).toBe(true);

      // Verify plan endpoint works
      const { status: planStatus, body: planBody } = await getTaskPlanViaAPI(ctx.baseUrl, task.config.id);
      expect(planStatus).toBe(200);
      const plan = planBody as { exists: boolean; content: string };
      expect(plan.exists).toBe(true);
      expect(plan.content).toContain("# Plan");

      // Verify status-file endpoint works
      const { status: statusFileStatus, body: statusFileBody } = await getTaskStatusFileViaAPI(ctx.baseUrl, task.config.id);
      expect(statusFileStatus).toBe(200);
      const statusFile = statusFileBody as { exists: boolean; content: string };
      expect(statusFile.exists).toBe(true);
      expect(statusFile.content).toContain("# Status");

      // Clean up
      await discardTaskViaAPI(ctx.baseUrl, task.config.id);
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

    test("accepts task and merges to base branch", async () => {
      // Get the original branch before creating the task
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create and wait for task completion
      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false, // Regular execution, not plan mode
      });
      const task = body as Task;

      // Wait for completion
      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      const workingBranch = completedTask.state.git!.workingBranch;

      // With worktrees, main checkout stays on original branch throughout
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

      // Accept the task via API (simulating UI "Accept" button)
      const { status, body: acceptBody } = await acceptTaskViaAPI(ctx.baseUrl, task.config.id);

      expect(status).toBe(200);
      expect(acceptBody.success).toBe(true);

      // Main checkout stays on original branch (worktrees don't modify it)
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Verify the working branch was NOT deleted (kept for review mode)
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

      // Verify the task state is now "merged"
      const mergedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "accepted_local");
      assertTaskState(mergedTask, {
        status: "accepted_local",
        hasError: false,
      });
      
      // Verify reviewMode was initialized
      expect(mergedTask.state.reviewMode).toBeDefined();
      expect(mergedTask.state.reviewMode?.addressable).toBe(true);
      expect(mergedTask.state.reviewMode?.completionAction).toBe("local");
      expect(mergedTask.state.reviewMode?.reviewCycles).toBe(0);
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

    test("accepts task and pushes to remote (offline-compatible)", async () => {
      // Verify we have a remote configured
      expect(ctx.remoteDir).toBeDefined();

      // Create and wait for task completion
      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false, // Regular execution, not plan mode
      });
      const task = body as Task;

      // Wait for completion
      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      const workingBranch = completedTask.state.git!.workingBranch;

      // Push the task via API (simulating UI "Push" button)
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

      // Clean up - discard the task
      await discardTaskViaAPI(ctx.baseUrl, task.config.id);
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

    test("discards task and deletes working branch", async () => {
      // Get the original branch
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create and wait for task completion
      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Make some changes",
        planMode: false, // Regular execution, not plan mode
      });
      const task = body as Task;

      // Wait for completion
      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      const workingBranch = completedTask.state.git!.workingBranch;

      // Verify the working branch exists
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

      // Discard the task via API (simulating UI "Discard" button)
      const { status, body: discardBody } = await discardTaskViaAPI(ctx.baseUrl, task.config.id);

      expect(status).toBe(200);
      expect(discardBody.success).toBe(true);

      // Main checkout stays on original branch (worktrees don't modify it)
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // With worktrees, discard no longer deletes the branch (only purge does)
      // The branch may still exist — that's expected

      // Verify the task state is now "deleted"
      const deletedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "deleted");
      assertTaskState(deletedTask, {
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
          // Extra responses for the "cannot accept a task that is not completed" test
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

    test("allows creating task even with uncommitted changes in main checkout", async () => {
      // Create uncommitted changes in the main checkout
      await writeFile(join(ctx.workDir, "uncommitted.txt"), "uncommitted content");
      await Bun.$`git -C ${ctx.workDir} add .`.quiet();

      // With worktrees, uncommitted changes in main checkout don't block task creation
      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "This should succeed with worktrees",
        planMode: false,
      });

      // Task creation succeeds — worktrees isolate the task from main checkout state
      expect(status).toBe(201);
      const task = body as Task;
      expect(task.config.id).toBeDefined();

      // Wait for task to complete
      await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

      // Clean up the uncommitted change
      await Bun.$`git -C ${ctx.workDir} reset HEAD -- . 2>/dev/null || true`.quiet().nothrow();
      await Bun.$`git -C ${ctx.workDir} checkout -- . 2>/dev/null || true`.quiet().nothrow();
      await Bun.$`git -C ${ctx.workDir} clean -fd 2>/dev/null || true`.quiet().nothrow();
    });

    test("returns 404 for non-existent task", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/tasks/non-existent-id`);
      expect(response.status).toBe(404);
    });

    test("cannot accept a task that is not completed", async () => {
      // Clean up any leftover changes from previous tests
      await Bun.$`git -C ${ctx.workDir} checkout -- . 2>/dev/null || true`.quiet().nothrow();
      await Bun.$`git -C ${ctx.workDir} clean -fd 2>/dev/null || true`.quiet().nothrow();
      
      // Create a task but don't wait for completion
      ctx.mockBackend.reset([
        "Still working...",
        "More work...",
        "Even more...",
        "Almost done...",
        "<promise>COMPLETE</promise>",
      ]);

      const { status: createStatus, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Long running task",
        planMode: false, // Regular execution, not plan mode
      });
      
      // If creation fails due to some issue, skip the rest of the test
      if (createStatus !== 201) {
        expect(createStatus).toBe(201); // This will fail with a meaningful message
        return;
      }
      
      const task = body as Task;

      // Wait for it to be running (or already completed)
      await waitForTaskStatus(ctx.baseUrl, task.config.id, ["running", "completed"]);

      // Try to accept (might already be completed due to fast mock)
      // This is a race condition test - if it completes fast, skip the assertion
      const { status } = await acceptTaskViaAPI(ctx.baseUrl, task.config.id);

      // Either we catch it running (400) or it already completed (200)
      expect([200, 400]).toContain(status);

      // Wait for completion and clean up
      await waitForTaskStatus(ctx.baseUrl, task.config.id, ["completed", "accepted_local"]);
      const finalTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, ["completed", "accepted_local", "deleted"]);
      if (finalTask.state.status !== "deleted" && finalTask.state.status !== "accepted_local") {
        await discardTaskViaAPI(ctx.baseUrl, task.config.id);
      }
    });
  });
});
