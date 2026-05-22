import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";

import {
  setupTestContext,
  teardownTestContext,
  waitForTaskStatus,
  waitForPlanReady,
  testModelFields,
  type TestContext,
} from "../setup";

async function setupRemote(ctx: TestContext): Promise<void> {
  const remoteDir = join(ctx.dataDir, `remote-${Date.now()}.git`);
  await Bun.$`git init --bare ${remoteDir}`.quiet();
  await Bun.$`git -C ${ctx.workDir} remote add origin ${remoteDir}`.quiet();
  const currentBranch = (await Bun.$`git -C ${ctx.workDir} branch --show-current`.text()).trim();
  await Bun.$`git -C ${ctx.workDir} push -u origin ${currentBranch}`.quiet();
  await Bun.$`git --git-dir=${remoteDir} symbolic-ref HEAD refs/heads/${currentBranch}`.quiet();
}

describe("Mock ACP runtime integration", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({
      useMockBackend: false,
      useMockAcpProcess: true,
      initGit: true,
    });
    await setupRemote(ctx);
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  test("completes a standard task through the real ACP transport", async () => {
    const task = await ctx.manager.createTask({
      ...testModelFields,
      directory: ctx.workDir,
      prompt: "Implement the requested mock ACP changes",
      name: "Mock ACP Execution Task",
      workspaceId: "test-workspace-id",
      planMode: false,
    });

    await ctx.manager.startTask(task.config.id);
    const completed = await waitForTaskStatus(ctx.manager, task.config.id, ["completed"]);

    expect(completed.state.status).toBe("completed");
    expect(completed.state.currentIteration).toBe(1);
  }, { timeout: 60_000 });

  test("reaches PLAN_READY and then completes accepted-plan execution", async () => {
    const task = await ctx.manager.createTask({
      ...testModelFields,
      directory: ctx.workDir,
      prompt: "Plan and then execute the mock ACP work",
      name: "Mock ACP Plan Task",
      workspaceId: "test-workspace-id",
      planMode: true,
    });

    await ctx.manager.startPlanMode(task.config.id);
    const readyTask = await waitForPlanReady(ctx.manager, task.config.id);
    expect(readyTask.state.planMode?.isPlanReady).toBe(true);

    await ctx.manager.acceptPlan(task.config.id);
    const completed = await waitForTaskStatus(ctx.manager, task.config.id, ["completed"]);
    expect(completed.state.status).toBe("completed");
  }, { timeout: 60_000 });
});
