import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  acceptPlanViaAPI,
  createTaskViaAPI,
  discardTaskViaAPI,
  setupTestServer,
  teardownTestServer,
  waitForPlanReady,
  waitForTaskStatus,
  type TestServerContext,
} from "../integration/user-scenarios/helpers";
import type { Task } from "@/shared/task";

const mockAcpModel = {
  providerID: "opencode",
  modelID: "mock-model",
  variant: "",
};

describe("Mock ACP runtime integration", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await setupTestServer({
      useMockAcpProcess: true,
      withPlanningDir: true,
    });
  });

  afterAll(async () => {
    await teardownTestServer(ctx);
  });

  test("completes a standard task through the real ACP transport", async () => {
    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Implement the requested mock ACP changes",
      name: "Mock ACP Execution Task",
      planMode: false,
      model: mockAcpModel,
    });

    expect(status).toBe(201);
    const task = body as Task;
    const completed = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

    expect(completed.state.status).toBe("completed");
    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  }, { timeout: 60_000 });

  test("reaches PLAN_READY and then completes accepted-plan execution", async () => {
    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Plan and then execute the mock ACP work",
      name: "Mock ACP Plan Task",
      planMode: true,
      autoAcceptPlan: false,
      model: mockAcpModel,
    });

    expect(status).toBe(201);
    const task = body as Task;
    const readyTask = await waitForPlanReady(ctx.baseUrl, task.config.id);
    expect(readyTask.state.planMode?.isPlanReady).toBe(true);

    const acceptResponse = await acceptPlanViaAPI(ctx.baseUrl, task.config.id);
    expect(acceptResponse.status).toBe(200);
    expect(acceptResponse.body.success).toBe(true);

    const completed = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
    expect(completed.state.status).toBe("completed");
    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  }, { timeout: 60_000 });

  test("accepts and executes a ready plan in a local-only repository", async () => {
    await Bun.$`git -C ${ctx.workDir} remote remove origin`.quiet();

    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Plan and then execute mock ACP work without a remote",
      name: "Mock ACP Local Plan Task",
      planMode: true,
      autoAcceptPlan: false,
      model: mockAcpModel,
    });

    expect(status).toBe(201);
    const task = body as Task;
    const readyTask = await waitForPlanReady(ctx.baseUrl, task.config.id);
    expect(readyTask.state.planMode?.isPlanReady).toBe(true);

    const acceptResponse = await acceptPlanViaAPI(ctx.baseUrl, task.config.id);
    expect(acceptResponse.status).toBe(200);
    expect(acceptResponse.body.success).toBe(true);

    const completed = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
    expect(completed.state.status).toBe("completed");
    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  }, { timeout: 60_000 });
});
