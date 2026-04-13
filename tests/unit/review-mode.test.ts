/**
 * Unit tests for review mode functionality in LoopManager.
 * Tests the review mode features: accept/push loop, address comments, purge.
 */

import { test, expect, describe } from "bun:test";
import { setupTestContext, teardownTestContext, waitForEvent, waitForLoopStatus, testModelFields } from "../setup";
import { join } from "path";
import { saveLoop } from "../../src/persistence/loops";
import { constructAutomaticPrReviewCommentText } from "../../src/core/loop/loop-review";

const testWorkspaceId = "test-workspace-id";

describe("Review Mode", () => {
  describe("acceptLoop with review mode", () => {
    test("initializes review mode after accepting (merging) a loop", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        // Create and complete a loop
        const loop = await ctx.manager.createLoop({
        ...testModelFields,
        directory: ctx.workDir,
          prompt: "Make changes",
          name: "Test Loop",
          planMode: false,
          workspaceId: testWorkspaceId,
        });

        // Start loop and wait for completion
        await ctx.manager.startLoop(loop.config.id);
        await waitForEvent(ctx.events, "loop.completed");

        // Update state to completed
        const completedLoop = await ctx.manager.getLoop(loop.config.id);
        expect(completedLoop).not.toBeNull();
        expect(completedLoop!.state.git?.workingBranch).toBeDefined();

        // Accept (merge) the loop
        const acceptResult = await ctx.manager.acceptLoop(loop.config.id);
        expect(acceptResult.success).toBe(true);

        // Verify review mode is initialized
        const acceptedLoop = await ctx.manager.getLoop(loop.config.id);
        expect(acceptedLoop).not.toBeNull();
        expect(acceptedLoop!.state.status).toBe("merged");
        expect(acceptedLoop!.state.reviewMode).toBeDefined();
        expect(acceptedLoop!.state.reviewMode!.addressable).toBe(true);
        expect(acceptedLoop!.state.reviewMode!.completionAction).toBe("merge");
        expect(acceptedLoop!.state.reviewMode!.reviewCycles).toBe(0);
        // reviewBranches should contain the working branch after merge
        expect(acceptedLoop!.state.reviewMode!.reviewBranches.length).toBe(1);
        expect(acceptedLoop!.state.reviewMode!.reviewBranches[0]).not.toContain("ralph/");
        expect(acceptedLoop!.state.reviewMode!.reviewBranches[0]).toMatch(/-[0-9a-f]{7}$/);
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("does not delete branch after accepting loop", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        // Create and complete a loop
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

        const beforeAccept = await ctx.manager.getLoop(loop.config.id);
        const branchName = beforeAccept!.state.git?.workingBranch!;

        // Accept the loop
        await ctx.manager.acceptLoop(loop.config.id);

        // Verify branch still exists
        const branches = await ctx.git.getLocalBranches(ctx.workDir);
        expect(branches.map((b) => b.name)).toContain(branchName);
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("pushLoop with review mode", () => {
    test("initializes review mode after pushing a loop", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        // Set up remote with unique name to avoid conflicts
        const remoteDir = join(ctx.dataDir, "remote-" + Date.now() + ".git");
        await Bun.$`git init --bare ${remoteDir}`.quiet();
        await Bun.$`git -C ${ctx.workDir} remote add origin ${remoteDir}`.quiet();
        // Get current branch name (could be 'main' or 'master' depending on git config)
        const currentBranch = (await Bun.$`git -C ${ctx.workDir} branch --show-current`.text()).trim();
        // Push current branch first (this will set up the remote properly)
        await Bun.$`git -C ${ctx.workDir} push origin ${currentBranch}`.quiet();

        // Create and complete a loop
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

        // Push the loop
        const pushResult = await ctx.manager.pushLoop(loop.config.id);
        expect(pushResult.success).toBe(true);

        // Verify review mode is initialized
        const pushedLoop = await ctx.manager.getLoop(loop.config.id);
        expect(pushedLoop).not.toBeNull();
        expect(pushedLoop!.state.status).toBe("pushed");
        expect(pushedLoop!.state.reviewMode).toBeDefined();
        expect(pushedLoop!.state.reviewMode!.addressable).toBe(true);
        expect(pushedLoop!.state.reviewMode!.completionAction).toBe("push");
        expect(pushedLoop!.state.reviewMode!.reviewCycles).toBe(0);
        // For pushed loops, reviewBranches tracks the working branch
        expect(pushedLoop!.state.reviewMode!.reviewBranches.length).toBe(1);
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("purgeLoop with review mode", () => {
    test("purges a merged loop completely", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        // Create, complete, and accept a loop
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
        await ctx.manager.acceptLoop(loop.config.id);

        const beforePurge = await ctx.manager.getLoop(loop.config.id);
        expect(beforePurge!.state.reviewMode!.addressable).toBe(true);

        // Purge the loop
        const purgeResult = await ctx.manager.purgeLoop(loop.config.id);
        expect(purgeResult.success).toBe(true);

        // Verify loop is deleted (purged completely removes it)
        const afterPurge = await ctx.manager.getLoop(loop.config.id);
        expect(afterPurge).toBeNull();
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("addressReviewComments", () => {
    test("fails to address comments on non-addressable loop", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        // Create a loop but don't accept/push it
        const loop = await ctx.manager.createLoop({
        ...testModelFields,
        directory: ctx.workDir,
          prompt: "Make changes",
          name: "Test Loop",
          planMode: false,
          workspaceId: testWorkspaceId,
        });

        // Try to address comments
        const result = await ctx.manager.addressReviewComments(
          loop.config.id,
          "This should fail"
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("not addressable");
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("fails to address comments with empty comments", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        // Create, complete, and accept a loop
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
        await ctx.manager.acceptLoop(loop.config.id);

        // Try to address with empty comments - this should fail validation
        // Note: The validation checks addressable first, so we need the loop to be addressable
        const result = await ctx.manager.addressReviewComments(loop.config.id, "");

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("sendFollowUp", () => {
    test("restarts a pushed loop on the existing review branch", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        const remoteDir = join(ctx.dataDir, `remote-${Date.now()}.git`);
        await Bun.$`git init --bare ${remoteDir}`.quiet();
        await Bun.$`git -C ${ctx.workDir} remote add origin ${remoteDir}`.quiet();
        const currentBranch = (await Bun.$`git -C ${ctx.workDir} branch --show-current`.text()).trim();
        await Bun.$`git -C ${ctx.workDir} push origin ${currentBranch}`.quiet();

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

        const pushedLoop = await ctx.manager.getLoop(loop.config.id);
        const workingBranch = pushedLoop!.state.git!.workingBranch;

        const followUpResult = await ctx.manager.sendFollowUp(loop.config.id, {
          message: "Please make another pass",
        });

        expect(followUpResult.success).toBe(true);
        expect(followUpResult.reviewCycle).toBe(1);
        expect(followUpResult.branch).toBe(workingBranch);

        await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("restarts a merged loop on a new review branch", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
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
        const accepted = await ctx.manager.acceptLoop(loop.config.id);
        expect(accepted.success).toBe(true);

        const mergedLoop = await ctx.manager.getLoop(loop.config.id);
        const originalBranch = mergedLoop!.state.git!.workingBranch;

        const followUpResult = await ctx.manager.sendFollowUp(loop.config.id, {
          message: "Please refine the merged result",
        });

        expect(followUpResult.success).toBe(true);
        expect(followUpResult.reviewCycle).toBe(1);
        expect(followUpResult.branch).toBeDefined();
        expect(followUpResult.branch).not.toBe(originalBranch);

        await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("revives a deleted loop with the same loop id", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
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

        const deleted = await ctx.manager.deleteLoop(loop.config.id);
        expect(deleted).toBe(true);

        const deletedLoop = await ctx.manager.getLoop(loop.config.id);
        expect(deletedLoop!.state.status).toBe("deleted");

        const followUpResult = await ctx.manager.sendFollowUp(loop.config.id, {
          message: "Please try again",
        });

        expect(followUpResult.success).toBe(true);

        const restartedLoop = await ctx.manager.getLoop(loop.config.id);
        expect(restartedLoop!.config.id).toBe(loop.config.id);
        expect(restartedLoop!.state.status).not.toBe("deleted");

        await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("automatic PR review cycles", () => {
    test("stores automatic PR feedback in comment history and marks it addressed on completion", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        const remoteDir = join(ctx.dataDir, `remote-${Date.now()}.git`);
        await Bun.$`git init --bare ${remoteDir}`.quiet();
        await Bun.$`git -C ${ctx.workDir} remote add origin ${remoteDir}`.quiet();
        const currentBranch = (await Bun.$`git -C ${ctx.workDir} branch --show-current`.text()).trim();
        await Bun.$`git -C ${ctx.workDir} push origin ${currentBranch}`.quiet();

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

        const pushedLoop = await ctx.manager.getLoop(loop.config.id);
        expect(pushedLoop).not.toBeNull();
        pushedLoop!.state.automaticPrFlow = {
          enabled: true,
          status: "monitoring",
          startedAt: "2026-04-13T22:45:39.694Z",
          updatedAt: "2026-04-13T22:45:39.694Z",
          lastCheckedAt: "2026-04-13T22:45:39.694Z",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.com/owner/repo/pull/42",
          handledItems: [],
          activeBatch: undefined,
          stoppedAt: undefined,
        };
        await saveLoop(pushedLoop!);

        const feedbackItems = [
          {
            id: "thread-1",
            source: "review_thread" as const,
            body: "Please add a missing edge-case test.",
            authorLogin: "reviewer",
            path: "src/index.ts",
            line: 12,
            url: "https://github.com/owner/repo/pull/42#discussion_r1",
          },
          {
            id: "comment-2",
            source: "review_comment" as const,
            body: "Also tighten the error message.",
            authorLogin: "reviewer",
          },
        ];

        const expectedCommentText = constructAutomaticPrReviewCommentText(feedbackItems);
        const reviewCycleResult = await ctx.manager.startAutomaticPrReviewCycle(loop.config.id, {
          batchId: "batch-1",
          itemIds: feedbackItems.map((item) => item.id),
          feedbackItems,
        });

        expect(reviewCycleResult.success).toBe(true);
        expect(reviewCycleResult.reviewCycle).toBe(1);
        expect(reviewCycleResult.commentIds).toHaveLength(1);

        const pendingComment = ctx.manager.getReviewComments(loop.config.id).find(
          (comment) => comment.id === reviewCycleResult.commentIds?.[0]
        );
        expect(pendingComment).toBeDefined();
        expect(pendingComment?.reviewCycle).toBe(1);
        expect(pendingComment?.status).toBe("pending");
        expect(pendingComment?.commentText).toBe(expectedCommentText);

        await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

        const addressedComment = ctx.manager.getReviewComments(loop.config.id).find(
          (comment) => comment.id === reviewCycleResult.commentIds?.[0]
        );
        expect(addressedComment).toBeDefined();
        expect(addressedComment?.status).toBe("addressed");
        expect(addressedComment?.addressedAt).toBeDefined();
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("getReviewHistory", () => {
    test("returns review history for a loop with review mode", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        // Create, complete, and accept a loop
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
        await ctx.manager.acceptLoop(loop.config.id);

        // Get review history
        const result = await ctx.manager.getReviewHistory(loop.config.id);

        expect(result.success).toBe(true);
        expect(result.history).toBeDefined();
        expect(result.history!.addressable).toBe(true);
        expect(result.history!.completionAction).toBe("merge");
        expect(result.history!.reviewCycles).toBe(0);
        // reviewBranches should contain the working branch
        expect(result.history!.reviewBranches.length).toBe(1);
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("returns success with default history for loop without review mode", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        // Create a loop but don't accept/push it
        const loop = await ctx.manager.createLoop({
        ...testModelFields,
        directory: ctx.workDir,
          prompt: "Make changes",
          name: "Test Loop",
          planMode: false,
          workspaceId: testWorkspaceId,
        });

        // Get review history
        const result = await ctx.manager.getReviewHistory(loop.config.id);

        expect(result.success).toBe(true);
        expect(result.history).toBeDefined();
        expect(result.history!.addressable).toBe(false);
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("returns error for non-existent loop", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        const result = await ctx.manager.getReviewHistory("non-existent-id");
        expect(result.success).toBe(false);
        expect(result.error).toBe("Loop not found");
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });

  describe("Completion Action Enforcement", () => {
    test("acceptLoop rejects if loop was originally pushed", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        // Set up remote for pushing
        const remoteDir = join(ctx.dataDir, "remote-" + Date.now() + ".git");
        await Bun.$`git init --bare ${remoteDir}`.quiet();
        await Bun.$`git -C ${ctx.workDir} remote add origin ${remoteDir}`.quiet();
        const currentBranch = (await Bun.$`git -C ${ctx.workDir} branch --show-current`.text()).trim();
        await Bun.$`git -C ${ctx.workDir} push origin ${currentBranch}`.quiet();

        // Create, complete, and push a loop
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

        // Push the loop (sets completionAction to "push")
        const pushResult = await ctx.manager.pushLoop(loop.config.id);
        expect(pushResult.success).toBe(true);

        // Verify it was pushed
        const pushedLoop = await ctx.manager.getLoop(loop.config.id);
        expect(pushedLoop!.state.reviewMode?.completionAction).toBe("push");

        // Address comments to start a new review cycle
        const addressResult = await ctx.manager.addressReviewComments(
          loop.config.id,
          "Please fix this issue"
        );
        expect(addressResult.success).toBe(true);

        // Wait for the review cycle to complete
        await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

        // Now try to accept (merge) - this should be rejected
        const acceptResult = await ctx.manager.acceptLoop(loop.config.id);
        expect(acceptResult.success).toBe(false);
        expect(acceptResult.error).toContain("originally pushed");
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("pushLoop rejects if loop was originally merged", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        // Set up remote for pushing
        const remoteDir = join(ctx.dataDir, "remote-" + Date.now() + ".git");
        await Bun.$`git init --bare ${remoteDir}`.quiet();
        await Bun.$`git -C ${ctx.workDir} remote add origin ${remoteDir}`.quiet();
        const currentBranch = (await Bun.$`git -C ${ctx.workDir} branch --show-current`.text()).trim();
        await Bun.$`git -C ${ctx.workDir} push origin ${currentBranch}`.quiet();

        // Create, complete, and merge a loop
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

        // Accept (merge) the loop (sets completionAction to "merge")
        const acceptResult = await ctx.manager.acceptLoop(loop.config.id);
        expect(acceptResult.success).toBe(true);

        // Verify it was merged
        const mergedLoop = await ctx.manager.getLoop(loop.config.id);
        expect(mergedLoop!.state.reviewMode?.completionAction).toBe("merge");

        // Address comments to start a new review cycle
        const addressResult = await ctx.manager.addressReviewComments(
          loop.config.id,
          "Please fix this issue"
        );
        expect(addressResult.success).toBe(true);

        // Wait for the review cycle to complete
        await waitForLoopStatus(ctx.manager, loop.config.id, ["completed", "max_iterations"]);

        // Now try to push - this should be rejected
        const pushResult = await ctx.manager.pushLoop(loop.config.id);
        expect(pushResult.success).toBe(false);
        expect(pushResult.error).toContain("originally merged");
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("acceptLoop allows merge on first completion (no prior completionAction)", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        // Create and complete a loop
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

        // Verify no prior reviewMode
        const beforeAccept = await ctx.manager.getLoop(loop.config.id);
        expect(beforeAccept!.state.reviewMode).toBeUndefined();

        // Accept (merge) should succeed
        const acceptResult = await ctx.manager.acceptLoop(loop.config.id);
        expect(acceptResult.success).toBe(true);

        // Verify completionAction is now set
        const afterAccept = await ctx.manager.getLoop(loop.config.id);
        expect(afterAccept!.state.reviewMode?.completionAction).toBe("merge");
      } finally {
        await teardownTestContext(ctx);
      }
    });

    test("pushLoop allows push on first completion (no prior completionAction)", async () => {
      const ctx = await setupTestContext({
        initGit: true,
        initialFiles: {
          "test.txt": "Initial content",
        },
      });

      try {
        // Set up remote for pushing
        const remoteDir = join(ctx.dataDir, "remote-" + Date.now() + ".git");
        await Bun.$`git init --bare ${remoteDir}`.quiet();
        await Bun.$`git -C ${ctx.workDir} remote add origin ${remoteDir}`.quiet();
        const currentBranch = (await Bun.$`git -C ${ctx.workDir} branch --show-current`.text()).trim();
        await Bun.$`git -C ${ctx.workDir} push origin ${currentBranch}`.quiet();

        // Create and complete a loop
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

        // Verify no prior reviewMode
        const beforePush = await ctx.manager.getLoop(loop.config.id);
        expect(beforePush!.state.reviewMode).toBeUndefined();

        // Push should succeed
        const pushResult = await ctx.manager.pushLoop(loop.config.id);
        expect(pushResult.success).toBe(true);

        // Verify completionAction is now set
        const afterPush = await ctx.manager.getLoop(loop.config.id);
        expect(afterPush!.state.reviewMode?.completionAction).toBe("push");
      } finally {
        await teardownTestContext(ctx);
      }
    });
  });
});
