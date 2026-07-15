/**
 * Integration tests for Plan + Task user scenarios.
 * These tests simulate UI interactions via API calls for plan mode workflows.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { writeFile, readdir } from "fs/promises";
import { join } from "path";
import {
  setupTestServer,
  teardownTestServer,
  createTaskViaAPI,
  waitForTaskCondition,
  waitForTaskStatus,
  waitForPlanReady,
  acceptTaskViaAPI,
  discardTaskViaAPI,
  sendPlanFeedbackViaAPI,
  acceptPlanViaAPI,
  discardPlanViaAPI,
  getCurrentBranch,
  branchExists,
  assertTaskState,
  waitForGitAvailable,
  type TestServerContext,
} from "./helpers";
import type { Task } from "@/shared/task";
import { backendManager } from "../../../src/core/backend-manager";
import { TestCommandExecutor } from "../../mocks/mock-executor";

class GitHubMockExecutor extends TestCommandExecutor {
  private pullRequestCreated = false;

  override async exec(command: string, args: string[], options?: Parameters<TestCommandExecutor["exec"]>[2]) {
    if (
      command === "git"
      && args.includes("remote")
      && args.includes("get-url")
      && args.includes("origin")
    ) {
      return {
        success: true,
        stdout: "https://github.com/test-owner/test-repo.git\n",
        stderr: "",
        exitCode: 0,
      };
    }

    if (command !== "gh") {
      return await super.exec(command, args, options);
    }

    if (args[0] === "--version") {
      return {
        success: true,
        stdout: "gh version 2.65.0\n",
        stderr: "",
        exitCode: 0,
      };
    }

    if (args[0] === "pr" && args[1] === "view") {
      if (!this.pullRequestCreated) {
        return {
          success: false,
          stdout: "",
          stderr: "no pull requests found for branch\n",
          exitCode: 1,
        };
      }
      return {
        success: true,
        stdout: JSON.stringify({
          number: 123,
          url: "https://github.com/test-owner/test-repo/pull/123",
          state: "OPEN",
          reviewDecision: "REVIEW_REQUIRED",
        }),
        stderr: "",
        exitCode: 0,
      };
    }

    if (args[0] === "pr" && args[1] === "create") {
      this.pullRequestCreated = true;
      return {
        success: true,
        stdout: "created\n",
        stderr: "",
        exitCode: 0,
      };
    }

    if (args[0] === "api" && args[1] === "graphql") {
      return {
        success: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                number: 123,
                url: "https://github.com/test-owner/test-repo/pull/123",
                state: "OPEN",
                reviewDecision: "REVIEW_REQUIRED",
                headRefOid: "test-head-sha",
                commits: {
                  nodes: [{
                    commit: {
                      oid: "test-head-sha",
                      statusCheckRollup: {
                        contexts: { nodes: [] },
                      },
                    },
                  }],
                },
                reviewThreads: { nodes: [] },
                comments: { nodes: [] },
                reviews: { nodes: [] },
              },
            },
          },
        }),
        stderr: "",
        exitCode: 0,
      };
    }

    return {
      success: false,
      stdout: "",
      stderr: `Unsupported gh command: ${args.join(" ")}`,
      exitCode: 1,
    };
  }
}

/**
 * Helper to create a plan mode mock backend.
 * Plan mode has two phases:
 * 1. Planning phase: Returns PLAN_READY to indicate plan is ready for review
 * 2. Execution phase: Normal iteration responses
 */
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

  // Planning phase responses (PLAN_READY after each iteration)
  for (let i = 0; i < planIterations; i++) {
    responses.push("Planning... <promise>PLAN_READY</promise>");
  }

  // Execution phase responses
  responses.push(...executionResponses);

  return responses;
}

