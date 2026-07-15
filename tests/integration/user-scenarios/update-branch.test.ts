/**
 * Integration tests for the "Update Branch" feature.
 * Tests syncing a pushed task's working branch with the base branch
 * and re-pushing via the API endpoint.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { writeFile } from "fs/promises";
import { join } from "path";
import {
  setupTestServer,
  teardownTestServer,
  createTaskViaAPI,
  waitForTaskStatus,
  pushTaskViaAPI,
  updateBranchViaAPI,
  type TestServerContext,
} from "./helpers";
import type { Task } from "@/shared/task";

describe("Update Branch User Scenarios", () => {
  describe("Already Up To Date", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          // Initial task iteration → COMPLETE
          "<promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
        withRemote: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("update-branch re-pushes when base branch has no new commits", async () => {
      // Create and complete initial task
      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Implement a feature",
        planMode: false,
      });
      const task = body as Task;

      // Wait for completion
      await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

      // Push the task
      const { status: pushStatus, body: pushBody } = await pushTaskViaAPI(ctx.baseUrl, task.config.id);
      expect(pushStatus).toBe(200);
      expect(pushBody.success).toBe(true);

      // Verify task is pushed
      const pushedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "pushed");
      expect(pushedTask.state.reviewMode).toBeDefined();
      expect(pushedTask.state.reviewMode?.addressable).toBe(true);
      expect(pushedTask.state.reviewMode?.completionAction).toBe("push");

      // Update branch — no changes on base, should be "already_up_to_date"
      const { status: updateStatus, body: updateBody } = await updateBranchViaAPI(ctx.baseUrl, task.config.id);
      expect(updateStatus).toBe(200);
      expect(updateBody.success).toBe(true);
      expect(updateBody.syncStatus).toBe("already_up_to_date");
      expect(updateBody.remoteBranch).toBeDefined();

      // Verify task remains in pushed status with reviewMode preserved
      const afterUpdate = await waitForTaskStatus(ctx.baseUrl, task.config.id, "pushed");
      expect(afterUpdate.state.reviewMode).toBeDefined();
      expect(afterUpdate.state.reviewMode?.addressable).toBe(true);
      expect(afterUpdate.state.reviewMode?.completionAction).toBe("push");
    });
  });

  describe("Clean Merge with Base Branch", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          // Initial task iteration → COMPLETE
          "<promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
        withRemote: true,
        initialFiles: { "test.txt": "Initial content\n" },
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("update-branch merges and re-pushes when base branch has non-conflicting changes", async () => {
      // Create and complete initial task
      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Implement a feature",
        planMode: false,
      });
      const task = body as Task;

      // Wait for completion and push
      await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      const { body: pushBody } = await pushTaskViaAPI(ctx.baseUrl, task.config.id);
      expect(pushBody.success).toBe(true);
      await waitForTaskStatus(ctx.baseUrl, task.config.id, "pushed");

      // Add a non-conflicting commit to the base branch on the remote
      // (simulate another developer pushing to the base branch)
      const otherClone = join(ctx.dataDir, "other-clone-" + Date.now());
      try {
        await Bun.$`git clone --branch ${ctx.defaultBranch} ${ctx.remoteDir} ${otherClone}`.quiet();
        await Bun.$`git -C ${otherClone} config user.email "other@test.com"`.quiet();
        await Bun.$`git -C ${otherClone} config user.name "Other Developer"`.quiet();
        await writeFile(join(otherClone, "remote-only.txt"), "New file from other developer\n");
        await Bun.$`git -C ${otherClone} add -A`.quiet();
        await Bun.$`git -C ${otherClone} commit -m "Other developer's commit"`.quiet();
        await Bun.$`git -C ${otherClone} push`.quiet();
      } finally {
        await Bun.$`rm -rf ${otherClone}`.quiet();
      }

      // Update branch — should merge cleanly and re-push
      const { status: updateStatus, body: updateBody } = await updateBranchViaAPI(ctx.baseUrl, task.config.id);
      expect(updateStatus).toBe(200);
      expect(updateBody.success).toBe(true);
      expect(updateBody.syncStatus).toBe("clean");
      expect(updateBody.remoteBranch).toBeDefined();

      // Verify task remains in pushed status
      const afterUpdate = await waitForTaskStatus(ctx.baseUrl, task.config.id, "pushed");
      expect(afterUpdate.state.status).toBe("pushed");
      expect(afterUpdate.state.reviewMode?.addressable).toBe(true);
      expect(afterUpdate.state.reviewMode?.completionAction).toBe("push");
    });
  });

  describe("Edge Cases", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await setupTestServer({
        mockResponses: [
          // Initial task iteration → COMPLETE
          "<promise>COMPLETE</promise>",
        ],
        withPlanningDir: true,
        withRemote: true,
      });
    });

    afterAll(async () => {
      await teardownTestServer(ctx);
    });

    test("update-branch rejects non-pushed task", async () => {
      // Create and complete task but don't push
      const { body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Do something",
        planMode: false,
      });
      const task = body as Task;

      await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

      // Try to update-branch on a completed (not pushed) task — returns 400
      const { status: updateStatus, body: updateBody } = await updateBranchViaAPI(ctx.baseUrl, task.config.id);
      expect(updateStatus).toBe(400);
      expect(updateBody.error).toBe("invalid_state");
      expect(updateBody.message).toBe("Task is in an invalid state for this operation");
    });

    test("update-branch rejects non-existent task", async () => {
      const { status: updateStatus, body: updateBody } = await updateBranchViaAPI(ctx.baseUrl, "non-existent-id");
      expect(updateStatus).toBe(404);
      expect(updateBody.error).toBe("not_found");
    });
  });
});
