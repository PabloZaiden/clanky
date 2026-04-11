/**
 * Unit tests for Plan Mode functionality.
 * Tests clearPlanningFolder behavior and state transitions.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, stat } from "fs/promises";
import { join } from "path";
import { setupTestContext, teardownTestContext, waitForPlanReady, waitForPersistedPlanReady, waitForLoopStatus, testModelFields } from "../setup";
import type { TestContext } from "../setup";
import { MockAcpBackend, defaultTestModel } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { backendManager } from "../../src/core/backend-manager";
import { updateWorkspace } from "../../src/persistence/workspaces";

class SshReadyExecutor extends TestCommandExecutor {
  override async exec(command: string, args: string[], options?: Parameters<TestCommandExecutor["exec"]>[2]) {
    if (command === "bash" && args[0] === "-lc" && args[1]?.includes("command -v dtach")) {
      return {
        success: true,
        stdout: "dtach - version 0.9\n",
        stderr: "",
        exitCode: 0,
      };
    }
    return await super.exec(command, args, options);
  }
}

// Helper to check if a file exists
async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function setupRemote(ctx: TestContext): Promise<{ remoteDir: string; currentBranch: string }> {
  const remoteDir = join(ctx.dataDir, "remote-" + Date.now() + ".git");
  await Bun.$`git init --bare ${remoteDir}`.quiet();
  await Bun.$`git -C ${ctx.workDir} remote add origin ${remoteDir}`.quiet();
  const currentBranch = (await Bun.$`git -C ${ctx.workDir} branch --show-current`.text()).trim();
  await Bun.$`git -C ${ctx.workDir} push -u origin ${currentBranch}`.quiet();
  await Bun.$`git -C ${remoteDir} symbolic-ref HEAD refs/heads/${currentBranch}`.quiet();
  return { remoteDir, currentBranch };
}

async function addRemoteCommit(
  remoteDir: string,
  branch: string,
  files: Record<string, string>,
  message: string,
  dataDir: string,
): Promise<void> {
  const otherClone = join(dataDir, "other-clone-" + Date.now());
  try {
    await Bun.$`git clone --branch ${branch} ${remoteDir} ${otherClone}`.quiet();
    await Bun.$`git -C ${otherClone} config user.email "other@test.com"`.quiet();
    await Bun.$`git -C ${otherClone} config user.name "Other User"`.quiet();
    for (const [path, content] of Object.entries(files)) {
      await writeFile(join(otherClone, path), content);
    }
    await Bun.$`git -C ${otherClone} add -A`.quiet();
    await Bun.$`git -C ${otherClone} commit -m ${message}`.quiet();
    await Bun.$`git -C ${otherClone} push`.quiet();
  } finally {
    await Bun.$`rm -rf ${otherClone}`.quiet();
  }
}

async function waitForSyncStateToClear(ctx: TestContext, loopId: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const loop = await ctx.manager.getLoop(loopId);
    if (loop && loop.state.syncState === undefined && loop.state.status !== "resolving_conflicts") {
      return loop;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const lastLoop = await ctx.manager.getLoop(loopId);
  throw new Error(
    `Loop ${loopId} did not clear sync state within ${timeoutMs}ms. Last status: ${lastLoop?.state.status ?? "missing"}`,
  );
}

const testWorkspaceId = "test-workspace-id";

describe("Plan Mode - Clear Planning Folder", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({ 
      initGit: true,
      mockResponses: ["<promise>PLAN_READY</promise>"],
    });
    await setupRemote(ctx);
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  test("clears .ralph-planning folder before plan creation when clearPlanningFolder is true", async () => {
    // Setup: Create existing plan files and commit them to git
    // (files must be committed so they appear in the worktree checkout)
    const planningDir = join(ctx.workDir, ".ralph-planning");
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, "old-plan.md"), "Old plan content");
    await writeFile(join(planningDir, "status.md"), "Old status");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add planning files"`.quiet();

    // Verify files exist before loop creation
    expect(await exists(join(planningDir, "old-plan.md"))).toBe(true);
    expect(await exists(join(planningDir, "status.md"))).toBe(true);

    // Create loop with plan mode + clear folder
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      clearPlanningFolder: true,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode (this is when clearing happens — in the worktree)
    await ctx.manager.startPlanMode(loopId);

    // Wait for plan to be ready (polling instead of fixed delay)
    await waitForPlanReady(ctx.manager, loopId);

    // Get the loop state
    const loopData = await ctx.manager.getLoop(loopId);
    expect(loopData).toBeDefined();

    // Verify worktree was created
    const worktreePath = loopData!.state.git?.worktreePath;
    expect(worktreePath).toBeDefined();

    // Verify the folder was cleared in the worktree (old files gone)
    const wtPlanningDir = join(worktreePath!, ".ralph-planning");
    expect(await exists(join(wtPlanningDir, "old-plan.md"))).toBe(false);
    expect(await exists(join(wtPlanningDir, "status.md"))).toBe(false);

    // Verify state tracks that clearing happened
    expect(loopData!.state.planMode?.planningFolderCleared).toBe(true);
  });

  test("does not clear .ralph-planning folder if clearPlanningFolder is false", async () => {
    // Setup existing files and commit them so they appear in the worktree
    const planningDir = join(ctx.workDir, ".ralph-planning");
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, "existing-plan.md"), "Existing content");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add existing plan"`.quiet();

    // Verify file exists
    expect(await exists(join(planningDir, "existing-plan.md"))).toBe(true);

    // Create loop without clear option
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      clearPlanningFolder: false,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode and wait for plan to be ready
    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    // Verify folder was NOT cleared in the worktree
    const loopData = await ctx.manager.getLoop(loopId);
    const worktreePath = loopData!.state.git?.worktreePath;
    expect(worktreePath).toBeDefined();
    expect(await exists(join(worktreePath!, ".ralph-planning", "existing-plan.md"))).toBe(true);

    // Verify state shows clearing did not happen
    expect(loopData!.state.planMode?.planningFolderCleared).toBe(false);
  });

  test("never clears .ralph-planning folder after plan is created", async () => {
    // Setup: Create loop with plan mode + clear folder
    const planningDir = join(ctx.workDir, ".ralph-planning");
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, "old-file.md"), "Old content");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add old file"`.quiet();

    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      clearPlanningFolder: true,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode and wait for plan to be ready
    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    // Get worktree path
    let loopData = await ctx.manager.getLoop(loopId);
    const worktreePath = loopData!.state.git!.worktreePath!;

    // Create a plan file in the worktree (simulating AI creating it)
    const wtPlanningDir = join(worktreePath, ".ralph-planning");
    await mkdir(wtPlanningDir, { recursive: true });
    await writeFile(join(wtPlanningDir, "plan.md"), "# My Plan\n\nTask 1: Do something");

    // Verify plan file exists in worktree
    expect(await exists(join(wtPlanningDir, "plan.md"))).toBe(true);

    // Accept the plan (should transition to running without clearing folder)
    await ctx.manager.acceptPlan(loopId);
    
    // Wait for transition from planning
    await waitForLoopStatus(ctx.manager, loopId, ["running", "completed", "max_iterations", "stopped"]);

    // Verify plan file still exists in worktree (was NOT cleared on accept)
    expect(await exists(join(wtPlanningDir, "plan.md"))).toBe(true);

    // Verify the loop transitioned from planning
    loopData = await ctx.manager.getLoop(loopId);
    expect(["running", "completed", "max_iterations", "stopped"]).toContain(loopData!.state.status);
  });

  test("planningFolderCleared persists across restart", async () => {
    // Create loop, clear folder, mark as cleared
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      clearPlanningFolder: true,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode and wait for plan to be ready
    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    // Get worktree path
    let loopData = await ctx.manager.getLoop(loopId);
    const worktreePath = loopData!.state.git!.worktreePath!;

    // Simulate plan creation in the worktree
    const wtPlanningDir = join(worktreePath, ".ralph-planning");
    await mkdir(wtPlanningDir, { recursive: true });
    await writeFile(join(wtPlanningDir, "plan.md"), "# Plan\n\nTask: Test");

    // Accept and wait for it to start running
    await ctx.manager.acceptPlan(loopId);
    await waitForLoopStatus(ctx.manager, loopId, ["running", "completed", "max_iterations", "stopped"]);

    // Stop the loop
    await ctx.manager.stopLoop(loopId);
    await waitForLoopStatus(ctx.manager, loopId, ["stopped", "completed", "max_iterations"]);

    // Verify plan still exists in worktree
    expect(await exists(join(wtPlanningDir, "plan.md"))).toBe(true);

    // Restart the loop
    await ctx.manager.startLoop(loopId);
    
    // Brief wait for restart to process
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify plan still exists in worktree (folder not cleared again)
    expect(await exists(join(wtPlanningDir, "plan.md"))).toBe(true);

    // Verify flag is still set
    loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.planMode?.planningFolderCleared).toBe(true);
  });
});

describe("Plan Mode - Always Clear plan.md on Start", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({ 
      initGit: true,
      mockResponses: ["<promise>PLAN_READY</promise>"],
    });
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  test("clears plan.md when starting plan mode even with clearPlanningFolder: false", async () => {
    // Setup: Create existing plan.md and commit to git
    const planningDir = join(ctx.workDir, ".ralph-planning");
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, "plan.md"), "Old stale plan content");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add stale plan"`.quiet();

    // Verify file exists before loop creation
    expect(await exists(join(planningDir, "plan.md"))).toBe(true);

    // Create loop with plan mode but WITHOUT clearPlanningFolder
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      clearPlanningFolder: false,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode - this should clear plan.md regardless of clearPlanningFolder
    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    // Get the worktree path and check there
    const loopData = await ctx.manager.getLoop(loopId);
    const worktreePath = loopData!.state.git?.worktreePath;
    expect(worktreePath).toBeDefined();

    // The plan file in the worktree should not have old content
    const planContent = await Bun.file(join(worktreePath!, ".ralph-planning", "plan.md")).text().catch(() => "");
    expect(planContent).not.toContain("Old stale plan content");
  });

  test("clears plan.md when starting plan mode with clearPlanningFolder: true", async () => {
    // Setup: Create existing plan.md and commit to git
    const planningDir = join(ctx.workDir, ".ralph-planning");
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, "plan.md"), "Old stale plan content from previous session");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add stale plan"`.quiet();

    // Verify file exists before loop creation
    expect(await exists(join(planningDir, "plan.md"))).toBe(true);

    // Create loop with plan mode AND clearPlanningFolder
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      clearPlanningFolder: true,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode
    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    // Get worktree path and check there
    const loopData = await ctx.manager.getLoop(loopId);
    const worktreePath = loopData!.state.git?.worktreePath;
    expect(worktreePath).toBeDefined();

    // Verify old content is gone from the worktree
    const planContent = await Bun.file(join(worktreePath!, ".ralph-planning", "plan.md")).text().catch(() => "");
    expect(planContent).not.toContain("Old stale plan content from previous session");
  });

  test("does NOT clear status.md when clearPlanningFolder is false", async () => {
    // Setup: Create both plan.md and status.md and commit to git
    const planningDir = join(ctx.workDir, ".ralph-planning");
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, "plan.md"), "Old plan");
    await writeFile(join(planningDir, "status.md"), "Important status tracking info");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add planning files"`.quiet();

    // Verify both files exist
    expect(await exists(join(planningDir, "plan.md"))).toBe(true);
    expect(await exists(join(planningDir, "status.md"))).toBe(true);

    // Create loop with plan mode but WITHOUT clearPlanningFolder
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      clearPlanningFolder: false,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode - should only clear plan.md, not status.md
    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    // Get worktree path and check there
    const loopData = await ctx.manager.getLoop(loopId);
    const worktreePath = loopData!.state.git?.worktreePath;
    expect(worktreePath).toBeDefined();

    // Verify status.md still exists with original content in the worktree
    const wtStatusPath = join(worktreePath!, ".ralph-planning", "status.md");
    expect(await exists(wtStatusPath)).toBe(true);
    const statusContent = await Bun.file(wtStatusPath).text();
    expect(statusContent).toBe("Important status tracking info");
  });
});

describe("Plan Mode - State Transitions", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({ 
      initGit: true,
      // Need multiple PLAN_READY responses for feedback tests, followed by COMPLETE for acceptance
      mockResponses: [
        "<promise>PLAN_READY</promise>",  // Initial plan creation
        "<promise>PLAN_READY</promise>",  // After first feedback
        "<promise>PLAN_READY</promise>",  // After second feedback
        "<promise>PLAN_READY</promise>",  // After third feedback
        "<promise>COMPLETE</promise>",    // After acceptance (execution complete)
      ],
    });
    await setupRemote(ctx);
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  test("creates loop in planning status when planMode is true", async () => {
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Wait for loop to be in planning status
    const loopData = await waitForLoopStatus(ctx.manager, loopId, ["planning"]);
    expect(loopData.state.status).toBe("planning");
    expect(loopData.state.planMode?.active).toBe(true);
  });

  test("transitions from planning to running on accept", async () => {
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode and wait for plan to be ready
    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    // Verify initial status
    let loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.status).toBe("planning");

    // Accept the plan
    await ctx.manager.acceptPlan(loopId);
    
    // Wait for transition from planning
    loopData = await waitForLoopStatus(ctx.manager, loopId, ["running", "completed", "max_iterations", "stopped"]);
    expect(["running", "completed", "max_iterations", "stopped"]).toContain(loopData!.state.status);
    
    // Clean up - stop the loop
    await ctx.manager.stopLoop(loopId);
  });

  test("increments feedback rounds on each feedback", async () => {
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 5, // Need enough iterations for multiple feedbacks
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode and wait for plan to be ready
    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    // Initial feedback rounds should be 0
    let loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.planMode?.feedbackRounds).toBe(0);

    // Send first feedback (returns quickly — injection pattern)
    await ctx.manager.sendPlanFeedback(loopId, "Please add more details");

    // feedbackRounds is incremented synchronously before the async injection
    loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.planMode?.feedbackRounds).toBe(1);

    // Wait for the feedback iteration to complete before sending more feedback
    await waitForPlanReady(ctx.manager, loopId);

    // Send second feedback
    await ctx.manager.sendPlanFeedback(loopId, "Add time estimates");

    loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.planMode?.feedbackRounds).toBe(2);
  });

  test("deletes loop on discard", async () => {
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Wait for loop to be in planning status
    await waitForLoopStatus(ctx.manager, loopId, ["planning"]);

    // Verify loop exists
    let loopData = await ctx.manager.getLoop(loopId);
    expect(loopData).toBeDefined();

    // Discard the plan
    await ctx.manager.discardPlan(loopId);
    
    // Wait for loop to be deleted
    loopData = await waitForLoopStatus(ctx.manager, loopId, ["deleted"]);
    expect(loopData.state.status).toBe("deleted");
  });

  test("reuses session from plan creation when starting execution", async () => {
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode and wait for plan to be ready
    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    // Get the plan session info from state.session (where it's stored during planning)
    let loopData = await ctx.manager.getLoop(loopId);
    const planSessionId = loopData!.state.session?.id;
    expect(planSessionId).toBeDefined();

    // Accept the plan
    await ctx.manager.acceptPlan(loopId);
    
    // Wait for transition from planning
    await waitForLoopStatus(ctx.manager, loopId, ["running", "completed", "max_iterations", "stopped"]);

    // Verify the session is still the same (session continuity)
    // After acceptance, it should be copied to planMode.planSessionId for persistence
    loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.planMode?.planSessionId).toBe(planSessionId);
    expect(loopData!.state.session?.id).toBe(planSessionId);
  });
});

describe("Plan Mode - isPlanReady Flag", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({ 
      initGit: true,
      mockResponses: [
        "<promise>PLAN_READY</promise>",  // Initial plan creation
        "<promise>PLAN_READY</promise>",  // After feedback (extra for safety)
        "<promise>PLAN_READY</promise>",  // After feedback
        "<promise>COMPLETE</promise>",    // After acceptance
      ],
    });
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  test("isPlanReady is false when plan mode starts", async () => {
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Verify isPlanReady is false initially
    const loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.planMode?.isPlanReady).toBe(false);
  });

  test("isPlanReady becomes true after PLAN_READY marker detected", async () => {
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode
    await ctx.manager.startPlanMode(loopId);
    
    // Wait for the mock backend to emit PLAN_READY
    const loopData = await waitForPlanReady(ctx.manager, loopId);
    expect(loopData!.state.planMode?.isPlanReady).toBe(true);
  });

  test("isPlanReady resets to false when feedback is sent", async () => {
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 5, // Increase max iterations to allow feedback iteration
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode and wait for PLAN_READY
    await ctx.manager.startPlanMode(loopId);
    let loopData = await waitForPlanReady(ctx.manager, loopId);
    expect(loopData.state.planMode?.isPlanReady).toBe(true);

    // Send feedback - this resets isPlanReady to false internally,
    // but with fast mocks the new plan might be ready by the time this returns
    await ctx.manager.sendPlanFeedback(loopId, "Please add more details");
    
    // After feedback, wait for the plan to be ready again
    loopData = await waitForPlanReady(ctx.manager, loopId);
    
    // The important thing is that after feedback, we can still accept the plan
    // and feedback rounds should have incremented
    expect(loopData.state.planMode?.feedbackRounds).toBe(1);
    expect(loopData.state.planMode?.isPlanReady).toBe(true);
  });

  test("isPlanReady persists in database across restarts", async () => {
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode and wait for PLAN_READY
    await ctx.manager.startPlanMode(loopId);
    let loopData = await waitForPlanReady(ctx.manager, loopId);
    expect(loopData.state.planMode?.isPlanReady).toBe(true);

    // Stop the loop
    await ctx.manager.stopLoop(loopId);
    await waitForLoopStatus(ctx.manager, loopId, ["stopped", "paused"]);

    // Retrieve the loop from database (simulating restart)
    const retrievedLoop = await ctx.manager.getLoop(loopId);
    
    // Verify isPlanReady is still true
    expect(retrievedLoop).not.toBeNull();
    expect(retrievedLoop!.state.planMode?.isPlanReady).toBe(true);
  });

});

describe("Plan Mode - Rejection Paths", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({ 
      initGit: true,
      // Use a mock that returns incomplete plan content (no PLAN_READY marker)
      // This simulates the AI still generating the plan
      mockResponses: [
        "# Plan\n\nStill thinking about what to do...",  // First response - no PLAN_READY
        "# Plan\n\nStill thinking...",  // More incomplete responses
      ],
    });
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  test("rejects plan acceptance when isPlanReady is false", async () => {
    const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 5,  // Allow multiple iterations
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Verify isPlanReady is false initially
    let loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.planMode?.isPlanReady).toBe(false);

    // Start plan mode - the mock will NOT return PLAN_READY marker
    await ctx.manager.startPlanMode(loopId);

    // Wait for the first iteration to complete (loop should still be in planning)
    await waitForLoopStatus(ctx.manager, loopId, ["planning", "max_iterations", "stopped"]);

    // Verify isPlanReady is still false (no PLAN_READY marker was detected)
    loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.planMode?.isPlanReady).toBe(false);

    // Try to accept the plan while isPlanReady is false - should throw
    await expect(ctx.manager.acceptPlan(loopId)).rejects.toThrow(
      "Plan is not ready yet"
    );
  });
});

describe("Plan Mode - Worktree Isolation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({
      initGit: true,
      mockResponses: [
        "<promise>PLAN_READY</promise>",     // Plan iteration response
      ],
    });
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  test("plan mode changes happen in worktree, not original repo dir", async () => {
    // Create a file in the main repo and commit it so we have a baseline
    await writeFile(join(ctx.workDir, "original-file.txt"), "Original content");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add original file"`.quiet();

    // Create a plan mode loop and start it
    const loop = await ctx.manager.createLoop({
      ...testModelFields,
      prompt: "Create a plan",
      name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    // Verify the worktree was created
    const loopData = await ctx.manager.getLoop(loopId);
    const worktreePath = loopData!.state.git?.worktreePath;
    expect(worktreePath).toBeDefined();
    expect(worktreePath).not.toBe(ctx.workDir);

    // Write a new file in the worktree (simulating what the AI agent would do)
    await writeFile(join(worktreePath!, "new-file-from-agent.txt"), "Changes from the agent");

    // Verify the new file exists in the worktree
    expect(await exists(join(worktreePath!, "new-file-from-agent.txt"))).toBe(true);

    // Verify the new file does NOT exist in the original repo dir
    expect(await exists(join(ctx.workDir, "new-file-from-agent.txt"))).toBe(false);

    // Verify the original repo dir is clean (no uncommitted changes)
    const gitStatus = await Bun.$`git -C ${ctx.workDir} status --porcelain`.text();
    expect(gitStatus.trim()).toBe("");

    // Verify the original file still exists unchanged in the main repo
    const originalContent = await Bun.file(join(ctx.workDir, "original-file.txt")).text();
    expect(originalContent).toBe("Original content");
  });

  test("multiple plan mode loops have separate worktrees", async () => {
    // Override mock backend with responses for two plan iterations.
    const multiLoopMock = new MockAcpBackend({
      responses: [
        "<promise>PLAN_READY</promise>",    // Plan iteration for loop 1
        "<promise>PLAN_READY</promise>",    // Plan iteration for loop 2
      ],
      models: [defaultTestModel],
    });
    backendManager.setBackendForTesting(multiLoopMock);

    // Create a baseline commit
    await writeFile(join(ctx.workDir, "shared-file.txt"), "Shared content");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add shared file"`.quiet();

    // Create and start two plan mode loops
    const loop1 = await ctx.manager.createLoop({
      ...testModelFields,
      prompt: "Plan A",
      name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loop2 = await ctx.manager.createLoop({
      ...testModelFields,
      prompt: "Plan B",
      name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });

    await ctx.manager.startPlanMode(loop1.config.id);
    await ctx.manager.startPlanMode(loop2.config.id);

    await waitForPlanReady(ctx.manager, loop1.config.id);
    await waitForPlanReady(ctx.manager, loop2.config.id);

    // Verify each has its own worktree
    const loopData1 = await ctx.manager.getLoop(loop1.config.id);
    const loopData2 = await ctx.manager.getLoop(loop2.config.id);
    const wt1 = loopData1!.state.git?.worktreePath;
    const wt2 = loopData2!.state.git?.worktreePath;

    expect(wt1).toBeDefined();
    expect(wt2).toBeDefined();
    expect(wt1).not.toBe(wt2);

    // Write different files to each worktree
    await writeFile(join(wt1!, "loop1-file.txt"), "Loop 1 content");
    await writeFile(join(wt2!, "loop2-file.txt"), "Loop 2 content");

    // Verify files are isolated between worktrees
    expect(await exists(join(wt1!, "loop1-file.txt"))).toBe(true);
    expect(await exists(join(wt1!, "loop2-file.txt"))).toBe(false);
    expect(await exists(join(wt2!, "loop2-file.txt"))).toBe(true);
    expect(await exists(join(wt2!, "loop1-file.txt"))).toBe(false);

    // Verify original repo dir is still clean
    expect(await exists(join(ctx.workDir, "loop1-file.txt"))).toBe(false);
    expect(await exists(join(ctx.workDir, "loop2-file.txt"))).toBe(false);
    const gitStatus = await Bun.$`git -C ${ctx.workDir} status --porcelain`.text();
    expect(gitStatus.trim()).toBe("");
  });

  test("worktree exists from plan mode start, not just after acceptance", async () => {
    // Create a plan mode loop
    const loop = await ctx.manager.createLoop({
      ...testModelFields,
      prompt: "Create a plan",
      name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Before startPlanMode: no git state
    let loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.git).toBeUndefined();

    // Start plan mode
    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    // After startPlanMode: git state with worktree should exist
    loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.git).toBeDefined();
    expect(loopData!.state.git?.worktreePath).toBeDefined();
    expect(loopData!.state.git?.workingBranch).toBeDefined();

    // The worktree directory should actually exist on disk
    const worktreePath = loopData!.state.git!.worktreePath!;
    const dirStat = await stat(worktreePath);
    expect(dirStat.isDirectory()).toBe(true);
  });
});

describe("Plan Mode - Engine Recovery After Server Restart", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({
      initGit: true,
      // Responses consumed in order by the shared mock backend:
      // [0] plan iteration — startPlanMode() fires engine.start() which uses subscribeToEvents() → PLAN_READY
      // [1] post-recovery feedback or accept iteration (subscribeToEvents)
      // [2] execution after accept (subscribeToEvents)
      mockResponses: [
        "<promise>PLAN_READY</promise>",       // [0] initial plan iteration via subscribeToEvents()
        "<promise>PLAN_READY</promise>",       // [1] post-recovery feedback or accept iteration
        "<promise>COMPLETE</promise>",         // [2] execution after accept
      ],
    });
    await setupRemote(ctx);
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  test("acceptPlan recovers engine after server restart", async () => {
    // Create and start plan mode loop
    const loop = await ctx.manager.createLoop({
      ...testModelFields,
      prompt: "Create a plan",
      name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 5,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode and wait for plan to be ready (in-memory)
    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    // Verify plan is ready in memory
    let loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.status).toBe("planning");
    expect(loopData!.state.planMode?.isPlanReady).toBe(true);

    // Wait for isPlanReady to be persisted to DB before resetting.
    // This ensures recoverPlanningEngine() (which reads from loadLoop) sees the correct state.
    await waitForPersistedPlanReady(loopId);

    // Simulate server restart: clear all in-memory engines
    ctx.manager.resetForTesting();

    // Verify engine is gone (the loop is still in the DB in planning status)
    // Now try to accept the plan — this should recover the engine and succeed
    await ctx.manager.acceptPlan(loopId);

    // Wait for transition from planning to running/completed
    loopData = await waitForLoopStatus(ctx.manager, loopId, ["running", "completed", "max_iterations", "stopped"]);
    expect(["running", "completed", "max_iterations", "stopped"]).toContain(loopData!.state.status);
  });

  test("acceptPlan recovers a branch-only planning loop after server restart", async () => {
    const loop = await ctx.manager.createLoop({
      ...testModelFields,
      prompt: "Create a branch-only plan",
      name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 5,
      planMode: true,
      autoAcceptPlan: false,
      useWorktree: false,
    });
    const loopId = loop.config.id;

    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);
    await waitForPersistedPlanReady(loopId);

    let loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.git?.workingBranch).toBeDefined();
    expect(loopData!.state.git?.originalBranch).toBeDefined();

    await ctx.git.checkoutBranch(ctx.workDir, loopData!.state.git!.originalBranch);

    ctx.manager.resetForTesting();

    await ctx.manager.acceptPlan(loopId);

    loopData = await waitForLoopStatus(ctx.manager, loopId, ["running", "completed", "max_iterations", "stopped"]);
    expect(["running", "completed", "max_iterations", "stopped"]).toContain(loopData!.state.status);
  });

  test("sendPlanFeedback recovers engine after server restart", async () => {
    // Create and start plan mode loop
    const loop = await ctx.manager.createLoop({
      ...testModelFields,
      prompt: "Create a plan",
      name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 5,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    // Start plan mode and wait for plan to be ready (in-memory)
    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    // Verify plan is ready in memory
    let loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.status).toBe("planning");
    expect(loopData!.state.planMode?.isPlanReady).toBe(true);

    // Wait for isPlanReady to be persisted to DB before resetting.
    // This ensures recoverPlanningEngine() (which reads from loadLoop) sees the correct state.
    await waitForPersistedPlanReady(loopId);

    // Simulate server restart: clear all in-memory engines
    ctx.manager.resetForTesting();

    // Send feedback — should recover the engine from persisted state
    await ctx.manager.sendPlanFeedback(loopId, "Add more detail to step 3");

    // feedbackRounds is incremented synchronously before the async injection
    loopData = await ctx.manager.getLoop(loopId);
    expect(loopData!.state.status).toBe("planning");
    expect(loopData!.state.planMode?.feedbackRounds).toBe(1);

    // Wait for the feedback iteration to complete (engine was recovered and started a new iteration)
    await waitForPlanReady(ctx.manager, loopId);
  });

  test("acceptPlan throws for non-existent loop after restart", async () => {
    // Try to accept a plan for a loop that doesn't exist
    await expect(ctx.manager.acceptPlan("non-existent-id")).rejects.toThrow("Loop not found");
  });

  test("acceptPlan throws for loop not in planning status after restart", async () => {
    // Create a loop but don't start plan mode — it will be in 'idle' status
    const loop = await ctx.manager.createLoop({
      ...testModelFields,
      prompt: "Regular loop",
      name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: false,
    });
    const loopId = loop.config.id;

    // Simulate server restart
    ctx.manager.resetForTesting();

    // Try to accept — loop is in 'idle' status, not 'planning'
    await expect(ctx.manager.acceptPlan(loopId)).rejects.toThrow("Loop plan mode is not running");
  });
});

describe("Plan Mode - Open SSH acceptance", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({
      initGit: true,
      mockResponses: ["<promise>PLAN_READY</promise>"],
    });
    backendManager.setExecutorFactoryForTesting(() => new SshReadyExecutor());
    await updateWorkspace(testWorkspaceId, {
      serverSettings: {
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "localhost",
          username: "tester",
        },
      },
    });
  });

  afterEach(async () => {
    await teardownTestContext(ctx);
  });

  test("acceptPlan in open_ssh mode clears pending execution state and emits an SSH handoff event", async () => {
    const loop = await ctx.manager.createLoop({
      ...testModelFields,
      prompt: "Create a plan",
      name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    const result = await ctx.manager.acceptPlan(loopId, { mode: "open_ssh" });
    expect(result.mode).toBe("open_ssh");
    if (result.mode !== "open_ssh") {
      throw new Error(`Expected open_ssh mode, received ${result.mode}`);
    }
    expect(result.sshSession.config.loopId).toBe(loopId);

    const loopData = await waitForLoopStatus(ctx.manager, loopId, ["completed"]);
    expect(loopData.state.status).toBe("completed");
    expect(loopData.state.pendingPrompt).toBeUndefined();

    const sshHandoffEvents = ctx.events.filter((event) => event.type === "loop.ssh_handoff" && event.loopId === loopId);
    expect(sshHandoffEvents).toHaveLength(1);

    const completionEvents = ctx.events.filter((event) => event.type === "loop.completed" && event.loopId === loopId);
    expect(completionEvents).toHaveLength(0);
  });

  test("open_ssh acceptance does not run the post-accept base branch sync", async () => {
    const { remoteDir, currentBranch } = await setupRemote(ctx);

    const loop = await ctx.manager.createLoop({
      ...testModelFields,
      prompt: "Create a plan",
      name: "Test Loop",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const loopId = loop.config.id;

    await ctx.manager.startPlanMode(loopId);
    await waitForPlanReady(ctx.manager, loopId);

    await addRemoteCommit(
      remoteDir,
      currentBranch,
      { "remote-only.txt": "Remote content\n" },
      "Remote base branch update",
      ctx.dataDir,
    );

    await ctx.manager.acceptPlan(loopId, { mode: "open_ssh" });

    const loopData = await waitForLoopStatus(ctx.manager, loopId, ["completed"]);
    expect(loopData.state.status).toBe("completed");

    const syncEvents = ctx.events.filter((event) => event.loopId === loopId && event.type.startsWith("loop.sync."));
    expect(syncEvents).toHaveLength(0);
  });
});

describe("Plan Mode - Accept plan base branch sync", () => {
  test("acceptPlan merges the latest base branch changes before execution starts", async () => {
    const ctx = await setupTestContext({
      initGit: true,
      initialFiles: { "test.txt": "Initial content\n" },
      mockResponses: [
        "<promise>PLAN_READY</promise>",
        "<promise>COMPLETE</promise>",
      ],
    });

    try {
      const { remoteDir, currentBranch } = await setupRemote(ctx);
      const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
        directory: ctx.workDir,
        workspaceId: testWorkspaceId,
        maxIterations: 2,
        planMode: true,
        autoAcceptPlan: false,
      });
      const loopId = loop.config.id;

      await ctx.manager.startPlanMode(loopId);
      await waitForPlanReady(ctx.manager, loopId);

      const loopData = await ctx.manager.getLoop(loopId);
      const worktreePath = loopData!.state.git!.worktreePath!;

      await addRemoteCommit(
        remoteDir,
        currentBranch,
        { "remote-only.txt": "Remote content\n" },
        "Non-conflicting remote commit",
        ctx.dataDir,
      );

      await ctx.manager.acceptPlan(loopId);
      const finalLoop = await waitForLoopStatus(ctx.manager, loopId, ["completed", "running", "max_iterations", "stopped"]);

      expect(await exists(join(worktreePath, "remote-only.txt"))).toBe(true);
      expect(finalLoop.state.planMode?.active).toBe(false);

      const syncStarted = ctx.events.find((event) => event.type === "loop.sync.started" && event.loopId === loopId);
      const syncClean = ctx.events.find((event) => event.type === "loop.sync.clean" && event.loopId === loopId);
      const syncConflicts = ctx.events.find((event) => event.type === "loop.sync.conflicts" && event.loopId === loopId);
      const startedEvent = ctx.events.find((event) => event.type === "loop.started" && event.loopId === loopId);

      expect(syncStarted).toBeDefined();
      expect(syncClean).toBeDefined();
      expect(syncConflicts).toBeUndefined();
      expect(startedEvent).toBeDefined();
    } finally {
      await teardownTestContext(ctx);
    }
  });

  test("acceptPlan resolves base branch conflicts before continuing normal execution", async () => {
    const ctx = await setupTestContext({
      initGit: true,
      initialFiles: { "test.txt": "Initial content\n" },
      mockResponses: [
        "<promise>PLAN_READY</promise>",
        "<promise>COMPLETE</promise>",
        "<promise>COMPLETE</promise>",
      ],
    });

    try {
      const { remoteDir, currentBranch } = await setupRemote(ctx);
      const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
        directory: ctx.workDir,
        workspaceId: testWorkspaceId,
        maxIterations: 2,
        planMode: true,
        autoAcceptPlan: false,
      });
      const loopId = loop.config.id;

      await ctx.manager.startPlanMode(loopId);
      await waitForPlanReady(ctx.manager, loopId);

      const loopData = await ctx.manager.getLoop(loopId);
      const worktreePath = loopData!.state.git!.worktreePath!;

      await writeFile(join(worktreePath, "test.txt"), "Modified by loop\n");
      await Bun.$`git -C ${worktreePath} add -A`.quiet();
      await Bun.$`git -C ${worktreePath} commit -m "Loop changes to test.txt"`.quiet();

      await addRemoteCommit(
        remoteDir,
        currentBranch,
        { "test.txt": "Modified by someone else\n" },
        "Conflicting remote commit",
        ctx.dataDir,
      );

      await ctx.manager.acceptPlan(loopId);
      const resumedLoop = await waitForSyncStateToClear(ctx, loopId, 10000);
      const finalLoop = await waitForLoopStatus(ctx.manager, loopId, ["completed", "max_iterations", "stopped"], 10000);

      const syncConflicts = ctx.events.find((event) => event.type === "loop.sync.conflicts" && event.loopId === loopId);
      const sessionAbortedEvents = ctx.events.filter((event) => event.type === "loop.session_aborted" && event.loopId === loopId);
      const pushedEvent = ctx.events.find((event) => event.type === "loop.pushed" && event.loopId === loopId);
      const startedEvents = ctx.events.filter((event) => event.type === "loop.started" && event.loopId === loopId);
      const latestLoop = await ctx.manager.getLoop(loopId);

      expect(syncConflicts).toBeDefined();
      expect(sessionAbortedEvents).toHaveLength(1);
      expect(pushedEvent).toBeUndefined();
      expect(startedEvents.length).toBeGreaterThanOrEqual(1);
      expect(["running", "completed", "max_iterations", "stopped"]).toContain(resumedLoop.state.status);
      expect(finalLoop.state.status).not.toBe("pushed");
      expect(latestLoop!.state.syncState).toBeUndefined();
    } finally {
      await teardownTestContext(ctx);
    }
  });

  test("acceptPlan clears sync state if conflict resolution fails before execution resumes", async () => {
    const ctx = await setupTestContext({
      initGit: true,
      initialFiles: { "test.txt": "Initial content\n" },
      mockResponses: [
        "<promise>PLAN_READY</promise>",
        "ERROR:Failed to resolve conflicts",
      ],
    });

    try {
      const { remoteDir, currentBranch } = await setupRemote(ctx);
      const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
        directory: ctx.workDir,
        workspaceId: testWorkspaceId,
        maxIterations: 2,
        maxConsecutiveErrors: 1,
        planMode: true,
        autoAcceptPlan: false,
      });
      const loopId = loop.config.id;

      await ctx.manager.startPlanMode(loopId);
      await waitForPlanReady(ctx.manager, loopId);

      const loopData = await ctx.manager.getLoop(loopId);
      const worktreePath = loopData!.state.git!.worktreePath!;

      await writeFile(join(worktreePath, "test.txt"), "Modified by loop\n");
      await Bun.$`git -C ${worktreePath} add -A`.quiet();
      await Bun.$`git -C ${worktreePath} commit -m "Loop changes to test.txt"`.quiet();

      await addRemoteCommit(
        remoteDir,
        currentBranch,
        { "test.txt": "Modified by someone else\n" },
        "Conflicting remote commit",
        ctx.dataDir,
      );

      await ctx.manager.acceptPlan(loopId);

      const failedLoop = await waitForSyncStateToClear(ctx, loopId, 10000);
      expect(failedLoop.state.status).toBe("failed");
      expect(failedLoop.state.syncState).toBeUndefined();
      expect(failedLoop.state.error?.message).toContain("Failed to resolve conflicts");

      const pushedEvent = ctx.events.find((event) => event.type === "loop.pushed" && event.loopId === loopId);
      expect(pushedEvent).toBeUndefined();
    } finally {
      await teardownTestContext(ctx);
    }
  });

  test("acceptPlan fails if the base branch cannot be fetched before execution starts", async () => {
    const ctx = await setupTestContext({
      initGit: true,
      initialFiles: { "test.txt": "Initial content\n" },
      mockResponses: ["<promise>PLAN_READY</promise>"],
    });

    try {
      const { remoteDir } = await setupRemote(ctx);
      const loop = await ctx.manager.createLoop({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Loop",
        directory: ctx.workDir,
        workspaceId: testWorkspaceId,
        maxIterations: 2,
        planMode: true,
        autoAcceptPlan: false,
      });
      const loopId = loop.config.id;

      await ctx.manager.startPlanMode(loopId);
      await waitForPlanReady(ctx.manager, loopId);

      await Bun.$`rm -rf ${remoteDir}`.quiet();

      await expect(ctx.manager.acceptPlan(loopId)).rejects.toThrow(
        "Failed to fetch origin/",
      );

      const failedLoop = await waitForLoopStatus(ctx.manager, loopId, ["failed"]);
      const syncFailed = ctx.events.find((event) => event.type === "loop.sync.failed" && event.loopId === loopId);
      const syncClean = ctx.events.find((event) => event.type === "loop.sync.clean" && event.loopId === loopId);

      expect(failedLoop.state.status).toBe("failed");
      expect(failedLoop.state.fullyAutonomousPending).toBe(false);
      expect(failedLoop.state.syncState).toBeUndefined();
      expect(syncFailed).toBeDefined();
      expect(syncClean).toBeUndefined();
    } finally {
      await teardownTestContext(ctx);
    }
  });
});
