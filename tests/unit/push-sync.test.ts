/**
 * Unit tests for the push-with-sync flow in TaskManager.
 * Tests the base branch sync behavior that happens before pushing:
 * - Already up to date: no merge needed
 * - Clean merge: base branch merged cleanly, then push
 * - Conflicts: conflict resolution engine started, auto-push on completion
 */

import { test, expect, describe } from "bun:test";
import { writeFile } from "fs/promises";
import { join } from "path";
import {
  setupTestContext,
  teardownTestContext,
  waitForEvent,
  waitForTaskStatus,
  testModelFields,
} from "../setup";
import type { TestContext } from "../setup";

const testWorkspaceId = "test-workspace-id";

/**
 * Helper: set up a bare remote, push the current branch, and return branch name + remote dir.
 */
async function setupRemote(ctx: TestContext): Promise<{ remoteDir: string; currentBranch: string }> {
  const remoteDir = join(ctx.dataDir, "remote-" + Date.now() + ".git");
  await Bun.$`git init --bare ${remoteDir}`.quiet();
  await Bun.$`git -C ${ctx.workDir} remote add origin ${remoteDir}`.quiet();
  const currentBranch = (await Bun.$`git -C ${ctx.workDir} branch --show-current`.text()).trim();
  await Bun.$`git -C ${ctx.workDir} push -u origin ${currentBranch}`.quiet();
  return { remoteDir, currentBranch };
}

/**
 * Helper: create and complete a task, returning the task object.
 */
async function createAndCompleteTask(ctx: TestContext) {
  const task = await ctx.manager.createTask({
    ...testModelFields,
    directory: ctx.workDir,
    prompt: "Make changes",
    name: "Test Task",
    planMode: false,
    workspaceId: testWorkspaceId,
  });

  await ctx.manager.startTask(task.config.id);
  await waitForEvent(ctx.events, "task.completed");

  return task;
}

/**
 * Helper: add a commit to the remote via a second clone.
 * Used to simulate someone else pushing to the base branch.
 */
