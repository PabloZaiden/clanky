/**
 * Public task lifecycle scenarios that are not covered by the regular task
 * creation, planning, or review suites.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createTaskViaAPI,
  discardTaskViaAPI,
  setupTestServer,
  stopTaskViaAPI,
  teardownTestServer,
  waitForTaskStatus,
  type TestServerContext,
} from "./helpers";
import type { Task } from "@/shared/task";

describe("Task Lifecycle User Scenarios", () => {
  let ctx: TestServerContext;

  beforeEach(async () => {
    ctx = await setupTestServer({ withPlanningDir: true });
  });

  afterEach(async () => {
    await teardownTestServer(ctx);
  });

  test("reports max-iteration termination through the task API", async () => {
    ctx.mockBackend.reset(["Still working..."]);

    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Keep working until the iteration limit is reached",
      planMode: false,
      maxIterations: 2,
    });

    expect(status).toBe(201);
    const task = body as Task;
    const stoppedTask = await waitForTaskStatus(
      ctx.baseUrl,
      task.config.id,
      "max_iterations",
    );

    expect(stoppedTask.state.status).toBe("max_iterations");
    expect(stoppedTask.config.maxIterations).toBe(2);

    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  });

  test("stops an active task through the task API", async () => {
    ctx.mockBackend.reset(["Still working..."]);

    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Keep this task running until it is stopped",
      planMode: false,
    });

    expect(status).toBe(201);
    const task = body as Task;
    await waitForTaskStatus(ctx.baseUrl, task.config.id, ["starting", "running"]);

    const stopResponse = await stopTaskViaAPI(ctx.baseUrl, task.config.id);
    expect(stopResponse.status).toBe(200);
    expect(stopResponse.body.success).toBe(true);

    const stoppedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "stopped");
    expect(stoppedTask.state.status).toBe("stopped");

    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  });

  test("exposes backend failure through the persisted task state", async () => {
    ctx.mockBackend.reset(["ERROR:Backend crashed"]);

    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Run a task that exercises backend failure handling",
      planMode: false,
      maxConsecutiveErrors: 1,
    });

    expect(status).toBe(201);
    const task = body as Task;
    const failedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "failed");

    expect(failedTask.state.status).toBe("failed");
    expect(failedTask.state.error?.message).toContain("Backend crashed");

    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  });
});
