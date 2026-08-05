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
import type { PromptInput } from "../../../src/backends/types";
import type { Task } from "@/shared/task";
import { pollUntil } from "../../helpers/polling";

function promptText(prompt: PromptInput): string {
  return prompt.parts
    .filter((part): part is Extract<PromptInput["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function waitForSentPrompt(
  ctx: TestServerContext,
  count: number,
  timeoutMs = 5000,
): Promise<Array<{ sessionId: string; prompt: PromptInput }>> {
  return pollUntil(
    () => ctx.mockBackend.getSentPrompts(),
    (prompts) => prompts.length >= count,
    {
      description: `at least ${count} sent prompts`,
      timeoutMs,
      formatLastObserved: (prompts) => `count=${prompts.length}`,
    },
  );
}

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
    ctx.mockBackend.holdNextPrompt();

    const { status, body } = await createTaskViaAPI(ctx.baseUrl, {
      directory: ctx.workDir,
      prompt: "Implement the original feature",
      planMode: false,
    });
    expect(status).toBe(201);
    const task = body as Task;

    await waitForSentPrompt(ctx, 1);
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
    const prompts = await waitForSentPrompt(ctx, 2);

    expect(promptText(prompts[1]!.prompt)).toBe("Prioritize the edge case I just described.");
    expect(promptText(prompts[0]!.prompt)).toContain("- Original Goal: Implement the original feature");
    expect(prompts[1]!.sessionId).toBe(prompts[0]!.sessionId);
    expect(stoppedTask.state.status).toBe("stopped");
    expect(stoppedTask.state.currentIteration).toBe(2);
    expect(stoppedTask.state.recentIterations[1]?.outcome).toBe("continue");
    expect(stoppedTask.state.messages.filter((message) => message.content.includes("edge case")).length).toBe(1);
    expect(ctx.mockBackend.getSentPrompts()).toHaveLength(2);

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
    const initialPrompts = await waitForSentPrompt(ctx, 1);
    const initialSessionId = initialTask.state.session?.id;
    expect(initialSessionId).toBe(initialPrompts[0]!.sessionId);
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
    const prompts = await waitForSentPrompt(ctx, 2);

    expect(promptText(prompts[1]!.prompt)).toBe("Please continue from the current implementation.");
    expect(prompts[1]!.sessionId).toBe(initialSessionId);
    expect(stoppedTask.state.status).toBe("stopped");
    expect(stoppedTask.state.currentIteration).toBe(2);
    expect(stoppedTask.state.recentIterations[1]?.outcome).toBe("continue");
    expect(stoppedTask.state.messages.filter((message) => message.content.includes("current implementation")).length).toBe(1);
    expect(ctx.mockBackend.getSentPrompts()).toHaveLength(2);

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
    const pushedPrompts = await waitForSentPrompt(ctx, 3);
    expect(promptText(pushedPrompts[2]!.prompt)).toBe("Please continue after the push.");
    expect(pushedPrompts[2]!.sessionId).toBe(initialSessionId);
    expect(pushedTask.state.status).toBe("stopped");
    expect(pushedTask.state.recentIterations[2]?.outcome).toBe("continue");
    expect(ctx.mockBackend.getSentPrompts()).toHaveLength(3);

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
      await waitForSentPrompt(ctx, 1);

      ctx.mockBackend.setResponses(["The follow-up is complete. <promise>COMPLETE</promise>"]);
      const followUp = await sendFollowUpViaAPI(ctx.baseUrl, task.config.id, scenario.followUp);
      expect(followUp.status).toBe(200);

      const stoppedFollowUpTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "stopped");
      const prompts = await waitForSentPrompt(ctx, 2);
      expect(promptText(prompts[1]!.prompt)).toBe(scenario.followUp);
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
    const prompts = await waitForSentPrompt(ctx, 2);

    expect(prompts[1]!.sessionId).not.toBe(initialSessionId);
    expect(promptText(prompts[1]!.prompt)).toContain("This task is continuing in a new AI session");
    expect(promptText(prompts[1]!.prompt)).toContain("Recover the task and continue the implementation.");
    expect(stoppedTask.state.status).toBe("stopped");
    expect(stoppedTask.state.recentIterations.at(-1)?.outcome).toBe("continue");
    expect(stoppedTask.state.messages.filter((message) => message.content.includes("Recover the task")).length).toBe(1);

    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  });
});
