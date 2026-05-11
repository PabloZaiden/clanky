/**
 * Unit tests for the updateBranch() flow in LoopManager.
 * Tests syncing a pushed loop's branch with the base branch and re-pushing:
 * - Already up to date: no merge needed, re-push
 * - Clean merge: base branch merged cleanly, then re-push
 * - Conflicts: conflict resolution engine started, auto-push on completion
 * - Invalid states: various error conditions
 */

import { test, expect, describe } from "bun:test";
import { writeFile } from "fs/promises";
import { join } from "path";
import {
  setupTestContext,
  teardownTestContext,
  waitForEvent,
  waitForLoopStatus,
  testModelFields,
  testWorkspaceId,
} from "../setup";
import type { TestContext } from "../setup";

/**
 * Helper: set up a bare remote, push the current branch, and return branch name + remote dir.
 */
async function setupRemote(ctx: TestContext): Promise<{ remoteDir: string; currentBranch: string }> {
  const remoteDir = join(ctx.dataDir, "remote-" + Date.now() + ".git");
  await Bun.$`git init --bare ${remoteDir}`.quiet();
  await Bun.$`git -C ${ctx.workDir} remote add origin ${remoteDir}`.quiet();
  const currentBranch = (await Bun.$`git -C ${ctx.workDir} branch --show-current`.text()).trim();
  await Bun.$`git -C ${ctx.workDir} push -u origin ${currentBranch}`.quiet();
  // Set bare repo HEAD to the pushed branch so clones work regardless of git defaults
  await Bun.$`git --git-dir=${remoteDir} symbolic-ref HEAD refs/heads/${currentBranch}`.quiet();
  return { remoteDir, currentBranch };
}

/**
 * Helper: create, complete, and push a loop, returning the loop object.
 */
async function createCompleteAndPushLoop(ctx: TestContext) {
  const loop = await ctx.manager.createLoop({
    ...testModelFields,
    directory: ctx.workDir,
    prompt: "Make changes",
    name: "Test Loop",
    planMode: false,
    workspaceId: testWorkspaceId,
  });

  await ctx.manager.startLoop(loop.config.id);
  await waitForEvent(ctx.events, "loop.completed");

  const pushResult = await ctx.manager.pushLoop(loop.config.id);
  expect(pushResult.success).toBe(true);

  // Clear events after push for cleaner assertions
  ctx.events.length = 0;

  return loop;
}

/**
 * Helper: add a commit to the remote base branch via a second clone.
 */
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

