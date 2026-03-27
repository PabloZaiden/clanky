/**
 * E2E tests for Plan Mode workflow.
 * Tests the complete plan mode workflow from creation to execution.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { setupTestContext, teardownTestContext, waitForPlanReady, waitForLoopStatus, testModelFields } from "../setup";
import type { TestContext } from "../setup";
import type { Loop } from "../../src/types";

const testWorkspaceId = "test-workspace-id";

// Helper to check if file exists
async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function setupRemote(ctx: TestContext): Promise<void> {
  const remoteDir = join(ctx.dataDir, "remote-" + Date.now() + ".git");
  await Bun.$`git init --bare ${remoteDir}`.quiet();
  await Bun.$`git -C ${ctx.workDir} remote add origin ${remoteDir}`.quiet();
  const currentBranch = (await Bun.$`git -C ${ctx.workDir} branch --show-current`.text()).trim();
  await Bun.$`git -C ${ctx.workDir} push -u origin ${currentBranch}`.quiet();
  await Bun.$`git -C ${remoteDir} symbolic-ref HEAD refs/heads/${currentBranch}`.quiet();
}

describe("Plan Mode E2E Workflow", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({ 
      initGit: true,
      // Need multiple PLAN_READY responses for feedback tests, followed by COMPLETE for acceptance
      mockResponses: [
        "<promise>PLAN_READY</promise>",     // Initial plan creation
        "<promise>PLAN_READY</promise>",     // After first feedback
        "<promise>PLAN_READY</promise>",     // After second feedback
        "<promise>PLAN_READY</promise>",     // After third feedback
        "<promise>COMPLETE</promise>",       // After acceptance (execution complete)
      ],
    });
    await setupRemote(ctx);
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  test("full plan mode workflow: create -> feedback -> accept -> complete", async () => {
    const planningDir = join(ctx.workDir, ".planning");
    await mkdir(planningDir, { recursive: true });

    // 1. Create loop with plan mode
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a simple implementation plan",
        name: "Test Loop",
      directory: ctx.workDir,
      maxIterations: 2,
      planMode: true,
      workspaceId: testWorkspaceId,
    });
    const loopId = loop.config.id;

    // Start plan mode
    await ctx.manager.startPlanMode(loopId);

    // 2. Wait for plan to be ready (polling instead of fixed delay)
    let loopData = await waitForPlanReady(ctx.manager, loopId);

    // 3. Verify loop is in planning status
    expect(loopData.state.status).toBe("planning");
    expect(loopData.state.planMode?.active).toBe(true);

    // 4. Create a plan file (simulating AI creating it)
    const planContent = "# Implementation Plan\n\n## Task 1\nImplement feature X\n\n## Task 2\nAdd tests";
    await writeFile(join(planningDir, "plan.md"), planContent);

    // 5. Verify plan file exists
    expect(await exists(join(planningDir, "plan.md"))).toBe(true);

    // 6. Send feedback (awaits the entire iteration)
    await ctx.manager.sendPlanFeedback(loopId, "Please add time estimates to each task");

    // 7. Verify feedback rounds incremented
    loopData = await ctx.manager.getLoop(loopId) as Loop;
    expect(loopData.state.planMode?.feedbackRounds).toBe(1);

    // 8. Update plan (simulating AI updating it)
    const updatedPlan = "# Implementation Plan\n\n## Task 1 (2 hours)\nImplement feature X\n\n## Task 2 (1 hour)\nAdd tests";
    await writeFile(join(planningDir, "plan.md"), updatedPlan);

    // 9. Verify plan was updated
    const planFile = Bun.file(join(planningDir, "plan.md"));
    const planText = await planFile.text();
    expect(planText).toContain("2 hours");
    expect(planText).toContain("1 hour");

    // 10. Wait for plan to be ready before accepting
    await waitForPlanReady(ctx.manager, loopId);

    // 11. Accept the plan
    await ctx.manager.acceptPlan(loopId);

    // 12. Wait for loop to transition from planning (polling instead of fixed delay)
    loopData = await waitForLoopStatus(ctx.manager, loopId, ["running", "completed", "max_iterations", "stopped"]);
    expect(["running", "completed", "max_iterations", "stopped"]).toContain(loopData.state.status);

    // 13. Verify plan was NOT cleared on start
    expect(await exists(join(planningDir, "plan.md"))).toBe(true);

    // 14. Stop the loop (completion test would require more sophisticated mock)
    await ctx.manager.stopLoop(loopId);
    
    // 15. Verify plan still exists after stop
    expect(await exists(join(planningDir, "plan.md"))).toBe(true);
  });

  test("discard plan workflow", async () => {
    // 1. Create loop with plan mode
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
      directory: ctx.workDir,
      maxIterations: 1,
      planMode: true,
      workspaceId: testWorkspaceId,
    });
    const loopId = loop.config.id;

    // 2. Wait for loop to be in planning status
    let loopData = await waitForLoopStatus(ctx.manager, loopId, ["planning"]);
    expect(loopData.state.status).toBe("planning");

    // 3. Create plan file
    const planningDir = join(ctx.workDir, ".planning");
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, "plan.md"), "# Plan to discard");

    // 4. Discard the plan
    const result = await ctx.manager.discardPlan(loopId);
    expect(result).toBe(true);

    // 5. Wait for loop to be deleted
    loopData = await waitForLoopStatus(ctx.manager, loopId, ["deleted"]);
    expect(loopData.state.status).toBe("deleted");

    // 6. Verify discarded event was emitted
    const discardEvents = ctx.events.filter((e) => e.type === "loop.plan.discarded");
    expect(discardEvents.length).toBeGreaterThan(0);
  });

  test("multiple feedback rounds", async () => {
    // 1. Create loop
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a detailed plan",
        name: "Test Loop",
      directory: ctx.workDir,
      maxIterations: 1,
      planMode: true,
      workspaceId: testWorkspaceId,
    });
    const loopId = loop.config.id;

    // Start plan mode
    await ctx.manager.startPlanMode(loopId);

    // 2. Wait for plan to be ready before sending feedback
    await waitForPlanReady(ctx.manager, loopId);

    // 3. Send feedback 3 times (each awaits the iteration)
    await ctx.manager.sendPlanFeedback(loopId, "Feedback round 1");
    await ctx.manager.sendPlanFeedback(loopId, "Feedback round 2");
    await ctx.manager.sendPlanFeedback(loopId, "Feedback round 3");

    // 4. Verify round counter is 3
    let loopData: Loop | null = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.planMode?.feedbackRounds).toBe(3);

    // 5. Verify feedback events were emitted
    const feedbackEvents = ctx.events.filter((e) => e.type === "loop.plan.feedback");
    expect(feedbackEvents.length).toBe(3);

    // 6. Wait for plan to be ready before accepting
    await waitForPlanReady(ctx.manager, loopId);

    // 7. Accept and wait for execution to start
    await ctx.manager.acceptPlan(loopId);
    const finalLoop = await waitForLoopStatus(ctx.manager, loopId, ["running", "completed", "max_iterations", "stopped"]);
    expect(["running", "completed", "max_iterations", "stopped"]).toContain(finalLoop.state.status);

    // 8. Verify accept event was emitted
    const acceptEvents = ctx.events.filter((e) => e.type === "loop.plan.accepted");
    expect(acceptEvents.length).toBe(1);
  });

  test("plan mode with clearPlanningFolder preserves plan after acceptance", async () => {
    // Setup: Create existing files to be cleared and commit them to git
    // (files must be committed so they appear in the worktree checkout)
    const planningDir = join(ctx.workDir, ".planning");
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, "old-file.md"), "Old content");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add old planning file"`.quiet();

    // Create loop with clearPlanningFolder enabled
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
      directory: ctx.workDir,
      maxIterations: 1,
      clearPlanningFolder: true,
      planMode: true,
      workspaceId: testWorkspaceId,
    });
    const loopId = loop.config.id;

    // Start plan mode (this is when clearing happens)
    await ctx.manager.startPlanMode(loopId);
    
    // Wait for plan to be ready (ensures plan mode started and clearing happened)
    await waitForPlanReady(ctx.manager, loopId);

    // Get the worktree path — clearing happens there, not in ctx.workDir
    const loopData2 = await ctx.manager.getLoop(loopId);
    const worktreePath = loopData2!.state.git?.worktreePath;
    expect(worktreePath).toBeDefined();
    const wtPlanningDir = join(worktreePath!, ".planning");

    // Verify old file was cleared in the worktree
    expect(await exists(join(wtPlanningDir, "old-file.md"))).toBe(false);

    // Create new plan in the worktree (simulating AI)
    await writeFile(join(wtPlanningDir, "plan.md"), "# New Plan");
    await writeFile(join(wtPlanningDir, "status.md"), "Status: In progress");

    // Verify new files exist in the worktree
    expect(await exists(join(wtPlanningDir, "plan.md"))).toBe(true);
    expect(await exists(join(wtPlanningDir, "status.md"))).toBe(true);

    // Accept the plan
    await ctx.manager.acceptPlan(loopId);
    
    // Wait for transition from planning
    await waitForLoopStatus(ctx.manager, loopId, ["running", "completed", "max_iterations", "stopped"]);

    // Verify files still exist in the worktree (not cleared on accept)
    expect(await exists(join(wtPlanningDir, "plan.md"))).toBe(true);
    expect(await exists(join(wtPlanningDir, "status.md"))).toBe(true);

    // Verify planningFolderCleared flag is set
    const loopData: Loop | null = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.planMode?.planningFolderCleared).toBe(true);
  });

  test("session continuity from planning to execution", async () => {
    // Create loop with plan mode
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
      directory: ctx.workDir,
      maxIterations: 1,
      planMode: true,
      workspaceId: testWorkspaceId,
    });
    const loopId = loop.config.id;

    // Start plan mode
    await ctx.manager.startPlanMode(loopId);
    
    // Wait for plan to be ready (polling instead of fixed delay)
    await waitForPlanReady(ctx.manager, loopId);

    // Get the planning session ID from state.session (where it's stored during planning)
    let loopData: Loop | null = await ctx.manager.getLoop(loopId);
    const planSessionId = loopData!.state.session?.id;
    expect(planSessionId).toBeDefined();

    // Send feedback (uses same session, awaits iteration)
    await ctx.manager.sendPlanFeedback(loopId, "Add more details");

    // Verify session ID unchanged (still in state.session during planning)
    loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.session?.id).toBe(planSessionId);

    // Wait for plan to be ready before accepting
    await waitForPlanReady(ctx.manager, loopId);

    // Accept plan (transitions to execution with same session)
    await ctx.manager.acceptPlan(loopId);
    
    // Wait for transition from planning
    loopData = await waitForLoopStatus(ctx.manager, loopId, ["running", "completed", "max_iterations", "stopped"]);

    // Verify session ID preserved in both places after acceptance
    expect(loopData!.state.planMode?.planSessionId).toBe(planSessionId);
    expect(loopData!.state.session?.id).toBe(planSessionId);
    expect(["running", "completed", "max_iterations", "stopped"]).toContain(loopData!.state.status);
  });

  test("isPlanReady flag workflow: starts false, becomes true, button controls", async () => {
    // 1. Create loop with plan mode
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Loop",
      directory: ctx.workDir,
      maxIterations: 1,
      planMode: true,
      workspaceId: testWorkspaceId,
    });
    const loopId = loop.config.id;

    // 2. Verify isPlanReady is false initially
    let loopData: Loop | null = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.planMode?.isPlanReady).toBe(false);

    // 3. Start plan mode
    await ctx.manager.startPlanMode(loopId);
    
    // 4. Wait for plan to be ready (polling instead of fixed delay)
    loopData = await waitForPlanReady(ctx.manager, loopId);

    // 5. Verify isPlanReady is now true
    expect(loopData!.state.planMode?.isPlanReady).toBe(true);

    // 6. Send feedback - with fast mocks, isPlanReady may already be true again
    // after sendPlanFeedback returns because it awaits the entire iteration
    await ctx.manager.sendPlanFeedback(loopId, "Add time estimates");
    
    // 7. Wait for plan to be ready again after feedback
    loopData = await waitForPlanReady(ctx.manager, loopId);
    
    // 8. Verify isPlanReady is true
    expect(loopData!.state.planMode?.isPlanReady).toBe(true);

    // 9. Accept the plan
    await ctx.manager.acceptPlan(loopId);
    
    // 10. Wait for and verify loop has transitioned from planning
    loopData = await waitForLoopStatus(ctx.manager, loopId, ["running", "completed", "max_iterations", "stopped"]);
    expect(["running", "completed", "max_iterations", "stopped"]).toContain(loopData!.state.status);
  });
});
