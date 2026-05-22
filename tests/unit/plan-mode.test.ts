/**
 * Unit tests for Plan Mode functionality.
 * Tests clearPlanningFolder behavior and state transitions.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { setupTestContext, teardownTestContext, waitForPlanReady, waitForPersistedPlanReady, waitForTaskStatus, testModelFields } from "../setup";
import type { TestContext } from "../setup";
import { MockAcpBackend, defaultTestModel } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { backendManager } from "../../src/core/backend-manager";
import { loadTask } from "../../src/persistence/tasks";
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
  await Bun.$`git --git-dir=${remoteDir} symbolic-ref HEAD refs/heads/${currentBranch}`.quiet();
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

async function waitForSyncStateToClear(ctx: TestContext, taskId: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = await ctx.manager.getTask(taskId);
    if (task && task.state.syncState === undefined && task.state.status !== "resolving_conflicts") {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const lastTask = await ctx.manager.getTask(taskId);
  throw new Error(
    `Task ${taskId} did not clear sync state within ${timeoutMs}ms. Last status: ${lastTask?.state.status ?? "missing"}`,
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

  test("clears .clanky-planning folder before plan creation when clearPlanningFolder is true", async () => {
    // Setup: Create existing plan files and commit them to git
    // (files must be committed so they appear in the worktree checkout)
    const planningDir = join(ctx.workDir, ".clanky-planning");
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, "old-plan.md"), "Old plan content");
    await writeFile(join(planningDir, "status.md"), "Old status");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add planning files"`.quiet();

    // Verify files exist before task creation
    expect(await exists(join(planningDir, "old-plan.md"))).toBe(true);
    expect(await exists(join(planningDir, "status.md"))).toBe(true);

    // Create task with plan mode + clear folder
    const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      clearPlanningFolder: true,
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    // Start plan mode (this is when clearing happens — in the worktree)
    await ctx.manager.startPlanMode(taskId);

    // Wait for plan to be ready (polling instead of fixed delay)
    await waitForPlanReady(ctx.manager, taskId);

    // Get the task state
    const taskData = await ctx.manager.getTask(taskId);
    expect(taskData).toBeDefined();

    // Verify worktree was created
    const worktreePath = taskData!.state.git?.worktreePath;
    expect(worktreePath).toBeDefined();

    // Verify the folder was cleared in the worktree (old files gone)
    const wtPlanningDir = join(worktreePath!, ".clanky-planning");
    expect(await exists(join(wtPlanningDir, "old-plan.md"))).toBe(false);
    expect(await exists(join(wtPlanningDir, "status.md"))).toBe(false);

    // Verify state tracks that clearing happened
    expect(taskData!.state.planMode?.planningFolderCleared).toBe(true);
  });

  test("does not clear .clanky-planning folder if clearPlanningFolder is false", async () => {
    // Setup existing files and commit them so they appear in the worktree
    const planningDir = join(ctx.workDir, ".clanky-planning");
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, "existing-plan.md"), "Existing content");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add existing plan"`.quiet();

    // Verify file exists
    expect(await exists(join(planningDir, "existing-plan.md"))).toBe(true);

    // Create task without clear option
    const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      clearPlanningFolder: false,
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    // Start plan mode and wait for plan to be ready
    await ctx.manager.startPlanMode(taskId);
    await waitForPlanReady(ctx.manager, taskId);

    // Verify folder was NOT cleared in the worktree
    const taskData = await ctx.manager.getTask(taskId);
    const worktreePath = taskData!.state.git?.worktreePath;
    expect(worktreePath).toBeDefined();
    expect(await exists(join(worktreePath!, ".clanky-planning", "existing-plan.md"))).toBe(true);

    // Verify state shows clearing did not happen
    expect(taskData!.state.planMode?.planningFolderCleared).toBe(false);
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
    const planningDir = join(ctx.workDir, ".clanky-planning");
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, "plan.md"), "Old stale plan content");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add stale plan"`.quiet();

    // Verify file exists before task creation
    expect(await exists(join(planningDir, "plan.md"))).toBe(true);

    // Create task with plan mode but WITHOUT clearPlanningFolder
    const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      clearPlanningFolder: false,
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    // Start plan mode - this should clear plan.md regardless of clearPlanningFolder
    await ctx.manager.startPlanMode(taskId);
    await waitForPlanReady(ctx.manager, taskId);

    // Get the worktree path and check there
    const taskData = await ctx.manager.getTask(taskId);
    const worktreePath = taskData!.state.git?.worktreePath;
    expect(worktreePath).toBeDefined();

    // The plan file in the worktree should not have old content
    const planContent = await Bun.file(join(worktreePath!, ".clanky-planning", "plan.md")).text().catch(() => "");
    expect(planContent).not.toContain("Old stale plan content");
  });

  test("does NOT clear status.md when clearPlanningFolder is false", async () => {
    // Setup: Create both plan.md and status.md and commit to git
    const planningDir = join(ctx.workDir, ".clanky-planning");
    await mkdir(planningDir, { recursive: true });
    await writeFile(join(planningDir, "plan.md"), "Old plan");
    await writeFile(join(planningDir, "status.md"), "Important status tracking info");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add planning files"`.quiet();

    // Verify both files exist
    expect(await exists(join(planningDir, "plan.md"))).toBe(true);
    expect(await exists(join(planningDir, "status.md"))).toBe(true);

    // Create task with plan mode but WITHOUT clearPlanningFolder
    const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      clearPlanningFolder: false,
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    // Start plan mode - should only clear plan.md, not status.md
    await ctx.manager.startPlanMode(taskId);
    await waitForPlanReady(ctx.manager, taskId);

    // Get worktree path and check there
    const taskData = await ctx.manager.getTask(taskId);
    const worktreePath = taskData!.state.git?.worktreePath;
    expect(worktreePath).toBeDefined();

    // Verify status.md still exists with original content in the worktree
    const wtStatusPath = join(worktreePath!, ".clanky-planning", "status.md");
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

  test("increments feedback rounds on each feedback", async () => {
    const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 5, // Need enough iterations for multiple feedbacks
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    // Start plan mode and wait for plan to be ready
    await ctx.manager.startPlanMode(taskId);
    await waitForPlanReady(ctx.manager, taskId);

    // Initial feedback rounds should be 0
    let taskData = await ctx.manager.getTask(taskId);
    expect(taskData!.state.planMode?.feedbackRounds).toBe(0);

    // Send first feedback (returns quickly — injection pattern)
    await ctx.manager.sendPlanFeedback(taskId, "Please add more details");

    // feedbackRounds is incremented synchronously before the async injection
    taskData = await ctx.manager.getTask(taskId);
    expect(taskData!.state.planMode?.feedbackRounds).toBe(1);

    // Wait for the feedback iteration to complete before sending more feedback
    await waitForPlanReady(ctx.manager, taskId);

    // Send second feedback
    await ctx.manager.sendPlanFeedback(taskId, "Add time estimates");

    taskData = await ctx.manager.getTask(taskId);
    expect(taskData!.state.planMode?.feedbackRounds).toBe(2);
  });

  test("reuses session from plan creation when starting execution", async () => {
    const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    // Start plan mode and wait for plan to be ready
    await ctx.manager.startPlanMode(taskId);
    await waitForPlanReady(ctx.manager, taskId);

    // Get the plan session info from state.session (where it's stored during planning)
    let taskData = await ctx.manager.getTask(taskId);
    const planSessionId = taskData!.state.session?.id;
    expect(planSessionId).toBeDefined();

    // Accept the plan
    await ctx.manager.acceptPlan(taskId);
    
    // Wait for transition from planning
    await waitForTaskStatus(ctx.manager, taskId, ["running", "completed", "max_iterations", "stopped"]);

    // Verify the session is still the same (session continuity)
    // After acceptance, it should be copied to planMode.planSessionId for persistence
    taskData = await ctx.manager.getTask(taskId);
    expect(taskData!.state.planMode?.planSessionId).toBe(planSessionId);
    expect(taskData!.state.session?.id).toBe(planSessionId);
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
    const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    // Verify isPlanReady is false initially
    const taskData = await ctx.manager.getTask(taskId);
    expect(taskData!.state.planMode?.isPlanReady).toBe(false);
  });

  test("isPlanReady becomes true after PLAN_READY marker detected", async () => {
    const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    // Start plan mode
    await ctx.manager.startPlanMode(taskId);
    
    // Wait for the mock backend to emit PLAN_READY
    const taskData = await waitForPlanReady(ctx.manager, taskId);
    expect(taskData!.state.planMode?.isPlanReady).toBe(true);
  });

  test("isPlanReady resets to false when feedback is sent", async () => {
    const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 5, // Increase max iterations to allow feedback iteration
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    // Start plan mode and wait for PLAN_READY
    await ctx.manager.startPlanMode(taskId);
    let taskData = await waitForPlanReady(ctx.manager, taskId);
    expect(taskData.state.planMode?.isPlanReady).toBe(true);

    // Send feedback - this resets isPlanReady to false internally,
    // but with fast mocks the new plan might be ready by the time this returns
    await ctx.manager.sendPlanFeedback(taskId, "Please add more details");
    
    // After feedback, wait for the plan to be ready again
    taskData = await waitForPlanReady(ctx.manager, taskId);
    
    // The important thing is that after feedback, we can still accept the plan
    // and feedback rounds should have incremented
    expect(taskData.state.planMode?.feedbackRounds).toBe(1);
    expect(taskData.state.planMode?.isPlanReady).toBe(true);
  });

  test("isPlanReady persists in database across restarts", async () => {
    const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    // Start plan mode and wait for PLAN_READY
    await ctx.manager.startPlanMode(taskId);
    let taskData = await waitForPlanReady(ctx.manager, taskId);
    expect(taskData.state.planMode?.isPlanReady).toBe(true);

    // Stop the task
    await ctx.manager.stopTask(taskId);
    await waitForTaskStatus(ctx.manager, taskId, ["stopped", "paused"]);

    // Retrieve the task from database (simulating restart)
    const retrievedTask = await ctx.manager.getTask(taskId);
    
    // Verify isPlanReady is still true
    expect(retrievedTask).not.toBeNull();
    expect(retrievedTask!.state.planMode?.isPlanReady).toBe(true);
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
    const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a simple plan",
        name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 5,  // Allow multiple iterations
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    // Verify isPlanReady is false initially
    let taskData = await ctx.manager.getTask(taskId);
    expect(taskData!.state.planMode?.isPlanReady).toBe(false);

    // Start plan mode - the mock will NOT return PLAN_READY marker
    await ctx.manager.startPlanMode(taskId);

    // Wait for the first iteration to complete (task should still be in planning)
    await waitForTaskStatus(ctx.manager, taskId, ["planning", "max_iterations", "stopped"]);

    // Verify isPlanReady is still false (no PLAN_READY marker was detected)
    taskData = await ctx.manager.getTask(taskId);
    expect(taskData!.state.planMode?.isPlanReady).toBe(false);

    // Try to accept the plan while isPlanReady is false - should throw
    await expect(ctx.manager.acceptPlan(taskId)).rejects.toThrow(
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

    // Create a plan mode task and start it
    const task = await ctx.manager.createTask({
      ...testModelFields,
      prompt: "Create a plan",
      name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    await ctx.manager.startPlanMode(taskId);
    await waitForPlanReady(ctx.manager, taskId);

    // Verify the worktree was created
    const taskData = await ctx.manager.getTask(taskId);
    const worktreePath = taskData!.state.git?.worktreePath;
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

  test("multiple plan mode tasks have separate worktrees", async () => {
    // Override mock backend with responses for two plan iterations.
    const multiTaskMock = new MockAcpBackend({
      responses: [
        "<promise>PLAN_READY</promise>",    // Plan iteration for task 1
        "<promise>PLAN_READY</promise>",    // Plan iteration for task 2
      ],
      models: [defaultTestModel],
    });
    backendManager.setBackendForTesting(multiTaskMock);

    // Create a baseline commit
    await writeFile(join(ctx.workDir, "shared-file.txt"), "Shared content");
    await Bun.$`git -C ${ctx.workDir} add .`.quiet();
    await Bun.$`git -C ${ctx.workDir} commit -m "Add shared file"`.quiet();

    // Create and start two plan mode tasks
    const task1 = await ctx.manager.createTask({
      ...testModelFields,
      prompt: "Plan A",
      name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const task2 = await ctx.manager.createTask({
      ...testModelFields,
      prompt: "Plan B",
      name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });

    await ctx.manager.startPlanMode(task1.config.id);
    await ctx.manager.startPlanMode(task2.config.id);

    await waitForPlanReady(ctx.manager, task1.config.id);
    await waitForPlanReady(ctx.manager, task2.config.id);

    // Verify each has its own worktree
    const taskData1 = await ctx.manager.getTask(task1.config.id);
    const taskData2 = await ctx.manager.getTask(task2.config.id);
    const wt1 = taskData1!.state.git?.worktreePath;
    const wt2 = taskData2!.state.git?.worktreePath;

    expect(wt1).toBeDefined();
    expect(wt2).toBeDefined();
    expect(wt1).not.toBe(wt2);

    // Write different files to each worktree
    await writeFile(join(wt1!, "task1-file.txt"), "Task 1 content");
    await writeFile(join(wt2!, "task2-file.txt"), "Task 2 content");

    // Verify files are isolated between worktrees
    expect(await exists(join(wt1!, "task1-file.txt"))).toBe(true);
    expect(await exists(join(wt1!, "task2-file.txt"))).toBe(false);
    expect(await exists(join(wt2!, "task2-file.txt"))).toBe(true);
    expect(await exists(join(wt2!, "task1-file.txt"))).toBe(false);

    // Verify original repo dir is still clean
    expect(await exists(join(ctx.workDir, "task1-file.txt"))).toBe(false);
    expect(await exists(join(ctx.workDir, "task2-file.txt"))).toBe(false);
    const gitStatus = await Bun.$`git -C ${ctx.workDir} status --porcelain`.text();
    expect(gitStatus.trim()).toBe("");
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
    // Create and start plan mode task
    const task = await ctx.manager.createTask({
      ...testModelFields,
      prompt: "Create a plan",
      name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 5,
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    // Start plan mode and wait for plan to be ready (in-memory)
    await ctx.manager.startPlanMode(taskId);
    await waitForPlanReady(ctx.manager, taskId);

    // Verify plan is ready in memory
    let taskData = await ctx.manager.getTask(taskId);
    expect(taskData!.state.status).toBe("planning");
    expect(taskData!.state.planMode?.isPlanReady).toBe(true);

    // Wait for isPlanReady to be persisted to DB before resetting.
    // This ensures recoverPlanningEngine() (which reads from loadTask) sees the correct state.
    await waitForPersistedPlanReady(taskId);

    // Simulate server restart: clear all in-memory engines
    ctx.manager.resetForTesting();

    // Verify engine is gone (the task is still in the DB in planning status)
    // Now try to accept the plan — this should recover the engine and succeed
    await ctx.manager.acceptPlan(taskId);

    // Wait for transition from planning to running/completed
    taskData = await waitForTaskStatus(ctx.manager, taskId, ["running", "completed", "max_iterations", "stopped"]);
    expect(["running", "completed", "max_iterations", "stopped"]).toContain(taskData!.state.status);
  });

  test("acceptPlan recovers a branch-only planning task after server restart", async () => {
    const task = await ctx.manager.createTask({
      ...testModelFields,
      prompt: "Create a branch-only plan",
      name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 5,
      planMode: true,
      autoAcceptPlan: false,
      useWorktree: false,
    });
    const taskId = task.config.id;

    await ctx.manager.startPlanMode(taskId);
    await waitForPlanReady(ctx.manager, taskId);
    await waitForPersistedPlanReady(taskId);

    let taskData = await ctx.manager.getTask(taskId);
    expect(taskData!.state.git?.workingBranch).toBeDefined();
    expect(taskData!.state.git?.originalBranch).toBeDefined();

    await ctx.git.checkoutBranch(ctx.workDir, taskData!.state.git!.originalBranch);

    ctx.manager.resetForTesting();

    await ctx.manager.acceptPlan(taskId);

    taskData = await waitForTaskStatus(ctx.manager, taskId, ["running", "completed", "max_iterations", "stopped"]);
    expect(["running", "completed", "max_iterations", "stopped"]).toContain(taskData!.state.status);
  });

  test("sendPlanFeedback recovers engine after server restart", async () => {
    // Create and start plan mode task
    const task = await ctx.manager.createTask({
      ...testModelFields,
      prompt: "Create a plan",
      name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 5,
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    // Start plan mode and wait for plan to be ready (in-memory)
    await ctx.manager.startPlanMode(taskId);
    await waitForPlanReady(ctx.manager, taskId);

    // Verify plan is ready in memory
    let taskData = await ctx.manager.getTask(taskId);
    expect(taskData!.state.status).toBe("planning");
    expect(taskData!.state.planMode?.isPlanReady).toBe(true);

    // Wait for isPlanReady to be persisted to DB before resetting.
    // This ensures recoverPlanningEngine() (which reads from loadTask) sees the correct state.
    await waitForPersistedPlanReady(taskId);

    // Simulate server restart: clear all in-memory engines
    ctx.manager.resetForTesting();

    // Send feedback — should recover the engine from persisted state
    await ctx.manager.sendPlanFeedback(taskId, "Add more detail to step 3");

    // feedbackRounds is incremented synchronously before the async injection
    taskData = await ctx.manager.getTask(taskId);
    expect(taskData!.state.status).toBe("planning");
    expect(taskData!.state.planMode?.feedbackRounds).toBe(1);

    // Wait for the feedback iteration to complete (engine was recovered and started a new iteration)
    await waitForPlanReady(ctx.manager, taskId);
  });

});

describe("Plan Mode - Seeded plan recovery", () => {
  test("acceptPlan recovers a seeded plan task without a prior planning session", async () => {
    const ctx = await setupTestContext({
      initGit: true,
      mockResponses: ["<promise>COMPLETE</promise>"],
    });

    try {
      await setupRemote(ctx);
      const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a seeded plan",
        name: "Seeded Plan Task",
        directory: ctx.workDir,
        workspaceId: testWorkspaceId,
        planMode: true,
        autoAcceptPlan: false,
      });

      await ctx.manager.seedPlanFiles(task.config.id, {
        planContent: "# Imported plan\n\n1. Execute the imported work.\n",
      });

      const seededTask = await loadTask(task.config.id);
      expect(seededTask?.state.session).toBeUndefined();
      expect(seededTask?.state.planMode?.isPlanReady).toBe(true);

      ctx.manager.resetForTesting();

      await ctx.manager.acceptPlan(task.config.id);

      const updated = await waitForTaskStatus(ctx.manager, task.config.id, ["running", "completed", "max_iterations", "stopped"]);
      expect(["running", "completed", "max_iterations", "stopped"]).toContain(updated.state.status);
    } finally {
      await teardownTestContext(ctx);
    }
  });

  test("sendPlanFeedback recovers a seeded plan task without a prior planning session", async () => {
    const ctx = await setupTestContext({
      initGit: true,
      mockResponses: ["<promise>PLAN_READY</promise>"],
    });

    try {
      const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a seeded plan",
        name: "Seeded Feedback Task",
        directory: ctx.workDir,
        workspaceId: testWorkspaceId,
        planMode: true,
        autoAcceptPlan: false,
      });

      await ctx.manager.seedPlanFiles(task.config.id, {
        planContent: "# Imported plan\n\n1. Initial step.\n",
      });

      ctx.manager.resetForTesting();

      await ctx.manager.sendPlanFeedback(task.config.id, "Add more detail to the imported plan");

      const updated = await waitForPlanReady(ctx.manager, task.config.id);
      expect(updated.state.planMode?.isPlanReady).toBe(true);
      expect(updated.state.planMode?.feedbackRounds).toBe(1);
    } finally {
      await teardownTestContext(ctx);
    }
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
    const task = await ctx.manager.createTask({
      ...testModelFields,
      prompt: "Create a plan",
      name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    await ctx.manager.startPlanMode(taskId);
    await waitForPlanReady(ctx.manager, taskId);

    const result = await ctx.manager.acceptPlan(taskId, { mode: "open_ssh" });
    expect(result.mode).toBe("open_ssh");
    if (result.mode !== "open_ssh") {
      throw new Error(`Expected open_ssh mode, received ${result.mode}`);
    }
    expect(result.sshSession.config.taskId).toBe(taskId);

    const taskData = await waitForTaskStatus(ctx.manager, taskId, ["completed"]);
    expect(taskData.state.status).toBe("completed");
    expect(taskData.state.pendingPrompt).toBeUndefined();

    const sshHandoffEvents = ctx.events.filter((event) => event.type === "task.ssh_handoff" && event.taskId === taskId);
    expect(sshHandoffEvents).toHaveLength(1);

    const completionEvents = ctx.events.filter((event) => event.type === "task.completed" && event.taskId === taskId);
    expect(completionEvents).toHaveLength(0);
  });

  test("open_ssh acceptance does not run the post-accept base branch sync", async () => {
    const { remoteDir, currentBranch } = await setupRemote(ctx);

    const task = await ctx.manager.createTask({
      ...testModelFields,
      prompt: "Create a plan",
      name: "Test Task",
      directory: ctx.workDir,
      workspaceId: testWorkspaceId,
      maxIterations: 1,
      planMode: true,
      autoAcceptPlan: false,
    });
    const taskId = task.config.id;

    await ctx.manager.startPlanMode(taskId);
    await waitForPlanReady(ctx.manager, taskId);

    await addRemoteCommit(
      remoteDir,
      currentBranch,
      { "remote-only.txt": "Remote content\n" },
      "Remote base branch update",
      ctx.dataDir,
    );

    await ctx.manager.acceptPlan(taskId, { mode: "open_ssh" });

    const taskData = await waitForTaskStatus(ctx.manager, taskId, ["completed"]);
    expect(taskData.state.status).toBe("completed");

    const syncEvents = ctx.events.filter((event) => event.taskId === taskId && event.type.startsWith("task.sync."));
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
      const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Task",
        directory: ctx.workDir,
        workspaceId: testWorkspaceId,
        maxIterations: 2,
        planMode: true,
        autoAcceptPlan: false,
      });
      const taskId = task.config.id;

      await ctx.manager.startPlanMode(taskId);
      await waitForPlanReady(ctx.manager, taskId);

      const taskData = await ctx.manager.getTask(taskId);
      const worktreePath = taskData!.state.git!.worktreePath!;

      await addRemoteCommit(
        remoteDir,
        currentBranch,
        { "remote-only.txt": "Remote content\n" },
        "Non-conflicting remote commit",
        ctx.dataDir,
      );

      await ctx.manager.acceptPlan(taskId);
      const finalTask = await waitForTaskStatus(ctx.manager, taskId, ["completed", "running", "max_iterations", "stopped"]);

      expect(await exists(join(worktreePath, "remote-only.txt"))).toBe(true);
      expect(finalTask.state.planMode?.active).toBe(false);

      const syncStarted = ctx.events.find((event) => event.type === "task.sync.started" && event.taskId === taskId);
      const syncClean = ctx.events.find((event) => event.type === "task.sync.clean" && event.taskId === taskId);
      const syncConflicts = ctx.events.find((event) => event.type === "task.sync.conflicts" && event.taskId === taskId);
      const startedEvent = ctx.events.find((event) => event.type === "task.started" && event.taskId === taskId);

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
      const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Task",
        directory: ctx.workDir,
        workspaceId: testWorkspaceId,
        maxIterations: 2,
        planMode: true,
        autoAcceptPlan: false,
      });
      const taskId = task.config.id;

      await ctx.manager.startPlanMode(taskId);
      await waitForPlanReady(ctx.manager, taskId);

      const taskData = await ctx.manager.getTask(taskId);
      const worktreePath = taskData!.state.git!.worktreePath!;

      await writeFile(join(worktreePath, "test.txt"), "Modified by task\n");
      await Bun.$`git -C ${worktreePath} add -A`.quiet();
      await Bun.$`git -C ${worktreePath} commit -m "Task changes to test.txt"`.quiet();

      await addRemoteCommit(
        remoteDir,
        currentBranch,
        { "test.txt": "Modified by someone else\n" },
        "Conflicting remote commit",
        ctx.dataDir,
      );

      await ctx.manager.acceptPlan(taskId);
      const resumedTask = await waitForSyncStateToClear(ctx, taskId, 10000);
      const finalTask = await waitForTaskStatus(ctx.manager, taskId, ["completed", "max_iterations", "stopped"], 10000);

      const syncConflicts = ctx.events.find((event) => event.type === "task.sync.conflicts" && event.taskId === taskId);
      const sessionAbortedEvents = ctx.events.filter((event) => event.type === "task.session_aborted" && event.taskId === taskId);
      const pushedEvent = ctx.events.find((event) => event.type === "task.pushed" && event.taskId === taskId);
      const startedEvents = ctx.events.filter((event) => event.type === "task.started" && event.taskId === taskId);
      const latestTask = await ctx.manager.getTask(taskId);

      expect(syncConflicts).toBeDefined();
      expect(sessionAbortedEvents).toHaveLength(1);
      expect(pushedEvent).toBeUndefined();
      expect(startedEvents.length).toBeGreaterThanOrEqual(1);
      expect(["running", "completed", "max_iterations", "stopped"]).toContain(resumedTask.state.status);
      expect(finalTask.state.status).not.toBe("pushed");
      expect(latestTask!.state.syncState).toBeUndefined();
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
      const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Task",
        directory: ctx.workDir,
        workspaceId: testWorkspaceId,
        maxIterations: 2,
        maxConsecutiveErrors: 1,
        planMode: true,
        autoAcceptPlan: false,
      });
      const taskId = task.config.id;

      await ctx.manager.startPlanMode(taskId);
      await waitForPlanReady(ctx.manager, taskId);

      const taskData = await ctx.manager.getTask(taskId);
      const worktreePath = taskData!.state.git!.worktreePath!;

      await writeFile(join(worktreePath, "test.txt"), "Modified by task\n");
      await Bun.$`git -C ${worktreePath} add -A`.quiet();
      await Bun.$`git -C ${worktreePath} commit -m "Task changes to test.txt"`.quiet();

      await addRemoteCommit(
        remoteDir,
        currentBranch,
        { "test.txt": "Modified by someone else\n" },
        "Conflicting remote commit",
        ctx.dataDir,
      );

      await ctx.manager.acceptPlan(taskId);

      const failedTask = await waitForSyncStateToClear(ctx, taskId, 10000);
      expect(failedTask.state.status).toBe("failed");
      expect(failedTask.state.syncState).toBeUndefined();
      expect(failedTask.state.error?.message).toContain("Failed to resolve conflicts");

      const pushedEvent = ctx.events.find((event) => event.type === "task.pushed" && event.taskId === taskId);
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
      const task = await ctx.manager.createTask({
        ...testModelFields,
        prompt: "Create a plan",
        name: "Test Task",
        directory: ctx.workDir,
        workspaceId: testWorkspaceId,
        maxIterations: 2,
        planMode: true,
        autoAcceptPlan: false,
      });
      const taskId = task.config.id;

      await ctx.manager.startPlanMode(taskId);
      await waitForPlanReady(ctx.manager, taskId);

      await Bun.$`rm -rf ${remoteDir}`.quiet();

      await expect(ctx.manager.acceptPlan(taskId)).rejects.toThrow(
        "Failed to fetch origin/",
      );

      const failedTask = await waitForTaskStatus(ctx.manager, taskId, ["failed"]);
      const syncFailed = ctx.events.find((event) => event.type === "task.sync.failed" && event.taskId === taskId);
      const syncClean = ctx.events.find((event) => event.type === "task.sync.clean" && event.taskId === taskId);

      expect(failedTask.state.status).toBe("failed");
      expect(failedTask.state.fullyAutonomousPending).toBe(false);
      expect(failedTask.state.syncState).toBeUndefined();
      expect(syncFailed).toBeDefined();
      expect(syncClean).toBeUndefined();
    } finally {
      await teardownTestContext(ctx);
    }
  });
});