describe("Update Branch", () => {
  describe("already up to date", () => {
    test("re-pushes immediately when base branch has no new commits", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: { "test.txt": "Initial content" },
      });

      try {
        await setupRemote(ctx);
        const loop = await createCompleteAndPushLoop(ctx);

        // Update branch — base branch hasn't changed, should be "already_up_to_date"
        const result = await ctx.manager.updateBranch(loop.config.id);
        expect(result.success).toBe(true);
        expect(result.syncStatus).toBe("already_up_to_date");
        expect(result.remoteBranch).toBeDefined();

        // Verify loop remains in pushed state
        const updatedLoop = await ctx.manager.getLoop(loop.config.id);
        expect(updatedLoop).not.toBeNull();
        expect(updatedLoop!.state.status).toBe("pushed");
        expect(updatedLoop!.state.syncState).toBeUndefined();
        expect(updatedLoop!.state.reviewMode).toBeDefined();
        expect(updatedLoop!.state.reviewMode!.completionAction).toBe("push");
        expect(updatedLoop!.state.reviewMode!.addressable).toBe(true);

        // Verify sync events were emitted
        const syncStarted = ctx.events.find((e) => e.type === "loop.sync.started");
        expect(syncStarted).toBeDefined();
        const syncClean = ctx.events.find((e) => e.type === "loop.sync.clean");
        expect(syncClean).toBeDefined();
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("clean merge", () => {
    test("merges and re-pushes when base branch has non-conflicting changes", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: { "test.txt": "Initial content" },
      });

      try {
        const { remoteDir, currentBranch } = await setupRemote(ctx);
        const loop = await createCompleteAndPushLoop(ctx);

        // Add a non-conflicting commit to the base branch on the remote
        await addRemoteCommit(
          remoteDir,
          currentBranch,
          { "remote-only.txt": "Remote content\n" },
          "Non-conflicting remote commit",
          ctx.dataDir,
        );

        // Update branch — should merge cleanly, then re-push
        const result = await ctx.manager.updateBranch(loop.config.id);
        expect(result.success).toBe(true);
        expect(result.syncStatus).toBe("clean");
        expect(result.remoteBranch).toBeDefined();

        // Verify loop remains in pushed state
        const updatedLoop = await ctx.manager.getLoop(loop.config.id);
        expect(updatedLoop).not.toBeNull();
        expect(updatedLoop!.state.status).toBe("pushed");
        expect(updatedLoop!.state.syncState).toBeUndefined();

        // Verify sync events
        const syncStarted = ctx.events.find((e) => e.type === "loop.sync.started");
        expect(syncStarted).toBeDefined();
        const syncClean = ctx.events.find((e) => e.type === "loop.sync.clean");
        expect(syncClean).toBeDefined();
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("conflict resolution", () => {
    test("starts conflict resolution engine when merge conflicts exist", async () => {
      // Mock responses consumed in order:
      // Index 0: subscribeToEvents (initial loop iteration) → COMPLETE
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
        const { remoteDir, currentBranch } = await setupRemote(ctx);

        // Create loop
        const loop = await ctx.manager.createLoop({
          ...testModelFields,
          directory: ctx.workDir,
          prompt: "Modify test.txt",
          name: "Test Loop",
          planMode: false,
          workspaceId: testWorkspaceId,
        });

        await ctx.manager.startLoop(loop.config.id);
        await waitForEvent(ctx.events, "loop.completed");

        // Get the worktree path for the loop
        const completedLoop = await ctx.manager.getLoop(loop.config.id);
        const worktreePath = completedLoop!.state.git!.worktreePath!;

        // Modify test.txt in the worktree (simulating what the loop engine would do)
        await writeFile(join(worktreePath, "test.txt"), "Modified by loop\n");
        await Bun.$`git -C ${worktreePath} add -A`.quiet();
        await Bun.$`git -C ${worktreePath} commit -m "Loop changes to test.txt"`.quiet();

        // Push the loop first
        const pushResult = await ctx.manager.pushLoop(loop.config.id);
        expect(pushResult.success).toBe(true);
        ctx.events.length = 0;

        // Now add a conflicting commit to the base branch on the remote
        await addRemoteCommit(
          remoteDir,
          currentBranch,
          { "test.txt": "Modified by someone else\n" },
          "Conflicting remote commit to test.txt",
          ctx.dataDir,
        );

        // Update branch — should detect conflicts and start resolution engine
        const result = await ctx.manager.updateBranch(loop.config.id);
        expect(result.success).toBe(true);
        expect(result.syncStatus).toBe("conflicts_being_resolved");
        expect(result.remoteBranch).toBeUndefined();

        // Verify sync conflicts event was emitted
        const syncConflicts = ctx.events.find((e) => e.type === "loop.sync.conflicts");
        expect(syncConflicts).toBeDefined();

        // The conflict resolution engine should have been started.
        // With the mock backend, it will complete quickly and trigger auto-push.
        // Wait for the loop to reach "pushed" status (auto-push after resolution).
        const finalLoop = await waitForLoopStatus(ctx.manager, loop.config.id, ["pushed"], 10000);
        expect(finalLoop.state.status).toBe("pushed");
        expect(finalLoop.state.syncState).toBeUndefined();
        expect(finalLoop.state.reviewMode).toBeDefined();
        expect(finalLoop.state.reviewMode!.completionAction).toBe("push");

        // Verify loop.pushed event was emitted
        const pushedEvent = ctx.events.find((e) => e.type === "loop.pushed");
        expect(pushedEvent).toBeDefined();
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("edge cases", () => {
    test("rejects update-branch when loop is not in pushed status", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: { "test.txt": "content" },
      });

      try {
        await setupRemote(ctx);
        const loop = await ctx.manager.createLoop({
          ...testModelFields,
          directory: ctx.workDir,
          prompt: "Test",
          name: "Test Loop",
          planMode: false,
          workspaceId: testWorkspaceId,
        });

        await ctx.manager.startLoop(loop.config.id);
        await waitForEvent(ctx.events, "loop.completed");

        // Loop is in "completed" status, not "pushed"
        const result = await ctx.manager.updateBranch(loop.config.id);
        expect(result.success).toBe(false);
        expect(result.error).toContain("Cannot update branch for loop in status");
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("rejects update-branch for non-existent loop", async () => {
      const ctx = await setupTestContext({ initGit: true });

      try {
        const result = await ctx.manager.updateBranch("non-existent-id");
        expect(result.success).toBe(false);
        expect(result.error).toContain("not found");
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("rejects update-branch when loop has no git state", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: { "test.txt": "content" },
      });

      try {
        await setupRemote(ctx);
        const loop = await ctx.manager.createLoop({
          ...testModelFields,
          directory: ctx.workDir,
          prompt: "Test",
          name: "Test Loop",
          planMode: false,
          workspaceId: testWorkspaceId,
        });

        // Don't start the loop — it has no git state
        // But we also need it to be in "pushed" status for the test to reach the git check.
        // Since we can't get to "pushed" without git state, this test effectively validates
        // that a loop without git state can't be in "pushed" status.
        // The status check happens first, so it returns a status error instead.
        const result = await ctx.manager.updateBranch(loop.config.id);
        expect(result.success).toBe(false);
        // Will fail on status check since idle != pushed
        expect(result.error).toContain("Cannot update branch for loop in status");
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("rejects concurrent update-branch operations on the same loop", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: { "test.txt": "Initial content" },
      });

      try {
        await setupRemote(ctx);
        const loop = await createCompleteAndPushLoop(ctx);

        // Start first update (don't await)
        const first = ctx.manager.updateBranch(loop.config.id);

        // Immediately try a second update — should be rejected
        const second = await ctx.manager.updateBranch(loop.config.id);
        expect(second.success).toBe(false);
        expect(second.error).toContain("already in progress");

        // Let first complete
        await first;
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });
});
