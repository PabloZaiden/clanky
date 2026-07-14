/**
 * Integration coverage for the explicit BLOCKED task outcome.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  branchExists,
  createTaskViaAPI,
  discardTaskViaAPI,
  discardPlanViaAPI,
  remoteBranchExists,
  sendFollowUpViaAPI,
  setupTestServer,
  teardownTestServer,
  waitForPlanReady,
  waitForTaskStatus,
  type TestServerContext,
} from "./helpers";
import type { Task } from "@/shared/task";

describe("Blocked Task User Scenarios", () => {
  describe("Stopped task follow-up", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "I cannot continue because the upstream dependency is unavailable. <promise>BLOCKED</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("stops without completion, preserves the blocker, and resumes with a follow-up", async () => {
      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Implement the requested change",
        planMode: false,
      });

      expect(status).toBe(201);
      const task = body as Task;
      const stoppedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "stopped");

      expect(stoppedTask.state.status).toBe("stopped");
      expect(stoppedTask.state.recentIterations).toHaveLength(1);
      expect(stoppedTask.state.recentIterations[0]?.outcome).toBe("blocked");
      const responseContent = (stoppedTask.state.logs ?? [])
        .map((entry) => entry.details?.["responseContent"])
        .filter((content): content is string => typeof content === "string")
        .join("\n");
      expect(responseContent).toContain("upstream dependency is unavailable");

      const workingBranch = stoppedTask.state.git?.workingBranch;
      expect(workingBranch).toBeDefined();
      expect(await branchExists(ctx.workDir, workingBranch!)).toBe(true);
      expect(await remoteBranchExists(ctx.workDir, workingBranch!)).toBe(false);

      ctx.mockBackend.reset(["The dependency is available now. <promise>COMPLETE</promise>"]);
      const followUp = await sendFollowUpViaAPI(
        ctx.baseUrl,
        task.config.id,
        "The blocker is resolved. Continue the task.",
      );
      expect(followUp.status).toBe(200);
      expect(followUp.body.success).toBe(true);

      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      expect(completedTask.state.status).toBe("completed");
      expect(completedTask.state.recentIterations[0]?.outcome).toBe("complete");

      await discardTaskViaAPI(ctx.baseUrl, task.config.id);
    });
  });

  describe("Fully autonomous task safety", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "Plan is ready. <promise>PLAN_READY</promise>",
          "The required external service is down. <promise>BLOCKED</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("does not push a fully autonomous task after BLOCKED", async () => {
      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Plan and execute the requested change",
        planMode: true,
        autoAcceptPlan: true,
        fullyAutonomous: true,
      });

      expect(status).toBe(201);
      const task = body as Task;
      const stoppedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "stopped");

      expect(stoppedTask.config.fullyAutonomous).toBe(true);
      expect(stoppedTask.state.status).toBe("stopped");
      expect(stoppedTask.state.recentIterations.at(-1)?.outcome).toBe("blocked");
      expect(stoppedTask.state.fullyAutonomousPending).toBe(true);

      const workingBranch = stoppedTask.state.git?.workingBranch;
      expect(workingBranch).toBeDefined();
      expect(await branchExists(ctx.workDir, workingBranch!)).toBe(true);
      expect(await remoteBranchExists(ctx.workDir, workingBranch!)).toBe(false);

      await discardTaskViaAPI(ctx.baseUrl, task.config.id);
    });
  });

  describe("Plan mode recovery", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "I cannot determine the plan because the required service is unavailable. <promise>BLOCKED</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("keeps plan mode resumable after BLOCKED", async () => {
      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Create a plan for the requested change",
        planMode: true,
        autoAcceptPlan: false,
      });

      expect(status).toBe(201);
      const task = body as Task;
      const stoppedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "stopped");
      expect(stoppedTask.state.planMode?.active).toBe(true);
      expect(stoppedTask.state.recentIterations[0]?.outcome).toBe("blocked");

      ctx.mockBackend.reset(["The dependency is available. Here is the plan. <promise>PLAN_READY</promise>"]);
      const followUp = await sendFollowUpViaAPI(
        ctx.baseUrl,
        task.config.id,
        "The dependency is available now. Please create the plan.",
      );
      expect(followUp.status).toBe(200);
      expect(followUp.body.success).toBe(true);

      const readyTask = await waitForPlanReady(ctx.baseUrl, task.config.id);
      expect(readyTask.state.status).toBe("planning");
      expect(readyTask.state.planMode?.active).toBe(true);

      await discardPlanViaAPI(ctx.baseUrl, task.config.id);
    });
  });
});
