/**
 * Integration coverage for prompt intent, execution policy, and session recovery.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createTaskViaAPI,
  discardTaskViaAPI,
  pushTaskViaAPI,
  sendFollowUpViaAPI,
  setupTestServer,
  teardownTestServer,
  waitForTaskStatus,
  type TestServerContext,
} from "./helpers";
import type { PromptInput } from "../../../src/backends/types";
import type { Task } from "@/shared/task";

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
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const prompts = ctx.mockBackend.getSentPrompts();
    if (prompts.length >= count) {
      return prompts;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected ${count} sent prompts within ${timeoutMs}ms`);
}

describe("Task prompt flow", () => {
  let ctx: TestServerContext;

  beforeEach(async () => {
    ctx = await setupTestServer({ withPlanningDir: true });
  });

  afterEach(async () => {
    await teardownTestServer(ctx);
  });

  test("sends an active user injection directly, then resumes with task context", async () => {
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
    const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
    const prompts = await waitForSentPrompt(ctx, 3);

    expect(promptText(prompts[1]!.prompt)).toBe("Prioritize the edge case I just described.");
    expect(promptText(prompts[0]!.prompt)).toContain("- Original Goal: Implement the original feature");
    expect(promptText(prompts[2]!.prompt)).toContain("- Original Goal: Implement the original feature");
    expect(prompts[1]!.sessionId).toBe(prompts[0]!.sessionId);
    expect(completedTask.state.messages.filter((message) => message.content.includes("edge case")).length).toBe(1);

    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  });

  test("keeps a recoverable session for a terminal follow-up and uses the loop policy", async () => {
    ctx.mockBackend.reset([
      "Initial work complete. <promise>COMPLETE</promise>",
      "I will continue with the requested follow-up.",
      "The follow-up work is complete. <promise>COMPLETE</promise>",
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
    const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
    const prompts = await waitForSentPrompt(ctx, 3);

    expect(promptText(prompts[1]!.prompt)).toBe("Please continue from the current implementation.");
    expect(promptText(prompts[2]!.prompt)).toContain("- Original Goal: Implement the original feature");
    expect(prompts[1]!.sessionId).toBe(initialSessionId);
    expect(prompts[2]!.sessionId).toBe(initialSessionId);
    expect(completedTask.state.currentIteration).toBe(3);
    expect(completedTask.state.messages.filter((message) => message.content.includes("current implementation")).length).toBe(1);

    const push = await pushTaskViaAPI(ctx.baseUrl, task.config.id);
    expect(push.status).toBe(200);
    await waitForTaskStatus(ctx.baseUrl, task.config.id, "pushed");

    ctx.mockBackend.setResponses([
      "I will continue the pushed task.",
      "The pushed follow-up is complete. <promise>COMPLETE</promise>",
    ]);
    const pushedFollowUp = await sendFollowUpViaAPI(
      ctx.baseUrl,
      task.config.id,
      "Please continue after the push.",
    );
    expect(pushedFollowUp.status).toBe(200);
    await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
    const pushedPrompts = await waitForSentPrompt(ctx, 5);
    expect(promptText(pushedPrompts[3]!.prompt)).toBe("Please continue after the push.");
    expect(promptText(pushedPrompts[4]!.prompt)).toContain("- Original Goal: Implement the original feature");
    expect(pushedPrompts[3]!.sessionId).toBe(initialSessionId);
    expect(pushedPrompts[4]!.sessionId).toBe(initialSessionId);

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

      const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
      const prompts = await waitForSentPrompt(ctx, 2);
      expect(promptText(prompts[1]!.prompt)).toBe(scenario.followUp);
      expect(completedTask.state.status).toBe("completed");

      await discardTaskViaAPI(ctx.baseUrl, task.config.id);
    }
  });

  test("adds a recovery bootstrap only when the terminal session no longer exists", async () => {
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
    const completedTask = await waitForTaskStatus(ctx.baseUrl, task.config.id, "completed");
    const prompts = await waitForSentPrompt(ctx, 2);

    expect(prompts[1]!.sessionId).not.toBe(initialSessionId);
    expect(promptText(prompts[1]!.prompt)).toContain("This task is continuing in a new AI session");
    expect(promptText(prompts[1]!.prompt)).toContain("Recover the task and continue the implementation.");
    expect(completedTask.state.messages.filter((message) => message.content.includes("Recover the task")).length).toBe(1);

    await discardTaskViaAPI(ctx.baseUrl, task.config.id);
  });
});
