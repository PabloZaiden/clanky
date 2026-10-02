import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "fs/promises";
import { join } from "path";
import type { Task } from "@/shared/task";
import { runGit } from "../../helpers/git-fixtures";
import {
  assertTaskState,
  branchExists,
  createTaskViaAPI,
  discardTaskViaAPI,
  getTaskDiffViaAPI,
  getTaskStatusFileViaAPI,
  setupTestServer,
  teardownTestServer,
  waitForTaskStatus,
  type TestServerContext,
} from "./helpers";

describe("Regular Task User Scenarios", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await setupTestServer({
      mockResponses: [
        "chore: remove the stale planning document",
        "Working on iteration 1...",
        "Working on iteration 2...",
        "Done! <promise>COMPLETE</promise>",
      ],
      withPlanningDir: true,
    });
  });

  afterAll(async () => {
    await teardownTestServer(ctx);
  });

  test("runs iterations to completion and exposes task artifacts", async () => {
    const { status, body } = await createTaskViaAPI(ctx, {
      directory: ctx.workDir,
      prompt: "Complete a multi-step task",
    });

    expect(status).toBe(201);
    const task = body as Task;
    const completedTask = await waitForTaskStatus(
      ctx.baseUrl,
      task.config.id,
      "completed",
    );

    assertTaskState(completedTask, {
      status: "completed",
      iterationCount: 4,
      hasGitBranch: true,
      hasError: false,
    });
    expect(completedTask.state.recentIterations.map((iteration) => iteration.outcome))
      .toEqual(["plan_ready", "continue", "continue", "complete"]);

    const workingBranch = completedTask.state.git!.workingBranch;
    expect(await branchExists(ctx.workDir, workingBranch)).toBe(true);

    const diff = await getTaskDiffViaAPI(ctx.baseUrl, task.config.id);
    expect(diff.status).toBe(200);
    expect(Array.isArray(diff.body)).toBe(true);

    const statusFile = await getTaskStatusFileViaAPI(ctx.baseUrl, task.config.id);
    expect(statusFile.status).toBe(200);
    expect(statusFile.body).toMatchObject({ exists: true });

    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  });

  test("allows task execution with uncommitted source-checkout changes", async () => {
    await writeFile(join(ctx.workDir, "uncommitted.txt"), "uncommitted content");
    await runGit(ctx.workDir, ["add", "."]);

    try {
      const { status, body } = await createTaskViaAPI(ctx, {
        directory: ctx.workDir,
        prompt: "Work independently of source checkout changes",
      });

      expect(status).toBe(201);
      const task = body as Task;
      await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      await discardTaskViaAPI(ctx.baseUrl, task.config.id);
    } finally {
      await runGit(ctx.workDir, ["reset", "HEAD", "--", "."]);
      await runGit(ctx.workDir, ["checkout", "--", "."]);
      await runGit(ctx.workDir, ["clean", "-fd"]);
    }
  });
});
