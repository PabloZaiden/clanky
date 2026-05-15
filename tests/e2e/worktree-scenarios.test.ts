/**
 * E2E scenario tests for per-loop git worktrees.
 * These tests verify the full worktree lifecycle through the HTTP API,
 * including creation, isolation, persistence, and cleanup.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { writeFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import {
  setupTestServer,
  teardownTestServer,
  createLoopViaAPI,
  waitForLoopStatus,
  acceptLoopViaAPI,
  pushLoopViaAPI,
  discardLoopViaAPI,
  getCurrentBranch,
  branchExists,
  remoteBranchExists,
  assertLoopState,
  getLoopViaAPI,
  type TestServerContext,
} from "../integration/user-scenarios/helpers";
import type { Loop } from "../../src/types/loop";

/**
 * Helper to purge a loop via the API.
 */
async function purgeLoopViaAPI(
  baseUrl: string,
  loopId: string
): Promise<{ status: number; body: { success: boolean; error?: string } }> {
  const response = await fetch(`${baseUrl}/api/loops/${loopId}/purge`, {
    method: "POST",
  });
  const body = await response.json();
  return { status: response.status, body };
}

/**
 * Helper to check if a worktree directory exists on disk.
 */
function worktreeDirectoryExists(worktreePath: string): boolean {
  return existsSync(worktreePath);
}

/**
 * Helper to list git worktrees for a repo.
 */
async function listWorktrees(workDir: string): Promise<string[]> {
  const result = await Bun.$`git -C ${workDir} worktree list --porcelain`.quiet();
  const output = result.stdout.toString();
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      // Git resolves symlinks in its output (e.g., macOS /var → /private/var),
      // so the paths are already resolved. Return them as-is.
      paths.push(line.slice("worktree ".length));
    }
  }
  return paths;
}

