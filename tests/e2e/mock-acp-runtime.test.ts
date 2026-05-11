import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";

import {
  setupTestContext,
  teardownTestContext,
  waitForLoopStatus,
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

  test("completes a standard loop through the real ACP transport", async () => {
    const loop = await ctx.manager.createLoop({
      ...testModelFields,
      directory: ctx.workDir,
      prompt: "Implement the requested mock ACP changes",
      name: "Mock ACP Execution Loop",
      workspaceId: "test-workspace-id",
      planMode: false,
    });

    await ctx.manager.startLoop(loop.config.id);
    const completed = await waitForLoopStatus(ctx.manager, loop.config.id, ["completed"]);

    expect(completed.state.status).toBe("completed");
    expect(completed.state.currentIteration).toBe(1);
  }, { timeout: 60_000 });

  test("reaches PLAN_READY and then completes accepted-plan execution", async () => {
    const loop = await ctx.manager.createLoop({
      ...testModelFields,
      directory: ctx.workDir,
      prompt: "Plan and then execute the mock ACP work",
      name: "Mock ACP Plan Loop",
      workspaceId: "test-workspace-id",
      planMode: true,
    });

    await ctx.manager.startPlanMode(loop.config.id);
    const readyLoop = await waitForPlanReady(ctx.manager, loop.config.id);
    expect(readyLoop.state.planMode?.isPlanReady).toBe(true);

    await ctx.manager.acceptPlan(loop.config.id);
    const completed = await waitForLoopStatus(ctx.manager, loop.config.id, ["completed"]);
    expect(completed.state.status).toBe("completed");
  }, { timeout: 60_000 });
});