describe("Plan + Task User Scenarios", () => {
  describe("Create Task with Plan Mode", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: createPlanModeMockResponses({
          planIterations: 1,
          executionResponses: [
            "Working on iteration 1...",
            "Working on iteration 2...",
            "Done! <promise>COMPLETE</promise>",
          ],
        }),
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("creates task in planning status with planMode: true", async () => {
      // Create task with plan mode via API (simulating UI "Create with Plan" option)
      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Create a comprehensive plan first",
        planMode: true,
        autoAcceptPlan: false,
      });

      expect(status).toBe(201);
      const task = body as Task;
      expect(task.config.id).toBeDefined();

      // Wait for planning status
      const planningTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");

      // Validate task state for UI display
      assertTaskState(planningTask, {
        status: "planning",
        hasError: false,
        planMode: {
          active: true,
          feedbackRounds: 0,
        },
      });

      // In plan mode, the git branch and worktree are created at plan mode start.
      // The main checkout should still be on the default branch (worktree is separate).
      const currentBranch = await getCurrentBranch(ctx.workDir);
      expect(currentBranch).toBe(ctx.defaultBranch);

      // Verify git state is set (worktree+branch created at plan mode start)
      expect(planningTask.state.git).toBeDefined();
      expect(planningTask.state.git?.workingBranch).toBeDefined();
      expect(planningTask.state.git?.worktreePath).toBeDefined();

      // Clean up - wait for status to confirm deletion
      await discardPlanViaAPI(ctx.baseUrl, task.config.id);
      await waitForTaskStatus(ctx.baseUrl, task.config.id, "deleted");
    });

    test("creates task with plan mode and clearPlanningFolder: true", async () => {
      ctx.mockBackend.reset(
        createPlanModeMockResponses({
          planIterations: 1,
          executionResponses: ["<promise>COMPLETE</promise>"],
          taskName: "test-task-clearfolder",
        })
      );

      // The discard API awaits engine cleanup; confirm the source checkout is
      // also free of an active git lock before starting the next task.
      await waitForGitAvailable(ctx.workDir);

      // Add an ignored file to the main checkout's managed planning directory.
      // Plan-mode clearing happens in the worktree, not in the source checkout.
      await writeFile(join(ctx.workDir, ".clanky-planning/extra-plan.md"), "Extra plan content");

      // Verify extra file exists
      const extraExists = await Bun.file(join(ctx.workDir, ".clanky-planning/extra-plan.md")).exists();
      expect(extraExists).toBe(true);

      // Create task with both plan mode and clear planning folder
      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Create a plan from scratch",
        planMode: true,
        clearPlanningFolder: true,
        autoAcceptPlan: false,
      });

      expect(status).toBe(201);
      const task = body as Task;

      // Wait for planning status
      await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");

      // Verify .clanky-planning was cleared in the worktree (not the main checkout)
      const planTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");
      const worktreePath = planTask.state.git?.worktreePath;
      expect(worktreePath).toBeDefined();
      const planningDir = join(worktreePath!, ".clanky-planning");
      const files = await readdir(planningDir);
      // Should be cleared (may have new files created by the agent)
      expect(files.length).toBeLessThanOrEqual(2);
      expect(await Bun.file(join(ctx.workDir, ".clanky-planning/extra-plan.md")).exists()).toBe(true);

      // Clean up - wait for status to confirm deletion
      await discardPlanViaAPI(ctx.baseUrl, task.config.id);
      await waitForTaskStatus(ctx.baseUrl, task.config.id, "deleted");
    });

    test("auto-accepts a ready plan by default in plan mode", async () => {
      ctx.mockBackend.reset(
        createPlanModeMockResponses({
          planIterations: 1,
          executionResponses: ["Done! <promise>COMPLETE</promise>"],
        })
      );

      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Create a plan and execute it immediately",
        planMode: true,
      });

      expect(status).toBe(201);
      const task = body as Task;
      expect(task.config.autoAcceptPlan).toBe(true);

      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      expect(completedTask.state.currentIteration).toBeGreaterThan(0);
    });

    test("fully autonomous tasks wait for manual plan acceptance before automatic PR flow", async () => {
      const ghExecutor = new GitHubMockExecutor();
      backendManager.setExecutorFactoryForTesting(() => ghExecutor);

      try {
        ctx.mockBackend.reset(
          createPlanModeMockResponses({
            planIterations: 1,
            executionResponses: ["Done! <promise>COMPLETE</promise>"],
          })
        );

        const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
          directory: ctx.workDir,
          prompt: "Create a plan and carry it through push and PR automation",
          planMode: true,
          autoAcceptPlan: false,
          fullyAutonomous: true,
        });

        expect(status).toBe(201);
        const task = body as Task;
        expect(task.config.fullyAutonomous).toBe(true);
        expect(task.config.autoAcceptPlan).toBe(false);

        const readyTask = await waitForPlanReady(ctx.baseUrl, task.config.id);
        expect(readyTask.state.status).toBe("planning");
        expect(readyTask.state.fullyAutonomousPending).not.toBe(true);

        const accepted = await acceptPlanViaAPI(ctx.baseUrl, task.config.id);
        expect(accepted.status).toBe(200);
        const acceptedTask = await waitForTaskCondition(
          ctx.baseUrl,
          task.config.id,
          (latestTask) => latestTask.state.fullyAutonomousPending === true,
          "fully autonomous pending after manual plan acceptance",
        );
        expect(acceptedTask.config.autoAcceptPlan).toBe(false);

        const pushedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "pushed");
        const fullyAutonomousTask = await waitForTaskCondition(
          ctx.baseUrl,
          task.config.id,
          (latestTask) => (
            latestTask.state.status === "pushed"
            && latestTask.state.fullyAutonomousPending !== true
            && latestTask.state.automaticPrFlow?.enabled === true
          ),
          "fully autonomous post-push state",
        );

        expect(fullyAutonomousTask.state.fullyAutonomousPending).not.toBe(true);
        expect(fullyAutonomousTask.state.automaticPrFlow?.enabled).toBe(true);
        expect(fullyAutonomousTask.state.automaticPrFlow?.pullRequestNumber).toBe(123);

        const pushRef = await Bun.$`git --git-dir=${ctx.remoteDir!} show-ref --verify refs/heads/${pushedTask.state.git!.workingBranch}`.nothrow();
        expect(pushRef.exitCode).toBe(0);

        await discardTaskViaAPI(ctx.baseUrl, task.config.id);
      } finally {
        backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
      }
    });

    test("manually accepted plans can enable fully autonomous mode afterward", async () => {
      const ghExecutor = new GitHubMockExecutor();
      backendManager.setExecutorFactoryForTesting(() => ghExecutor);

      try {
        ctx.mockBackend.reset(
          createPlanModeMockResponses({
            planIterations: 1,
            executionResponses: ["Done! <promise>COMPLETE</promise>"],
          })
        );

        const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
          directory: ctx.workDir,
          prompt: "Create a plan, let me approve it, then continue autonomously",
          planMode: true,
          autoAcceptPlan: false,
          fullyAutonomous: false,
        });

        expect(status).toBe(201);
        const task = body as Task;
        expect(task.config.fullyAutonomous).toBe(false);

        await waitForPlanReady(ctx.baseUrl, task.config.id);

        const accepted = await acceptPlanViaAPI(ctx.baseUrl, task.config.id);
        expect(accepted.status).toBe(200);

        const updateResponse = await fetch(`${ctx.baseUrl}/api/tasks/${task.config.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fullyAutonomous: true }),
        });
        expect(updateResponse.status).toBe(200);
        const updatedTask = await updateResponse.json() as Task;
        expect(updatedTask.config.fullyAutonomous).toBe(true);
        expect(updatedTask.state.fullyAutonomousPending).toBe(true);

        const pushedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "pushed");
        const fullyAutonomousTask = await waitForTaskCondition(
          ctx.baseUrl,
          task.config.id,
          (latestTask) => (
            latestTask.state.status === "pushed"
            && latestTask.state.fullyAutonomousPending !== true
            && latestTask.state.automaticPrFlow?.enabled === true
          ),
          "delayed fully autonomous post-push state",
        );

        expect(fullyAutonomousTask.state.fullyAutonomousPending).not.toBe(true);
        expect(fullyAutonomousTask.state.automaticPrFlow?.enabled).toBe(true);
        expect(fullyAutonomousTask.state.automaticPrFlow?.pullRequestNumber).toBe(123);

        const pushRef = await Bun.$`git --git-dir=${ctx.remoteDir!} show-ref --verify refs/heads/${pushedTask.state.git!.workingBranch}`.nothrow();
        expect(pushRef.exitCode).toBe(0);

        await discardTaskViaAPI(ctx.baseUrl, task.config.id);
      } finally {
        backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
      }
    });
  });

  describe("Plan Close Variant A: Discard Plan", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: createPlanModeMockResponses({ planIterations: 1 }),
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("discards plan and deletes the task", async () => {
      // Get original branch
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create task with plan mode
      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Create a plan to discard",
        planMode: true,
        autoAcceptPlan: false,
      });
      const task = body as Task;

      // Wait for planning status
      const planningTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");

      // In plan mode, the git branch and worktree are created at plan mode start.
      // The main checkout should still be on the original branch (worktree is separate).
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);
      expect(planningTask.state.git).toBeDefined();
      expect(planningTask.state.git?.workingBranch).toBeDefined();

      // Discard the plan via API (simulating UI "Discard Plan" button)
      const { status, body: discardBody } = await discardPlanViaAPI(ctx.baseUrl, task.config.id);

      expect(status).toBe(200);
      expect(discardBody.success).toBe(true);

      // Verify we're still on the original branch
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Verify the task is deleted
      const deletedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "deleted");
      assertTaskState(deletedTask, {
        status: "deleted",
        hasError: false,
      });
    });
  });

  describe("Plan Close Variant B: No Feedback, Accept Plan Immediately", () => {
    describe("Then Accept and Merge", () => {
      let ctx: TestServerContext;

      beforeAll(async () => {
        ctx = await setupTestServer({
          mockResponses: createPlanModeMockResponses({
            planIterations: 1,
            executionResponses: [
              "Working on iteration 1...",
              "Working on iteration 2...",
              "Done! <promise>COMPLETE</promise>",
            ],
          }),
          withPlanningDir: true,
        });
      });

      afterAll(async () => {
        await teardownTestServer(ctx);
      });

      test("accepts plan without feedback, runs iterations, then accepts and merges", async () => {
        const originalBranch = await getCurrentBranch(ctx.workDir);

        // Create task with plan mode
        const { body } = await createTaskViaAPI(ctx.baseUrl, {
          directory: ctx.workDir,
          prompt: "Create a plan and execute it",
          planMode: true,
          autoAcceptPlan: false,
        });
        const task = body as Task;

        // Wait for planning status
        const planningTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");
        assertTaskState(planningTask, {
          status: "planning",
          planMode: { active: true, feedbackRounds: 0 },
        });

        // Wait for plan to be ready before accepting
        await waitForPlanReady(ctx.baseUrl, task.config.id);

        // Accept the plan immediately (no feedback)
        const { status, body: acceptPlanBody } = await acceptPlanViaAPI(ctx.baseUrl, task.config.id);
        expect(status).toBe(200);
        expect(acceptPlanBody.success).toBe(true);

        // Wait for task to complete
        const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
        assertTaskState(completedTask, {
          status: "completed",
          hasGitBranch: true,
          hasError: false,
        });

        // Verify iterations ran (total = 1 plan iteration + 3 execution iterations = 4)
        // But we don't check exact count since timing can vary
        expect(completedTask.state.currentIteration).toBeGreaterThanOrEqual(1);

        const workingBranch = completedTask.state.git!.workingBranch;

        // Accept the task locally
        const { status: acceptStatus, body: acceptBody } = await acceptTaskViaAPI(ctx.baseUrl, task.config.id);
        expect(acceptStatus).toBe(200);
        expect(acceptBody.success).toBe(true);

        // Verify we're back on original branch
        expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

        // Verify working branch was NOT deleted (kept for review mode)
        expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

        // Verify final state
        const mergedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "accepted_local");
        assertTaskState(mergedTask, { status: "accepted_local" });
        
        // Verify reviewMode was initialized
        expect(mergedTask.state.reviewMode).toBeDefined();
        expect(mergedTask.state.reviewMode?.addressable).toBe(true);
        expect(mergedTask.state.reviewMode?.completionAction).toBe("local");
      });
    });

  });

  describe("Plan Close Variant C: Add Feedback 2 Times, Then Accept Plan", () => {
    describe("Then Accept and Merge", () => {
      let ctx: TestServerContext;

      beforeAll(async () => {
        ctx = await setupTestServer({
          mockResponses: createPlanModeMockResponses({
            planIterations: 5, // Extra buffer: Initial plan + 2 feedback rounds + extra for safety
            executionResponses: [
              "Working on iteration 1...",
              "Working on iteration 2...",
              "Done! <promise>COMPLETE</promise>",
            ],
          }),
          withPlanningDir: true,
        });
      });

      afterAll(async () => {
        await teardownTestServer(ctx);
      });

      test("provides feedback 2 times, accepts plan, runs iterations, then merges", async () => {
        const originalBranch = await getCurrentBranch(ctx.workDir);

        // Create task with plan mode
        const { body } = await createTaskViaAPI(ctx.baseUrl, {
          directory: ctx.workDir,
          prompt: "Create a plan with feedback",
          planMode: true,
          autoAcceptPlan: false,
        });
        const task = body as Task;

        // Wait for planning status
        const planningTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");
        assertTaskState(planningTask, {
          status: "planning",
          planMode: { active: true, feedbackRounds: 0 },
        });

        // Wait for initial plan to be ready before sending feedback
        await waitForPlanReady(ctx.baseUrl, task.config.id);

        // Send first feedback
        const { status: fb1Status } = await sendPlanFeedbackViaAPI(
          ctx.baseUrl,
          task.config.id,
          "Please add more detail to step 2"
        );
        expect(fb1Status).toBe(200);

        // Wait for plan to be ready again after feedback
        await waitForPlanReady(ctx.baseUrl, task.config.id);
        const afterFb1 = await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");
        assertTaskState(afterFb1, {
          status: "planning",
          planMode: { active: true, feedbackRounds: 1 },
        });

        // Send second feedback
        const { status: fb2Status } = await sendPlanFeedbackViaAPI(
          ctx.baseUrl,
          task.config.id,
          "Also consider edge cases"
        );
        expect(fb2Status).toBe(200);

        // Wait for plan to be ready again after feedback
        await waitForPlanReady(ctx.baseUrl, task.config.id);
        const afterFb2 = await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");
        assertTaskState(afterFb2, {
          status: "planning",
          planMode: { active: true, feedbackRounds: 2 },
        });

        // Accept the plan
        const { status: acceptPlanStatus } = await acceptPlanViaAPI(ctx.baseUrl, task.config.id);
        expect(acceptPlanStatus).toBe(200);

        // Wait for task to complete
        const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
        assertTaskState(completedTask, {
          status: "completed",
          hasGitBranch: true,
          hasError: false,
        });

        const workingBranch = completedTask.state.git!.workingBranch;

        // Accept and merge
        const { status: acceptStatus } = await acceptTaskViaAPI(ctx.baseUrl, task.config.id);
        expect(acceptStatus).toBe(200);

        // Verify final state
        expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);
        expect(await branchExists(ctx.workDir, workingBranch)).toBe(true); // Branch kept for review mode

        const mergedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "accepted_local");
        assertTaskState(mergedTask, { status: "accepted_local" });
        
        // Verify reviewMode was initialized
        expect(mergedTask.state.reviewMode).toBeDefined();
        expect(mergedTask.state.reviewMode?.addressable).toBe(true);
        expect(mergedTask.state.reviewMode?.completionAction).toBe("local");
      });
    });

  });

  describe("Plan Mode Error Handling", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: createPlanModeMockResponses({ planIterations: 1 }),
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("returns error when sending feedback to non-planning task", async () => {
      // Create a normal task (not plan mode)
      ctx.mockBackend.reset([
        "error-handling-test-1",  // Name generation
        "<promise>COMPLETE</promise>",
      ]);

      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Normal task",
        planMode: false,
      });
      const task = body as Task;

      // Wait for completion
      await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

      // Try to send feedback (should fail)
      const { status, body: feedbackBody } = await sendPlanFeedbackViaAPI(
        ctx.baseUrl,
        task.config.id,
        "This should fail"
      );

      expect(status).toBe(400);
      expect(feedbackBody.error).toBe("not_planning");

      // Clean up
      await discardTaskViaAPI(ctx.baseUrl, task.config.id);
    });

    test("returns error when accepting plan on non-planning task", async () => {
      // Create a normal task (not plan mode)
      ctx.mockBackend.reset([
        "error-handling-test-2",  // Name generation (unique to avoid branch collision)
        "<promise>COMPLETE</promise>",
      ]);

      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Normal task",
        planMode: false,
      });
      const task = body as Task;

      // Wait for completion
      await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

      // Try to accept plan (should fail)
      const { status, body: acceptBody } = await acceptPlanViaAPI(ctx.baseUrl, task.config.id);

      expect(status).toBe(400);
      expect(acceptBody.error).toBe("not_planning");

      // Clean up
      await discardTaskViaAPI(ctx.baseUrl, task.config.id);
    });

    test("returns 404 when discarding plan for non-existent task", async () => {
      const { status } = await discardPlanViaAPI(ctx.baseUrl, "non-existent-id");
      expect(status).toBe(404);
    });

    test("preserves planning task status after server settings update", async () => {
      ctx.mockBackend.reset(createPlanModeMockResponses({ 
        planIterations: 3, // Initial + post-reset feedback 
        executionResponses: ["<promise>COMPLETE</promise>"],
      }));

      // Create a task in plan mode
      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Create a plan that survives reset",
        planMode: true,
        autoAcceptPlan: false,
      });
      const task = body as Task;

      // Wait for planning status and plan ready
      await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");
      await waitForPlanReady(ctx.baseUrl, task.config.id);

      // Verify the task is in planning status with isPlanReady = true
      let currentTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");
      expect(currentTask.state.status).toBe("planning");
      expect(currentTask.state.planMode?.isPlanReady).toBe(true);

      // Updating server settings still performs a supported internal connection reset.
      const currentSettingsResponse = await fetch(
        `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/server-settings`,
      );
      expect(currentSettingsResponse.status).toBe(200);
      const currentSettings = await currentSettingsResponse.json();
      expect(currentSettings.agent.transport).toBe("stdio");

      const updatedSettings = {
        agent: {
          provider: currentSettings.agent.provider,
          transport: "ssh",
          hostname: "127.0.0.1",
          port: 22,
        },
      };

      const updateResponse = await fetch(`${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/server-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedSettings),
      });
      expect(updateResponse.status).toBe(200);

      // Verify the task is still in planning status after the settings-triggered reset
      currentTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");
      expect(currentTask.state.status).toBe("planning");
      // Note: isPlanReady should still be true since we didn't change the state
      expect(currentTask.state.planMode?.isPlanReady).toBe(true);

      // Send feedback to continue planning (this should still work after the reset)
      const { status: feedbackStatus } = await sendPlanFeedbackViaAPI(
        ctx.baseUrl,
        task.config.id,
        "Please add more details"
      );
      expect(feedbackStatus).toBe(200);

      // Wait for plan to be ready again after feedback
      await waitForPlanReady(ctx.baseUrl, task.config.id);

      // Verify feedback was processed
      currentTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");
      expect(currentTask.state.status).toBe("planning");
      expect(currentTask.state.planMode?.feedbackRounds).toBe(1);

      // Clean up
      await discardPlanViaAPI(ctx.baseUrl, task.config.id);
      await waitForTaskStatus(ctx.baseUrl, task.config.id, "deleted");
    });

    test("returns error when sending empty feedback", async () => {
      ctx.mockBackend.reset(createPlanModeMockResponses({ planIterations: 1, taskName: "empty-feedback-test" }));

      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Test plan",
        planMode: true,
        autoAcceptPlan: false,
      });
      const task = body as Task;

      // Wait for planning
      await waitForTaskStatus(ctx.baseUrl, task.config.id, "planning");

      // Try to send empty feedback
      const response = await fetch(`${ctx.baseUrl}/api/tasks/${task.config.id}/plan/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "   " }), // Whitespace only
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toBe("validation_error");

      // Clean up
      await discardPlanViaAPI(ctx.baseUrl, task.config.id);
    });
  });
});
