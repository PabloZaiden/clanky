/**
 * Integration coverage for prompt intent, execution policy, and session recovery.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createTaskViaAPI,
  discardTaskViaAPI,
  manualCompleteTaskViaAPI,
  pushTaskViaAPI,
  sendFollowUpViaAPI,
  setupTestServer,
  teardownTestServer,
  waitForTaskStatus,
  type TestServerContext,
} from "./helpers";
import type { Task } from "@/shared/task";

describe("Task prompt flow", () => {
  let ctx: TestServerContext;

  beforeEach(async () => {
    ctx = await setupTestServer({ withPlanningDir: true });
  });

  afterEach(async () => {
    await teardownTestServer(ctx);
  });

  test("sends an active user injection as one turn without automatic continuation", async () => {
    ctx.mockBackend.reset([
      "The original turn was interrupted.",
      "Continue the original work.",
      "The requested change is complete. <promise>COMPLETE</promise>",
    ]);
    const promptStarted = ctx.mockBackend.holdNextPrompt();

    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Implement the original feature",
      planMode: false,
    });
    expect(status).toBe(201);
    const task = body as Task;

    await promptStarted;
    const response = await fetch(`${ctx.baseUrl}/api/tasks/${task.config.id}/pending`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Prioritize the edge case I just described.",
        model: null,
        attachments: [],
      }),
    });
    expect(response.status).toBe(200);

    ctx.mockBackend.releaseHeldPrompt();
    const stoppedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "stopped");

    expect(stoppedTask.state.status).toBe("stopped");
    expect(stoppedTask.state.currentIteration).toBe(2);
    expect(stoppedTask.state.recentIterations[1]?.outcome).toBe("continue");

    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  });

  test("keeps a recoverable session for terminal follow-ups without marker semantics", async () => {
    ctx.mockBackend.reset([
      "Initial work complete. <promise>COMPLETE</promise>",
      "I will continue with the requested follow-up.",
    ]);

    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Implement the original feature",
      planMode: false,
    });
    expect(status).toBe(201);
    const task = body as Task;

    const initialTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
    const initialSessionId = initialTask.state.session?.id;
    if (!initialSessionId) {
      throw new Error("Initial task session was not persisted");
    }

    const followUp = await sendFollowUpViaAPI(
      ctx.baseUrl,
      task.config.id,
      "Please continue from the current implementation.",
    );
    expect(followUp.status).toBe(200);
    const stoppedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "stopped");

    expect(stoppedTask.state.session?.id).toBe(initialSessionId);
    expect(stoppedTask.state.status).toBe("stopped");
    expect(stoppedTask.state.currentIteration).toBe(2);
    expect(stoppedTask.state.recentIterations[1]?.outcome).toBe("continue");

    const manualComplete = await manualCompleteTaskViaAPI(ctx.baseUrl, task.config.id);
    expect(manualComplete.status).toBe(200);
    expect(manualComplete.body.success).toBe(true);
    await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");

    const push = await pushTaskViaAPI(ctx.baseUrl, task.config.id);
    expect(push.status).toBe(200);
    await waitForTaskStatus(ctx.baseUrl, task.config.id, "pushed");

    ctx.mockBackend.setResponses(["The pushed follow-up includes a marker. <promise>COMPLETE</promise>"]);
    const pushedFollowUp = await sendFollowUpViaAPI(
      ctx.baseUrl,
      task.config.id,
      "Please continue after the push.",
    );
    expect(pushedFollowUp.status).toBe(200);
    const pushedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "stopped");
    expect(pushedTask.state.session?.id).toBe(initialSessionId);
    expect(pushedTask.state.status).toBe("stopped");
    expect(pushedTask.state.recentIterations[2]?.outcome).toBe("continue");

    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  });

  test("keeps direct follow-ups after blocked, max-iteration, and error outcomes", async () => {
    const scenarios = [
      {
        response: "The dependency is unavailable. <promise>BLOCKED</promise>",
        terminalStatus: "stopped",
        followUp: "The dependency is available now.",
        maxIterations: undefined,
        maxConsecutiveErrors: undefined,
      },
      {
        response: "Still working.",
        terminalStatus: "max_iterations",
        followUp: "Continue after the iteration limit.",
        maxIterations: 1,
        maxConsecutiveErrors: undefined,
      },
      {
        response: "ERROR:Backend failed",
        terminalStatus: "failed",
        followUp: "Retry after the backend failure.",
        maxIterations: undefined,
        maxConsecutiveErrors: 1,
      },
    ] as const;

    for (const scenario of scenarios) {
      ctx.mockBackend.reset([scenario.response]);
      const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
        directory: ctx.workDir,
        prompt: "Implement the original feature",
        planMode: false,
        maxIterations: scenario.maxIterations,
        maxConsecutiveErrors: scenario.maxConsecutiveErrors,
      });
      expect(status).toBe(201);
      const task = body as Task;

      const terminalTask = await waitForTaskStatus(
        ctx.baseUrl,
        task.config.id,
        scenario.terminalStatus,
      );
      expect(terminalTask.state.status).toBe(scenario.terminalStatus);

      ctx.mockBackend.setResponses(["The follow-up is complete. <promise>COMPLETE</promise>"]);
      const followUp = await sendFollowUpViaAPI(ctx.baseUrl, task.config.id, scenario.followUp);
      expect(followUp.status).toBe(200);
      const stoppedFollowUpTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "stopped");
      expect(stoppedFollowUpTask.state.status).toBe("stopped");
      expect(stoppedFollowUpTask.state.recentIterations.at(-1)?.outcome).toBe("continue");

      await discardTaskViaAPI(ctx.baseUrl, task.config.id);
    }
  });

  test("adds a recovery bootstrap without resuming the task loop", async () => {
    ctx.mockBackend.reset([
      "Initial work complete. <promise>COMPLETE</promise>",
      "The recovered follow-up is complete. <promise>COMPLETE</promise>",
    ]);

    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Implement the original feature",
      planMode: false,
    });
    expect(status).toBe(201);
    const task = body as Task;

    const initialTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
    const initialSessionId = initialTask.state.session?.id;
    expect(initialSessionId).toBeDefined();
    await ctx.mockBackend.deleteSession(initialSessionId!);

    const followUp = await sendFollowUpViaAPI(
      ctx.baseUrl,
      task.config.id,
      "Recover the task and continue the implementation.",
    );
    expect(followUp.status).toBe(200);
    const stoppedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "stopped");

    expect(stoppedTask.state.session?.id).not.toBe(initialSessionId);
    expect(stoppedTask.state.status).toBe("stopped");
    expect(stoppedTask.state.recentIterations.at(-1)?.outcome).toBe("continue");

    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  });

  test("recreates a session once when it is lost during prompt streaming", async () => {
    ctx.mockBackend.reset([
      "Initial work complete. <promise>COMPLETE</promise>",
      "The recovered follow-up is complete.",
    ]);

    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Implement the original feature",
      planMode: false,
    });
    expect(status).toBe(201);
    const task = body as Task;

    const initialTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
    const initialSessionId = initialTask.state.session?.id;
    expect(initialSessionId).toBeDefined();
    if (!initialSessionId) {
      throw new Error("Initial task session was not persisted");
    }

    ctx.mockBackend.failNextPromptSessionNotFound();
    const followUp = await sendFollowUpViaAPI(
      ctx.baseUrl,
      task.config.id,
      "Recover the task and continue the implementation.",
    );
    expect(followUp.status).toBe(200);

    const stoppedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "stopped");

    expect(stoppedTask.state.session?.id).not.toBe(initialSessionId);
    expect(stoppedTask.state.status).toBe("stopped");
    expect(stoppedTask.state.recentIterations.at(-1)?.outcome).toBe("continue");

    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  });

  test("bounds repeated session-loss retries and persists the failure", async () => {
    ctx.mockBackend.reset(["This response should not be reached."]);
    ctx.mockBackend.failNextPromptSessionNotFound(2);

    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Run a task that loses its session twice",
      planMode: false,
      maxConsecutiveErrors: 1,
    });
    expect(status).toBe(201);
    const task = body as Task;

    const failedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "failed");

    expect(failedTask.state.status).toBe("failed");
    expect(failedTask.state.error).toBeDefined();

    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  });
});
