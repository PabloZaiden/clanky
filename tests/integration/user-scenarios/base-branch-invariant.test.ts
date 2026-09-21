import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Task } from "@/shared/task";
import { runGit } from "../../helpers/git-fixtures";
import {
  acceptPlanViaAPI,
  createTaskViaAPI,
  getCurrentBranch,
  setupTestServer,
  teardownTestServer,
  waitForPlanReady,
  waitForTaskStatus,
  type TestServerContext,
} from "./helpers";

function createPlanModeMockResponses(): string[] {
  return [
    "Planning... <promise>PLAN_READY</promise>",
    "Working on iteration 1...",
    "Done! <promise>COMPLETE</promise>",
  ];
}

describe("Base Branch Invariant - Plan Mode", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await setupTestServer({
      mockResponses: createPlanModeMockResponses(),
      withPlanningDir: true,
    });
  });

  afterAll(async () => {
    await teardownTestServer(ctx);
  });

  test("originalBranch remains constant after plan acceptance", async () => {
    const originalBranch = await getCurrentBranch(ctx.workDir);
    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Create a plan and execute it",
      planMode: true,
      autoAcceptPlan: false,
    });

    expect(status).toBe(201);
    const task = body as Task;
    const planningTask = await waitForTaskStatus(
      ctx.baseUrl,
      task.config.id,
      "planning",
    );
    expect(planningTask.state.git?.originalBranch).toBe(originalBranch);
    expect(await getCurrentBranch(ctx.workDir)).toBe(originalBranch);

    await waitForPlanReady(ctx.baseUrl, task.config.id);
    expect((await acceptPlanViaAPI(ctx.baseUrl, task.config.id)).status).toBe(200);

    const completedTask = await waitForTaskStatus(
      ctx.baseUrl,
      task.config.id,
      "completed",
    );
    expect(completedTask.state.git?.originalBranch).toBe(originalBranch);
    expect(completedTask.state.git?.workingBranch).not.toBe(originalBranch);

    await fetch(`${ctx.baseUrl}/api/tasks/${task.config.id}/discard`, {
      method: "POST",
    });
  });
});

describe("Default Base Branch - Fixture Discovery", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await setupTestServer({
      mockResponses: [
        "Working...",
        "Done! <promise>COMPLETE</promise>",
        "Working...",
        "Done! <promise>COMPLETE</promise>",
      ],
      withPlanningDir: true,
    });
  });

  afterAll(async () => {
    await teardownTestServer(ctx);
  });

  test("task keeps the repository default branch while checkout is on a feature branch", async () => {
    await runGit(ctx.workDir, ["checkout", "-b", "feature/some-work"]);

    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Do some work",
      planMode: false,
      baseBranch: ctx.defaultBranch,
    });

    expect(status).toBe(201);
    const task = body as Task;
    expect(task.config.baseBranch).toBe(ctx.defaultBranch);

    const completedTask = await waitForTaskStatus(
      ctx.baseUrl,
      task.config.id,
      "completed",
    );
    expect(completedTask.state.git?.originalBranch).toBe(ctx.defaultBranch);

    await fetch(`${ctx.baseUrl}/api/tasks/${task.config.id}/discard`, {
      method: "POST",
    });
  });

  test("task created with explicit baseBranch uses that branch", async () => {
    await runGit(ctx.workDir, ["checkout", ctx.defaultBranch]);
    await runGit(ctx.workDir, ["checkout", "-b", "develop"]);
    await runGit(ctx.workDir, ["checkout", ctx.defaultBranch]);

    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Do some work on develop",
      baseBranch: "develop",
      planMode: false,
    });

    expect(status).toBe(201);
    const task = body as Task;
    expect(task.config.baseBranch).toBe("develop");

    const completedTask = await waitForTaskStatus(
      ctx.baseUrl,
      task.config.id,
      "completed",
    );
    expect(completedTask.state.git?.originalBranch).toBe("develop");

    await fetch(`${ctx.baseUrl}/api/tasks/${task.config.id}/discard`, {
      method: "POST",
    });
  });
});