describe("Worktree Scenarios", () => {
  describe("Full loop lifecycle with worktree", () => {
    let ctx: TestServerContext;

    beforeEach(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "wt-lifecycle-loop",
          "Working on iteration 1...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterEach(async () => {
      await teardownTestServer(ctx);
    });

    test("create → complete → accept → purge removes worktree", async () => {
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create and start loop
      const { status, body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Full lifecycle test",
        planMode: false,
      });
      expect(status).toBe(201);
      const loop = body as Loop;

      // Wait for completion
      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      assertLoopState(completedLoop, { status: "completed", hasGitBranch: true, hasError: false });

      // Verify worktree was created
      const worktreePath = completedLoop.state.git!.worktreePath;
      expect(worktreePath).toBeDefined();
      expect(worktreePath).toContain(".ralph-worktrees/");
      expect(worktreeDirectoryExists(worktreePath!)).toBe(true);

      // Main checkout unchanged
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Accept (merge) — worktree should persist
      const { status: acceptStatus } = await acceptLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(acceptStatus).toBe(200);

      const mergedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "accepted_local");
      expect(worktreeDirectoryExists(worktreePath!)).toBe(true);

      // Purge — worktree should be removed
      const { status: purgeStatus, body: purgeBody } = await purgeLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(purgeStatus).toBe(200);
      expect(purgeBody.success).toBe(true);

      // Worktree directory should be gone
      expect(worktreeDirectoryExists(worktreePath!)).toBe(false);

      // Worktree should not appear in git worktree list
      const worktrees = await listWorktrees(ctx.workDir);
      expect(worktrees).not.toContain(worktreePath!);

      // Branch should be deleted
      expect(await branchExists(ctx.workDir, mergedLoop.state.git!.workingBranch)).toBe(false);

      // Loop should be deleted from DB
      const { status: getStatus } = await getLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(getStatus).toBe(404);
    });
  });

  describe("Concurrent loops on same workspace", () => {
    let ctx: TestServerContext;

    beforeEach(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          // Loop 1 responses
          "concurrent-loop-one",
          "Working loop 1...",
          "Done loop 1! <promise>COMPLETE</promise>",
          // Loop 2 responses
          "concurrent-loop-two",
          "Working loop 2...",
          "Done loop 2! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterEach(async () => {
      await teardownTestServer(ctx);
    });

    test("two loops can run concurrently with separate worktrees", async () => {
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create both loops
      const { body: body1 } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Concurrent loop 1",
        planMode: false,
      });
      const loop1 = body1 as Loop;

      const { body: body2 } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Concurrent loop 2",
        planMode: false,
      });
      const loop2 = body2 as Loop;

      // Wait for both to complete
      const [completed1, completed2] = await Promise.all([
        waitForLoopStatus(ctx.baseUrl, loop1.config.id, "completed"),
        waitForLoopStatus(ctx.baseUrl, loop2.config.id, "completed"),
      ]);

      // Both should have separate worktrees
      const wt1 = completed1.state.git!.worktreePath!;
      const wt2 = completed2.state.git!.worktreePath!;
      expect(wt1).toBeDefined();
      expect(wt2).toBeDefined();
      expect(wt1).not.toBe(wt2);

      // Both worktree directories should exist
      expect(worktreeDirectoryExists(wt1)).toBe(true);
      expect(worktreeDirectoryExists(wt2)).toBe(true);

      // Separate branches
      const branch1 = completed1.state.git!.workingBranch;
      const branch2 = completed2.state.git!.workingBranch;
      expect(branch1).not.toBe(branch2);
      expect(await branchExists(ctx.workDir, branch1)).toBe(true);
      expect(await branchExists(ctx.workDir, branch2)).toBe(true);

      // Main checkout unchanged throughout
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Clean up both
      await discardLoopViaAPI(ctx.baseUrl, loop1.config.id);
      await discardLoopViaAPI(ctx.baseUrl, loop2.config.id);
    });
  });

  describe("Loop with uncommitted changes in main checkout", () => {
    let ctx: TestServerContext;

    beforeEach(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "uncommitted-test-loop",
          "Working...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterEach(async () => {
      await teardownTestServer(ctx);
    });

    test("loop starts successfully despite uncommitted changes in main checkout", async () => {
      // Create uncommitted changes in main checkout
      await writeFile(join(ctx.workDir, "dirty-file.txt"), "uncommitted content");
      await Bun.$`git -C ${ctx.workDir} add dirty-file.txt`.quiet();

      // Create and start loop — should NOT be blocked
      const { status, body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Loop with dirty main checkout",
        planMode: false,
      });
      expect(status).toBe(201);
      const loop = body as Loop;

      // Wait for completion
      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      assertLoopState(completedLoop, { status: "completed", hasGitBranch: true, hasError: false });

      // Worktree should exist and be clean (doesn't inherit main checkout's dirty state)
      const worktreePath = completedLoop.state.git!.worktreePath!;
      expect(worktreeDirectoryExists(worktreePath)).toBe(true);

      // Main checkout should still have the staged dirty file
      const statusOutput = (await Bun.$`git -C ${ctx.workDir} status --porcelain`.quiet()).stdout.toString();
      expect(statusOutput).toContain("dirty-file.txt");

      // Clean up
      await discardLoopViaAPI(ctx.baseUrl, loop.config.id);
      // Reset the dirty state
      await Bun.$`git -C ${ctx.workDir} reset HEAD -- dirty-file.txt`.quiet();
      await Bun.$`git -C ${ctx.workDir} checkout -- .`.quiet();
      await Bun.$`git -C ${ctx.workDir} clean -fd`.quiet();
    });
  });

  describe("Discard preserves worktree", () => {
    let ctx: TestServerContext;

    beforeEach(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "discard-preserve-loop",
          "Working...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterEach(async () => {
      await teardownTestServer(ctx);
    });

    test("discard marks loop as deleted but preserves worktree until purge", async () => {
      // Create and complete loop
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Discard test",
        planMode: false,
      });
      const loop = body as Loop;

      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      const worktreePath = completedLoop.state.git!.worktreePath!;
      expect(worktreeDirectoryExists(worktreePath)).toBe(true);

      // Discard — worktree should persist
      const { status: discardStatus } = await discardLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(discardStatus).toBe(200);

      const deletedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "deleted");
      assertLoopState(deletedLoop, { status: "deleted", hasError: false });

      // Worktree directory should still exist after discard
      expect(worktreeDirectoryExists(worktreePath)).toBe(true);

      // Now purge — worktree should be removed
      const { status: purgeStatus, body: purgeBody } = await purgeLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(purgeStatus).toBe(200);
      expect(purgeBody.success).toBe(true);

      // Worktree directory should be gone after purge
      expect(worktreeDirectoryExists(worktreePath)).toBe(false);
    });
  });

  describe("Push preserves worktree", () => {
    let ctx: TestServerContext;

    beforeEach(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "push-preserve-loop",
          "Working...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
        withRemote: true,
      });
    });

    afterEach(async () => {
      await teardownTestServer(ctx);
    });

    test("push succeeds from worktree and worktree persists until purge", async () => {
      expect(ctx.remoteDir).toBeDefined();

      // Create and complete loop
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Push test",
        planMode: false,
      });
      const loop = body as Loop;

      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      const worktreePath = completedLoop.state.git!.worktreePath!;
      const workingBranch = completedLoop.state.git!.workingBranch;

      // Push — worktree should persist
      const { status: pushStatus, body: pushBody } = await pushLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(pushStatus).toBe(200);
      expect(pushBody.success).toBe(true);

      // Verify branch exists on remote
      expect(await remoteBranchExists(ctx.workDir, workingBranch)).toBe(true);

      // Worktree should still exist after push
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "pushed");
      expect(worktreeDirectoryExists(worktreePath)).toBe(true);

      // Purge should clean up everything
      const { status: purgeStatus, body: purgeBody } = await purgeLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(purgeStatus).toBe(200);
      expect(purgeBody.success).toBe(true);

      // Worktree gone
      expect(worktreeDirectoryExists(worktreePath)).toBe(false);
      // Branch deleted locally
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(false);
    });
  });

  describe("Git exclude validation", () => {
    let ctx: TestServerContext;

    beforeEach(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "exclude-test-loop-one",
          "Working...",
          "Done! <promise>COMPLETE</promise>",
          "exclude-test-loop-two",
          "Working...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterEach(async () => {
      await teardownTestServer(ctx);
    });

    test(".ralph-worktrees is re-validated in .git/info/exclude on every loop creation", async () => {
      // Create first loop — should add exclude entry
      const { body: body1 } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "First loop",
        planMode: false,
      });
      const loop1 = body1 as Loop;
      await waitForLoopStatus(ctx.baseUrl, loop1.config.id, "completed");

      // Verify exclude entry exists
      const excludePath = join(ctx.workDir, ".git/info/exclude");
      let excludeContent = await Bun.file(excludePath).text();
      expect(excludeContent).toContain(".ralph-worktrees");

      // Manually remove the exclude entry
      excludeContent = excludeContent
        .split("\n")
        .filter((line) => !line.includes(".ralph-worktrees"))
        .join("\n");
      await writeFile(excludePath, excludeContent);

      // Verify it's gone
      const afterRemoval = await Bun.file(excludePath).text();
      expect(afterRemoval).not.toContain(".ralph-worktrees");

      // Create second loop — should re-add exclude entry
      const { body: body2 } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Second loop",
        planMode: false,
      });
      const loop2 = body2 as Loop;
      await waitForLoopStatus(ctx.baseUrl, loop2.config.id, "completed");

      // Verify exclude entry was re-added
      const finalContent = await Bun.file(excludePath).text();
      expect(finalContent).toContain(".ralph-worktrees");

      // Clean up
      await discardLoopViaAPI(ctx.baseUrl, loop1.config.id);
      await discardLoopViaAPI(ctx.baseUrl, loop2.config.id);
    });
  });

  describe("Purge cleans up completely", () => {
    let ctx: TestServerContext;

    beforeEach(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "purge-cleanup-loop",
          "Working...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterEach(async () => {
      await teardownTestServer(ctx);
    });

    test("purge removes worktree directory, git metadata, branch, and DB entry", async () => {
      // Create and complete loop
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Purge cleanup test",
        planMode: false,
      });
      const loop = body as Loop;

      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      const worktreePath = completedLoop.state.git!.worktreePath!;
      const workingBranch = completedLoop.state.git!.workingBranch;

      // Verify everything exists before purge
      expect(worktreeDirectoryExists(worktreePath)).toBe(true);
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);
      const worktreesBefore = await listWorktrees(ctx.workDir);
      expect(worktreesBefore).toContain(worktreePath);

      // Discard first (required before purge — can only purge deleted/merged/pushed loops)
      await discardLoopViaAPI(ctx.baseUrl, loop.config.id);
      await waitForLoopStatus(ctx.baseUrl, loop.config.id, "deleted");

      // Purge
      const { status: purgeStatus, body: purgeBody } = await purgeLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(purgeStatus).toBe(200);
      expect(purgeBody.success).toBe(true);

      // Verify complete cleanup:
      // 1. Worktree directory removed
      expect(worktreeDirectoryExists(worktreePath)).toBe(false);

      // 2. Git worktree list no longer shows this worktree
      const worktreesAfter = await listWorktrees(ctx.workDir);
      expect(worktreesAfter).not.toContain(worktreePath);

      // 3. Branch deleted
      expect(await branchExists(ctx.workDir, workingBranch)).toBe(false);

      // 4. Loop deleted from DB
      const { status: getStatus } = await getLoopViaAPI(ctx.baseUrl, loop.config.id);
      expect(getStatus).toBe(404);
    });
  });

  describe("Worktree isolation — changes don't leak", () => {
    let ctx: TestServerContext;

    beforeEach(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          "isolation-test-loop",
          "Working...",
          "Done! <promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
      });
    });

    afterEach(async () => {
      await teardownTestServer(ctx);
    });

    test("files created in worktree do not appear in main checkout", async () => {
      const originalBranch = await getCurrentBranch(ctx.workDir);

      // Create and complete loop
      const { body } = await createLoopViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Isolation test",
        planMode: false,
      });
      const loop = body as Loop;

      const completedLoop = await waitForLoopStatus(ctx.baseUrl, loop.config.id, "completed");
      const worktreePath = completedLoop.state.git!.worktreePath!;

      // Create a file in the worktree
      const testFile = "worktree-only-file.txt";
      await writeFile(join(worktreePath, testFile), "worktree content");
      await Bun.$`git -C ${worktreePath} add ${testFile}`.quiet();
      await Bun.$`git -C ${worktreePath} commit -m "Add worktree file"`.quiet();

      // File should exist in worktree
      expect(existsSync(join(worktreePath, testFile))).toBe(true);

      // File should NOT exist in main checkout
      expect(existsSync(join(ctx.workDir, testFile))).toBe(false);

      // Main checkout should still be on original branch
      expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

      // Clean up
      await discardLoopViaAPI(ctx.baseUrl, loop.config.id);
    });
  });
});