async function addRemoteCommit(
  remoteDir: string,
  files: Record<string, string>,
  message: string,
  dataDir: string,
): Promise<void> {
  const otherClone = join(dataDir, "other-clone-" + Date.now());
  try {
    await Bun.$`git clone ${remoteDir} ${otherClone}`.quiet();
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

/**
 * Helper: add a commit to a specific branch on the remote via a second clone.
 * Used to simulate someone else pushing to a working branch.
 */
async function addRemoteCommitToBranch(
  remoteDir: string,
  branchName: string,
  files: Record<string, string>,
  message: string,
  dataDir: string,
): Promise<void> {
  const otherClone = join(dataDir, "other-clone-" + Date.now());
  try {
    await Bun.$`git clone ${remoteDir} ${otherClone}`.quiet();
    await Bun.$`git -C ${otherClone} config user.email "other@test.com"`.quiet();
    await Bun.$`git -C ${otherClone} config user.name "Other User"`.quiet();
    await Bun.$`git -C ${otherClone} checkout ${branchName}`.quiet();
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

describe("Push with Base Branch Sync", () => {
  describe("already up to date", () => {
    test("pushes immediately when base branch has no new commits", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: { "test.txt": "Initial content" },
      });

      try {
        const { currentBranch: _currentBranch } = await setupRemote(ctx);
        const task = await createAndCompleteTask(ctx);

        // Push the task — base branch hasn't changed, should be "already_up_to_date"
        const pushResult = await ctx.manager.pushTask(task.config.id);
        expect(pushResult.success).toBe(true);
        expect(pushResult.syncStatus).toBe("already_up_to_date");
        // remoteBranch should be set when push actually happened
        expect(pushResult.remoteBranch).toBeDefined();

        // Verify task is in pushed state
        const pushedTask = await ctx.manager.getTask(task.config.id);
        expect(pushedTask).not.toBeNull();
        expect(pushedTask!.state.status).toBe("pushed");
        expect(pushedTask!.state.syncState).toBeUndefined();
        expect(pushedTask!.state.reviewMode).toBeDefined();
        expect(pushedTask!.state.reviewMode!.completionAction).toBe("push");

        // Verify sync events were emitted
        const syncStarted = ctx.events.find((e) => e.type === "task.sync.started");
        expect(syncStarted).toBeDefined();
        const syncClean = ctx.events.find((e) => e.type === "task.sync.clean");
        expect(syncClean).toBeDefined();
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("clean merge", () => {
    test("merges and pushes when base branch has non-conflicting changes", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: { "test.txt": "Initial content" },
      });

      try {
        const { remoteDir } = await setupRemote(ctx);
        const task = await createAndCompleteTask(ctx);

        // Add a non-conflicting commit to the base branch on the remote
        // The task's mock backend only responds with COMPLETE and doesn't create files,
        // so a new file on the remote won't conflict
        await addRemoteCommit(
          remoteDir,
          { "remote-only.txt": "Remote content\n" },
          "Non-conflicting remote commit",
          ctx.dataDir,
        );

        // Push the task — should merge cleanly, then push
        const pushResult = await ctx.manager.pushTask(task.config.id);
        expect(pushResult.success).toBe(true);
        expect(pushResult.syncStatus).toBe("clean");
        // remoteBranch should be set when push actually happened
        expect(pushResult.remoteBranch).toBeDefined();

        // Verify task is in pushed state
        const pushedTask = await ctx.manager.getTask(task.config.id);
        expect(pushedTask).not.toBeNull();
        expect(pushedTask!.state.status).toBe("pushed");
        expect(pushedTask!.state.syncState).toBeUndefined();

        // Verify sync events
        const syncStarted = ctx.events.find((e) => e.type === "task.sync.started");
        expect(syncStarted).toBeDefined();
        const syncClean = ctx.events.find((e) => e.type === "task.sync.clean");
        expect(syncClean).toBeDefined();
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("merge commit uses last local commit message instead of standard merge format", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: { "test.txt": "Initial content" },
      });

      try {
        const { remoteDir } = await setupRemote(ctx);
        const task = await createAndCompleteTask(ctx);

        // Get the worktree path for the task
        const completedTask = await ctx.manager.getTask(task.config.id);
        const worktreePath = completedTask!.state.git!.worktreePath!;

        // Make a commit in the worktree with a meaningful message
        await writeFile(join(worktreePath, "feature.txt"), "New feature code\n");
        await Bun.$`git -C ${worktreePath} add -A`.quiet();
        await Bun.$`git -C ${worktreePath} commit -m "feat(auth): add JWT token refresh"`.quiet();

        // Add a non-conflicting commit to the base branch
        await addRemoteCommit(
          remoteDir,
          { "remote-only.txt": "Remote content\n" },
          "Non-conflicting remote commit",
          ctx.dataDir,
        );

        // Push — the merge commit message should use the last local commit message
        const pushResult = await ctx.manager.pushTask(task.config.id);
        expect(pushResult.success).toBe(true);
        expect(pushResult.syncStatus).toBe("clean");

        // Verify the merge commit message is the last local commit message, not "Merge origin/..."
        const mergeCommitMsg = (
          await Bun.$`git -C ${worktreePath} log -1 --format=%s`.text()
        ).trim();
        expect(mergeCommitMsg).toBe("feat(auth): add JWT token refresh");
        expect(mergeCommitMsg).not.toContain("Merge origin/");
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("conflict resolution", () => {
    test("starts conflict resolution engine when merge conflicts exist", async () => {
        // Mock responses consumed in order:
        // Index 0: subscribeToEvents (initial task iteration) → COMPLETE
        // Index 1: subscribeToEvents (conflict resolution iteration) → COMPLETE
        const ctx = await setupTestContext({
          initGit: true,
          initialFiles: { "test.txt": "Initial content" },
          mockResponses: [
            "<promise>COMPLETE</promise>",
            "<promise>COMPLETE</promise>",
          ],
        });

      try {
        const { remoteDir } = await setupRemote(ctx);

        // Create task
        const task = await ctx.manager.createTask({
          ...testModelFields,
          directory: ctx.workDir,
          prompt: "Modify test.txt",
          name: "Test Task",
          planMode: false,
          workspaceId: testWorkspaceId,
        });

        await ctx.manager.startTask(task.config.id);
        await waitForEvent(ctx.events, "task.completed");

        // Get the worktree path for the task
        const completedTask = await ctx.manager.getTask(task.config.id);
        const worktreePath = completedTask!.state.git!.worktreePath!;

        // Modify test.txt in the worktree (simulating what the task engine would do)
        await writeFile(join(worktreePath, "test.txt"), "Modified by task\n");
        await Bun.$`git -C ${worktreePath} add -A`.quiet();
        await Bun.$`git -C ${worktreePath} commit -m "Task changes to test.txt"`.quiet();

        // Now add a conflicting commit to the base branch on the remote
        await addRemoteCommit(
          remoteDir,
          { "test.txt": "Modified by someone else\n" },
          "Conflicting remote commit to test.txt",
          ctx.dataDir,
        );

        // Push the task — should detect conflicts and start resolution engine
        const pushResult = await ctx.manager.pushTask(task.config.id);
        expect(pushResult.success).toBe(true);
        expect(pushResult.syncStatus).toBe("conflicts_being_resolved");
        // remoteBranch should NOT be set when push is deferred
        expect(pushResult.remoteBranch).toBeUndefined();

        // Verify sync events
        const syncConflicts = ctx.events.find((e) => e.type === "task.sync.conflicts");
        expect(syncConflicts).toBeDefined();

        // Verify syncState was set with mergeCommitMessage
        const conflictTask = await ctx.manager.getTask(task.config.id);
        expect(conflictTask).not.toBeNull();
        expect(conflictTask!.state.syncState).toBeDefined();
        expect(conflictTask!.state.syncState!.mergeCommitMessage).toBe("Task changes to test.txt");

        // The conflict resolution engine should have been started. 
        // With the mock backend, it will complete quickly and trigger auto-push.
        // Wait for the task to reach "pushed" status (auto-push after resolution).
        const finalTask = await waitForTaskStatus(ctx.manager, task.config.id, ["pushed"], 10000);
        expect(finalTask.state.status).toBe("pushed");
        expect(finalTask.state.syncState).toBeUndefined();
        expect(finalTask.state.reviewMode).toBeDefined();
        expect(finalTask.state.reviewMode!.completionAction).toBe("push");

        // Verify task.pushed event was emitted
        const pushedEvent = ctx.events.find((e) => e.type === "task.pushed");
        expect(pushedEvent).toBeDefined();
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("does not auto-push when conflict resolution fails", async () => {
      // Mock responses consumed in order:
      // Index 0: subscribeToEvents (initial task iteration) → COMPLETE
      // Index 1: subscribeToEvents (conflict resolution iteration) → ERROR
      // With maxConsecutiveErrors: 1, a single error triggers failsafe → "failed" status
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: { "test.txt": "Initial content" },
        mockResponses: [
          "<promise>COMPLETE</promise>",
          "ERROR:Failed to resolve conflicts",
        ],
      });

      try {
        const { remoteDir } = await setupRemote(ctx);

        const task = await ctx.manager.createTask({
          ...testModelFields,
          directory: ctx.workDir,
          prompt: "Modify test.txt",
          name: "Test Task",
          planMode: false,
          workspaceId: testWorkspaceId,
          maxConsecutiveErrors: 1,
        });

        await ctx.manager.startTask(task.config.id);
        await waitForEvent(ctx.events, "task.completed");

        // Get the worktree path and modify test.txt to create a conflict
        const completedTask = await ctx.manager.getTask(task.config.id);
        const worktreePath = completedTask!.state.git!.worktreePath!;

        await writeFile(join(worktreePath, "test.txt"), "Modified by task\n");
        await Bun.$`git -C ${worktreePath} add -A`.quiet();
        await Bun.$`git -C ${worktreePath} commit -m "Task changes"`.quiet();

        // Add conflicting commit to remote
        await addRemoteCommit(
          remoteDir,
          { "test.txt": "Conflicting remote\n" },
          "Conflicting remote commit",
          ctx.dataDir,
        );

        // Clear events for cleaner assertions
        ctx.events.length = 0;

        // Push — should start conflict resolution
        const pushResult = await ctx.manager.pushTask(task.config.id);
        expect(pushResult.success).toBe(true);
        expect(pushResult.syncStatus).toBe("conflicts_being_resolved");
        // remoteBranch should NOT be set when push is deferred
        expect(pushResult.remoteBranch).toBeUndefined();

        // Wait for the conflict resolution engine to fail
        const failedTask = await waitForTaskStatus(
          ctx.manager,
          task.config.id,
          ["failed"],
          10000,
        );
        expect(failedTask.state.status).toBe("failed");

        // autoPushOnComplete should have been cleared
        expect(failedTask.state.syncState?.autoPushOnComplete).toBe(false);

        // Verify NO task.pushed event was emitted
        const pushedEvent = ctx.events.find((e) => e.type === "task.pushed");
        expect(pushedEvent).toBeUndefined();
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("edge cases", () => {
    test("rejects push when task is not in completed status", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: { "test.txt": "content" },
      });

      try {
        await setupRemote(ctx);
        const task = await ctx.manager.createTask({
          ...testModelFields,
          directory: ctx.workDir,
          prompt: "Test",
          name: "Test Task",
          planMode: false,
          workspaceId: testWorkspaceId,
        });

        // Don't start the task — it's still in "idle" status
        const pushResult = await ctx.manager.pushTask(task.config.id);
        expect(pushResult.success).toBe(false);
        expect(pushResult.error).toContain("Cannot push task in status");
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("rejects push for non-existent task", async () => {
      const ctx = await setupTestContext({ initGit: true });

      try {
        const pushResult = await ctx.manager.pushTask("non-existent-id");
        expect(pushResult.success).toBe(false);
        expect(pushResult.error).toContain("not found");
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("syncState is cleared when jumpstarting a task", async () => {
      // Mock responses consumed in order:
      // Index 0: subscribeToEvents (initial task iteration) → COMPLETE
      // Index 1: subscribeToEvents (conflict resolution iteration) → ERROR (fails with maxConsecutiveErrors: 1)
      // Index 2: subscribeToEvents (jumpstarted task iteration) → COMPLETE
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: { "test.txt": "Initial content" },
        mockResponses: [
          "<promise>COMPLETE</promise>",
          "ERROR:Failed to resolve conflicts",
          "<promise>COMPLETE</promise>",
        ],
      });

      try {
        const { remoteDir } = await setupRemote(ctx);

        const task = await ctx.manager.createTask({
          ...testModelFields,
          directory: ctx.workDir,
          prompt: "Modify test.txt",
          name: "Test Task",
          planMode: false,
          workspaceId: testWorkspaceId,
          maxConsecutiveErrors: 1,
        });

        await ctx.manager.startTask(task.config.id);
        await waitForEvent(ctx.events, "task.completed");

        // Create a conflict scenario
        const completedTask = await ctx.manager.getTask(task.config.id);
        const worktreePath = completedTask!.state.git!.worktreePath!;

        await writeFile(join(worktreePath, "test.txt"), "Modified by task\n");
        await Bun.$`git -C ${worktreePath} add -A`.quiet();
        await Bun.$`git -C ${worktreePath} commit -m "Task changes"`.quiet();

        await addRemoteCommit(
          remoteDir,
          { "test.txt": "Conflicting remote\n" },
          "Conflicting commit",
          ctx.dataDir,
        );

        // Push to trigger conflict resolution (which will fail)
        await ctx.manager.pushTask(task.config.id);

        // Wait for the conflict resolution to fail
        await waitForTaskStatus(ctx.manager, task.config.id, ["failed"], 10000);

        // Jumpstart the task via injectPending — syncState should be cleared
        ctx.events.length = 0;
        await ctx.manager.injectPending(task.config.id, { message: "Try again" });
        await waitForEvent(ctx.events, "task.completed");

        const jumpstartedTask = await ctx.manager.getTask(task.config.id);
        expect(jumpstartedTask).not.toBeNull();
        expect(jumpstartedTask!.state.syncState).toBeUndefined();
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });
});

describe("Push with Working Branch Sync", () => {
  describe("working branch has remote commits", () => {
    test("merges remote working branch changes before pushing", async () => {
      // Mock responses consumed in order:
      // Index 0: sendPrompt (name generation) → COMPLETE name
      // Index 1: subscribeToEvents (initial task iteration) → COMPLETE
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: { "test.txt": "Initial content" },
      });

      try {
        const { remoteDir } = await setupRemote(ctx);
        const task = await createAndCompleteTask(ctx);

        // Get the worktree path and working branch
        const completedTask = await ctx.manager.getTask(task.config.id);
        const worktreePath = completedTask!.state.git!.worktreePath!;
        const workingBranch = completedTask!.state.git!.workingBranch;

        // Push the working branch to remote first (simulating a previous push)
        await Bun.$`git -C ${ctx.workDir} push -u origin ${workingBranch}`.quiet();

        // Add a non-conflicting commit to the working branch on the remote
        await addRemoteCommitToBranch(
          remoteDir,
          workingBranch,
          { "remote-working-file.txt": "Added by remote reviewer\n" },
          "Non-conflicting commit on working branch",
          ctx.dataDir,
        );

        // Also make a local change in the worktree (non-conflicting)
        await writeFile(join(worktreePath, "local-change.txt"), "Local change\n");
        await Bun.$`git -C ${worktreePath} add -A`.quiet();
        await Bun.$`git -C ${worktreePath} commit -m "Local changes in worktree"`.quiet();

        // Push the task — should merge remote working branch changes first, then push
        const pushResult = await ctx.manager.pushTask(task.config.id);
        expect(pushResult.success).toBe(true);
        expect(pushResult.remoteBranch).toBeDefined();

        // Verify task is in pushed state
        const pushedTask = await ctx.manager.getTask(task.config.id);
        expect(pushedTask).not.toBeNull();
        expect(pushedTask!.state.status).toBe("pushed");
        expect(pushedTask!.state.syncState).toBeUndefined();

        // Verify the remote file from the working branch was merged in
        const remoteFileExists = await Bun.$`git -C ${worktreePath} show HEAD:remote-working-file.txt`.quiet().then(() => true).catch(() => false);
        expect(remoteFileExists).toBe(true);
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("working branch conflicts", () => {
    test("starts conflict resolution when working branch has conflicting remote changes", async () => {
      // Mock responses consumed in order:
      // Index 0: subscribeToEvents (initial task iteration) → COMPLETE
      // Index 1: subscribeToEvents (conflict resolution for working branch) → COMPLETE
      //
      // NOTE: We only verify that conflict resolution starts with the correct syncPhase.
      // We do NOT wait for the full flow to reach "pushed" because the mock AI doesn't
      // actually run `git merge` to resolve conflicts — it just emits COMPLETE.
      // After the mock "resolves", handleConflictResolutionComplete calls syncBaseBranchAndPush
      // which tries to push, but the push is rejected (non-fast-forward) because the local
      // branch is still behind the remote working branch.
      // The base branch conflict test already covers the full resolution→push flow.
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: { "test.txt": "Initial content" },
        mockResponses: [
          "<promise>COMPLETE</promise>",
          "<promise>COMPLETE</promise>",
        ],
      });

      try {
        const { remoteDir } = await setupRemote(ctx);

        // Create task
        const task = await ctx.manager.createTask({
          ...testModelFields,
          directory: ctx.workDir,
          prompt: "Modify test.txt",
          name: "Test Task",
          planMode: false,
          workspaceId: testWorkspaceId,
        });

        await ctx.manager.startTask(task.config.id);
        await waitForEvent(ctx.events, "task.completed");

        // Get worktree path and working branch
        const completedTask = await ctx.manager.getTask(task.config.id);
        const worktreePath = completedTask!.state.git!.worktreePath!;
        const workingBranch = completedTask!.state.git!.workingBranch;

        // Push the working branch to remote first
        await Bun.$`git -C ${ctx.workDir} push -u origin ${workingBranch}`.quiet();

        // Modify test.txt locally in the worktree
        await writeFile(join(worktreePath, "test.txt"), "Modified locally in worktree\n");
        await Bun.$`git -C ${worktreePath} add -A`.quiet();
        await Bun.$`git -C ${worktreePath} commit -m "Local changes to test.txt"`.quiet();

        // Add a conflicting commit to the working branch on the remote
        await addRemoteCommitToBranch(
          remoteDir,
          workingBranch,
          { "test.txt": "Modified by remote reviewer on working branch\n" },
          "Conflicting remote commit on working branch",
          ctx.dataDir,
        );

        // Push the task — should detect working branch conflicts and start resolution
        const pushResult = await ctx.manager.pushTask(task.config.id);
        expect(pushResult.success).toBe(true);
        expect(pushResult.syncStatus).toBe("conflicts_being_resolved");
        expect(pushResult.remoteBranch).toBeUndefined();

        // Verify sync conflicts event was emitted
        const syncConflicts = ctx.events.find((e) => e.type === "task.sync.conflicts");
        expect(syncConflicts).toBeDefined();

        // Verify syncState was set with the correct syncPhase
        const conflictTask = await ctx.manager.getTask(task.config.id);
        expect(conflictTask).not.toBeNull();
        expect(conflictTask!.state.syncState).toBeDefined();
        expect(conflictTask!.state.syncState!.syncPhase).toBe("working_branch");
        expect(conflictTask!.state.syncState!.autoPushOnComplete).toBe(true);
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });
});

describe("Merge Strategy Configuration", () => {
  // Isolate tests from global/system git config to ensure hermeticity.
  // Without this, machines with pull.rebase set globally would cause the
  // "not configured" assertion to fail since `git config pull.rebase`
  // reads global/system config too. We set these on process.env so that
  // child processes spawned by TestCommandExecutor (which inherits env)
  // are also isolated.
  let savedGlobal: string | undefined;
  let savedSystem: string | undefined;

  function isolateGitConfig() {
    savedGlobal = process.env["GIT_CONFIG_GLOBAL"];
    savedSystem = process.env["GIT_CONFIG_SYSTEM"];
    process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
    process.env["GIT_CONFIG_SYSTEM"] = "/dev/null";
  }

  function restoreGitConfig() {
    if (savedGlobal === undefined) {
      delete process.env["GIT_CONFIG_GLOBAL"];
    } else {
      process.env["GIT_CONFIG_GLOBAL"] = savedGlobal;
    }
    if (savedSystem === undefined) {
      delete process.env["GIT_CONFIG_SYSTEM"];
    } else {
      process.env["GIT_CONFIG_SYSTEM"] = savedSystem;
    }
  }

  test("ensureMergeStrategy sets pull.rebase false when not configured", async () => {
    const ctx = await setupTestContext({
      initGit: true,
      initialFiles: { "test.txt": "Initial content" },
    });

    isolateGitConfig();
    try {
      const { GitService } = await import("../../src/core/git-service");
      const { TestCommandExecutor } = await import("../mocks/mock-executor");
      const executor = new TestCommandExecutor();
      const git = GitService.withExecutor(executor);

      // Ensure pull.rebase is NOT configured locally
      // (unset it explicitly in case the test environment has it set locally)
      await Bun.$`git -C ${ctx.workDir} config --local --unset pull.rebase`.quiet().nothrow();

      // Verify it's not set (with global/system isolated, only local matters)
      const checkBefore = await Bun.$`git -C ${ctx.workDir} config pull.rebase`.quiet().nothrow();
      expect(checkBefore.exitCode).not.toBe(0);

      // Call ensureMergeStrategy
      const result = await git.ensureMergeStrategy(ctx.workDir);
      expect(result).toBe(true);

      // Verify pull.rebase is now set to false
      const checkAfter = (await Bun.$`git -C ${ctx.workDir} config --local pull.rebase`.text()).trim();
      expect(checkAfter).toBe("false");

      // Call again — should be a no-op and still return true
      const result2 = await git.ensureMergeStrategy(ctx.workDir);
      expect(result2).toBe(true);

      // Verify it's still false (wasn't changed)
      const checkFinal = (await Bun.$`git -C ${ctx.workDir} config --local pull.rebase`.text()).trim();
      expect(checkFinal).toBe("false");
    } finally {
      restoreGitConfig();
      await teardownTestContext(ctx);
    }
  });

  test("ensureMergeStrategy is a no-op when already configured", async () => {
    const ctx = await setupTestContext({
      initGit: true,
      initialFiles: { "test.txt": "Initial content" },
    });

    isolateGitConfig();
    try {
      const { GitService } = await import("../../src/core/git-service");
      const { TestCommandExecutor } = await import("../mocks/mock-executor");
      const executor = new TestCommandExecutor();
      const git = GitService.withExecutor(executor);

      // Set pull.rebase to true explicitly (local config)
      await Bun.$`git -C ${ctx.workDir} config --local pull.rebase true`.quiet();

      // Call ensureMergeStrategy — should not overwrite the existing value
      const result = await git.ensureMergeStrategy(ctx.workDir);
      expect(result).toBe(true);

      // Verify it's still true (not changed to false)
      const checkAfter = (await Bun.$`git -C ${ctx.workDir} config --local pull.rebase`.text()).trim();
      expect(checkAfter).toBe("true");
    } finally {
      restoreGitConfig();
      await teardownTestContext(ctx);
    }
  });
});
