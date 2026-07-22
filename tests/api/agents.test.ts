/**
 * API integration tests for scheduled agents.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { agentScheduler } from "../../src/core/agent-scheduler";
import { backendManager } from "../../src/core/backend-manager";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { listAgentRuns, loadAgent, saveAgent, saveAgentRun } from "../../src/persistence/agents";
import { listTasks } from "../../src/persistence/tasks";
import type { AgentRun } from "@/shared/agent";
import { agentEventEmitter } from "../../src/core/event-emitter";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { MockAcpBackend, defaultTestModel } from "../mocks/mock-backend";
import { seedTestOwnerUser } from "../setup";

const testModel = { providerID: "test-provider", modelID: "test-model", variant: "" };

describe("Agents API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let workspaceId: string;
  let mockBackend: MockAcpBackend;
  const generatedCode = `export default async function run(ctx) {
  ctx.stdout.write("generated from temporary file\\n");
}`;
  const generatedSourcePaths: string[] = [];
  let writeGenerationSource = true;

  async function getOrCreateWorkspace(directory: string): Promise<string> {
    const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Agent Test Workspace",
        directory,
        serverSettings: { agent: { provider: "opencode", transport: "stdio" } },
      }),
    });
    const data = await createResponse.json();
    if (createResponse.status === 409 && data.existingWorkspace) {
      return data.existingWorkspace.id as string;
    }
    if (createResponse.ok && data.id) {
      return data.id as string;
    }
    throw new Error(`Failed to create workspace: ${JSON.stringify(data)}`);
  }

  async function waitForRunTerminal(runId: string, timeoutMs = 5000): Promise<AgentRun> {
    const terminalStatuses = new Set(["completed", "failed", "interrupted", "skipped", "cancelled"]);
    const start = Date.now();
    let lastStatus = "unknown";
    while (Date.now() - start < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/agent-runs/${runId}`);
      if (response.ok) {
        const run = await response.json() as AgentRun;
        lastStatus = run.status;
        if (terminalStatuses.has(run.status)) {
          return run;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Agent run ${runId} did not complete. Last status: ${lastStatus}`);
  }

  async function waitForChatToBeRemoved(name: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/chats`);
      expect(response.ok).toBe(true);
      const chats = await response.json() as Array<{ config?: { name?: string } }>;
      if (!chats.some((chat) => chat.config?.name === name)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Chat ${name} was not removed within ${timeoutMs}ms`);
  }

  async function createAgent(name = "Scheduled build fixer", code?: string) {
    const response = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        workspaceId,
        prompt: "Check the workspace and report status",
        ...(code ? { code } : {}),
        model: testModel,
        useWorktree: false,
        schedule: {
          startAtLocal: "2030-01-01T09:00",
          timezone: "UTC",
          interval: {
            value: 1,
            unit: "hours",
          },
        },
        enabled: true,
      }),
    });
    expect(response.status).toBe(201);
    return await response.json() as Awaited<ReturnType<typeof loadAgent>>;
  }

  beforeAll(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-api-agents-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "clanky-api-agents-test-work-"));
    closeDatabase();
    process.env["CLANKY_DATA_DIR"] = testDataDir;
    await initializeDatabase();
    seedTestOwnerUser();

    await Bun.$`git init ${testWorkDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${testWorkDir}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Initial commit"`.quiet();

    mockBackend = new MockAcpBackend({
      responses: ["```typescript\nexport default async function run(ctx) {\n  ctx.stdout.write(\"Agent run completed\");"],
      models: [defaultTestModel],
      onPrompt: async (prompt, _directory) => {
        const promptText = prompt.parts
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const marker = "Write only raw TypeScript source to this exact absolute file path:\n---\n";
        const markerStart = promptText.indexOf(marker);
        if (markerStart < 0) {
          return;
        }
        const pathStart = markerStart + marker.length;
        const pathEnd = promptText.indexOf("\n---", pathStart);
        if (pathEnd < 0) {
          return;
        }
        const outputPath = promptText.slice(pathStart, pathEnd).trim();
        generatedSourcePaths.push(outputPath);
        if (writeGenerationSource) {
          await Bun.write(outputPath, generatedCode);
        }
      },
    });
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
    workspaceId = await getOrCreateWorkspace(testWorkDir);
  });

  afterAll(async () => {
    server.stop();
    backendManager.resetForTesting();
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(testDataDir, { recursive: true, force: true });
    await rm(testWorkDir, { recursive: true, force: true });
  });

  test("creates an agent and run now executes without creating tasks or visible chats", async () => {
    const agent = await createAgent();
    expect(agent?.config.mode).toBe("agent");

    const runResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(runResponse.status).toBe(202);
    const startedRun = await runResponse.json() as AgentRun & { taskId?: string };
    expect(startedRun.taskId).toBeUndefined();
    expect(startedRun.status).toBe("scheduled");

    const completedRun = await waitForRunTerminal(startedRun.id);
    expect(completedRun.status).toBe("completed");
    expect(completedRun.chatId).toBeTruthy();
    expect(completedRun.messages.some((message) => message.content.includes("Agent run completed"))).toBe(true);

    const tasks = await listTasks();
    expect(tasks).toHaveLength(0);

    const chatsResponse = await fetch(`${baseUrl}/api/chats`);
    expect(chatsResponse.status).toBe(200);
    const chats = await chatsResponse.json() as unknown[];
    expect(chats).toHaveLength(0);
  });

  test("runs saved deterministic code and persists program stdout and stderr", async () => {
    const agent = await createAgent(
      "Deterministic output agent",
      `export default async function run(ctx) {
  ctx.stdout.write("program stdout\\n");
  ctx.stderr.write("program stderr\\n");
  await ctx.workspace.exec("sh", ["-c", "printf 'command stdout'; printf 'command stderr' >&2"]);
}`,
    );
    expect(agent?.config.code).toContain("program stdout");

    const runResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(runResponse.status).toBe(202);
    const startedRun = await runResponse.json() as AgentRun;
    const completedRun = await waitForRunTerminal(startedRun.id);

    expect(completedRun.status).toBe("completed");
    expect(completedRun.configSnapshot.code).toContain("program stdout");
    // Only explicit ctx.stdout.write/ctx.stderr.write calls produce visible output.
    // workspace.exec output is returned to the program but NOT appended to logs.
    expect(completedRun.logs.filter((entry) => entry.details?.["stream"] === "stdout").map((entry) => entry.message).join(""))
      .toContain("program stdout");
    expect(completedRun.logs.filter((entry) => entry.details?.["stream"] === "stderr").map((entry) => entry.message).join(""))
      .toContain("program stderr");
    // Command output must NOT appear in logs.
    expect(completedRun.logs.every((entry) => !entry.message.includes("command stdout"))).toBe(true);
    expect(completedRun.logs.every((entry) => !entry.message.includes("command stderr"))).toBe(true);
  });

  test("generates an editable draft from the temporary file without persisting it", async () => {
    const agent = await createAgent("Generation draft agent");
    const previousCode = "export default async function run(ctx) {}";
    const response = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Use the current editor instructions",
        comments: "Add explicit output handling",
        previousCode,
        workspaceId,
        model: testModel,
      }),
    });

    expect(response.status).toBe(200);
    const generated = await response.json() as { code: string; diagnostics: Array<{ message: string }> };
    expect(generated.code).toContain("generated from temporary file");
    expect(generated.code).not.toContain("Agent run completed");
    expect(generated.diagnostics).toHaveLength(0);

    const generationPrompt = mockBackend.getSentPrompts()
      .at(-1)
      ?.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
    expect(generationPrompt).toContain("Add explicit output handling");
    expect(generationPrompt).toContain("Use the current editor instructions");
    expect(generationPrompt).toContain(previousCode);
    expect((await loadAgent(agent!.config.id))?.config.code).toBeUndefined();
    expect(generatedSourcePaths.at(-1)).toBeTruthy();
    expect(await Bun.file(generatedSourcePaths.at(-1)!).exists()).toBe(false);
  });

  test("generates an editable draft before an agent is saved", async () => {
    const response = await fetch(`${baseUrl}/api/agents/code/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Unsaved generation draft",
        prompt: "Generate code from the current unsaved form",
        comments: "Write useful output for the test panel",
        previousCode: "",
        workspaceId,
        model: testModel,
      }),
    });

    expect(response.status).toBe(200);
    const generated = await response.json() as { code: string; diagnostics: Array<{ message: string }> };
    expect(generated.code).toContain("generated from temporary file");
    expect(generated.diagnostics).toHaveLength(0);
  });

  test("keeps the code generation response alive while the provider is pending", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    mockBackend.setResponseGate(() => providerGate);

    try {
      const response = await fetch(`${baseUrl}/api/agents/code/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Pending generation draft",
          prompt: "Generate code while the provider is still working",
          comments: "",
          previousCode: "",
          workspaceId,
          model: testModel,
        }),
      });

      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeTruthy();
      const firstChunk = await reader!.read();
      expect(new TextDecoder().decode(firstChunk.value)).toContain("\n");

      releaseProvider();
      let body = new TextDecoder().decode(firstChunk.value);
      while (true) {
        const chunk = await reader!.read();
        if (chunk.value) {
          body += new TextDecoder().decode(chunk.value);
        }
        if (chunk.done) {
          break;
        }
      }

      const generated = JSON.parse(body.trim()) as { code: string };
      expect(generated.code).toContain("generated from temporary file");
    } finally {
      releaseProvider();
      mockBackend.setResponseGate();
    }
  });

  test("waits for the provider to finish before returning the file draft", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    mockBackend.setResponseGate(() => providerGate);

    try {
      const response = await fetch(`${baseUrl}/api/agents/code/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Streaming file generation draft",
          prompt: "Generate code and write it to the temporary source file",
          comments: "",
          previousCode: "",
          workspaceId,
          model: testModel,
        }),
      });

      expect(response.status).toBe(200);
      releaseProvider();
      const generated = await response.json() as { code: string };
      expect(generated.code).toContain("generated from temporary file");
    } finally {
      releaseProvider();
      mockBackend.setResponseGate();
    }
  });

  test("keeps generation alive past the HTTP idle timeout", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    writeGenerationSource = false;
    mockBackend.setResponseGate(() => providerGate);

    // Deliberately cross Bun's default idle timeout to prove this request has
    // an explicit unlimited timeout rather than relying only on heartbeats.
    const releaseTimer = setTimeout(releaseProvider, 11_000);
    try {
      const response = await fetch(`${baseUrl}/api/agents/code/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Idle-timeout generation draft",
          prompt: "Wait for the provider before generating code",
          comments: "",
          previousCode: "",
          workspaceId,
          model: testModel,
        }),
      });

      expect(response.status).toBe(200);
      const generated = await response.json() as { error?: string; message?: string };
      expect(generated.error).toBe("agent_code_generation_failed");
      expect(generated.message).toContain("non-empty source file");
    } finally {
      clearTimeout(releaseTimer);
      releaseProvider();
      writeGenerationSource = true;
      mockBackend.setResponseGate();
    }
  }, { timeout: 20_000 });

  test("cancels pending code generation when the client disconnects", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const controller = new AbortController();
    const generationName = "Cancellable generation draft";
    mockBackend.setResponseGate(() => providerGate);

    try {
      const response = await fetch(`${baseUrl}/api/agents/code/generate`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: generationName,
          prompt: "Generate code until the client disconnects",
          comments: "",
          previousCode: "",
          workspaceId,
          model: testModel,
        }),
      });

      const reader = response.body?.getReader();
      expect(reader).toBeTruthy();
      await reader!.read();
      controller.abort();
      await expect(reader!.read()).rejects.toThrow();
      releaseProvider();
      await waitForChatToBeRemoved(`Generate code: ${generationName}`);
    } finally {
      controller.abort();
      releaseProvider();
      mockBackend.setResponseGate();
    }
  });

  test("tests unsaved deterministic code and returns program stdout and stderr without persisting a run", async () => {
    const beforeAgents = await fetch(`${baseUrl}/api/agents`).then((response) => response.json()) as unknown[];
    const response = await fetch(`${baseUrl}/api/agents/code/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Unsaved test code",
        prompt: "Run the current draft",
        code: `export default async function run(ctx) {
  ctx.stdout.write("test program stdout\\n");
  ctx.stderr.write("test program stderr\\n");
  await ctx.workspace.exec("sh", ["-c", "printf 'test command stdout'; printf 'test command stderr' >&2"]);
}`,
        workspaceId,
        model: testModel,
        useWorktree: false,
      }),
    });

    expect(response.status).toBe(200);
    const result = await response.json() as {
      status: string;
      logs: Array<{ message: string; details?: Record<string, unknown> }>;
      diagnostics: unknown[];
    };
    expect(result.status).toBe("completed");
    expect(result.diagnostics).toHaveLength(0);
    // Only explicit ctx.stdout.write/ctx.stderr.write produce visible logs.
    expect(result.logs.some((entry) => entry.message.includes("test program stdout"))).toBe(true);
    expect(result.logs.some((entry) => entry.message.includes("test program stderr"))).toBe(true);
    // workspace.exec output is returned to the program but NOT in visible logs.
    expect(result.logs.every((entry) => !entry.message.includes("test command stdout"))).toBe(true);
    expect(result.logs.every((entry) => !entry.message.includes("test command stderr"))).toBe(true);

    const afterAgents = await fetch(`${baseUrl}/api/agents`).then((response) => response.json()) as unknown[];
    expect(afterAgents).toHaveLength(beforeAgents.length);
  });

  test("streams unsaved deterministic code output before the terminal result", async () => {
    const testRunId = crypto.randomUUID();
    const realtimeEvents: Array<{ agentRunId: string; userId?: string; message: string }> = [];
    const unsubscribe = agentEventEmitter.subscribe((event, context) => {
      if (event.type === "agent.run.log" && event.agentRunId === testRunId) {
        realtimeEvents.push({
          agentRunId: event.agentRunId,
          userId: context.userId,
          message: event.log.message,
        });
      }
    });
    try {
      const response = await fetch(`${baseUrl}/api/agents/code/test/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Streaming test code",
          prompt: "Run the current draft",
          code: `export default async function run(ctx) {
  ctx.stdout.write("streamed program stdout\\n");
  await ctx.workspace.exec("sh", ["-c", "printf 'streamed command stdout'; printf 'streamed command stderr' >&2"]);
  ctx.stderr.write("streamed program stderr\\n");
}`,
          workspaceId,
          model: testModel,
          useWorktree: false,
          testRunId,
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/x-ndjson");
      const events = (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as {
          type: "log" | "result";
          log?: { message: string; details?: Record<string, unknown> };
          result?: { status: string; logs: Array<{ message: string }> };
        });
      const resultIndex = events.findIndex((event) => event.type === "result");
      expect(resultIndex).toBe(events.length - 1);
      expect(events[resultIndex]?.result?.status).toBe("completed");
      const logEvents = events.slice(0, resultIndex);
      // Only explicit ctx.stdout/stderr.write calls produce log events.
      expect(logEvents.some((event) => event.log?.message.includes("streamed program stdout"))).toBe(true);
      expect(logEvents.some((event) => event.log?.message.includes("streamed program stderr"))).toBe(true);
      // workspace.exec output is not in visible logs.
      expect(logEvents.every((event) => !event.log?.message.includes("streamed command stdout"))).toBe(true);
      expect(logEvents.every((event) => !event.log?.message.includes("streamed command stderr"))).toBe(true);
      expect(realtimeEvents.map((event) => event.message)).toEqual(expect.arrayContaining([
        "streamed program stdout\n",
        "streamed program stderr\n",
      ]));
      expect(realtimeEvents.every((event) => event.userId === "admin")).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  test("keeps a silent deterministic test stream alive past the HTTP idle timeout", async () => {
    const response = await fetch(`${baseUrl}/api/agents/code/test/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Long-running streaming test code",
        prompt: "Run the long-running draft",
        code: `export default async function run(ctx) {
  ctx.stdout.write("long-running stdout\\n");
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  ctx.stderr.write("long-running stderr\\n");
}`,
        workspaceId,
        model: testModel,
        useWorktree: false,
      }),
    });

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let buffer = "";
    let blankLineCount = 0;
    let terminalResult: { status: string; logs: Array<{ message: string }> } | undefined;
    const logMessages: string[] = [];

    while (!terminalResult) {
      const { done, value } = await reader!.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) {
          blankLineCount += 1;
          continue;
        }
        const event = JSON.parse(line) as {
          type: "log" | "result";
          log?: { message: string };
          result?: { status: string; logs: Array<{ message: string }> };
        };
        if (event.type === "log" && event.log) {
          logMessages.push(event.log.message);
        }
        if (event.type === "result") {
          terminalResult = event.result;
        }
      }
    }

    expect(terminalResult?.status).toBe("completed");
    expect(blankLineCount).toBeGreaterThanOrEqual(3);
    expect(logMessages.some((message) => message.includes("long-running stdout"))).toBe(true);
    expect(logMessages.some((message) => message.includes("long-running stderr"))).toBe(true);
    expect(terminalResult?.logs.some((entry) => entry.message.includes("long-running stdout"))).toBe(true);
    expect(terminalResult?.logs.some((entry) => entry.message.includes("long-running stderr"))).toBe(true);
  });

  test("aborts a streaming deterministic code test and cleans up its temporary chat", async () => {
    const testName = "Cancellable streaming test code";
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/agents/code/test/stream`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: testName,
        prompt: "Run the cancellable draft",
        code: `export default async function run(ctx) {
  ctx.stdout.write("before cancellation\\n");
  while (!ctx.signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  ctx.signal.throwIfAborted();
}`,
        workspaceId,
        model: testModel,
        useWorktree: false,
      }),
    });

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();

    // Keep reading until we see "before cancellation" (runner adds startup latency).
    let accumulated = "";
    while (!accumulated.includes("before cancellation")) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      accumulated += decoder.decode(chunk.value);
    }
    expect(accumulated).toContain("before cancellation");

    controller.abort();
    await expect(reader!.read()).rejects.toThrow();

    const start = Date.now();
    let remainingChats: unknown[] = [];
    while (Date.now() - start < 5000) {
      const chatsResponse = await fetch(`${baseUrl}/api/chats`);
      expect(chatsResponse.ok).toBe(true);
      remainingChats = await chatsResponse.json() as unknown[];
      if (!remainingChats.some((chat) => (
        typeof chat === "object"
        && chat !== null
        && "config" in chat
        && typeof chat.config === "object"
        && chat.config !== null
        && "name" in chat.config
        && chat.config.name === `Test code: ${testName}`
      ))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(remainingChats.some((chat) => (
      typeof chat === "object"
      && chat !== null
      && "config" in chat
      && typeof chat.config === "object"
      && chat.config !== null
      && "name" in chat.config
      && chat.config.name === `Test code: ${testName}`
    ))).toBe(false);
  });

  test("tests large unsaved deterministic code without a module URL length failure", async () => {
    const code = `export default async function run(ctx) {
  ctx.stdout.write("large code stdout\\n");
}
// ${"x".repeat(100_000)}`;
    const response = await fetch(`${baseUrl}/api/agents/code/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Large unsaved test code",
        prompt: "Run the large draft",
        code,
        workspaceId,
        model: testModel,
        useWorktree: false,
      }),
    });

    expect(response.status).toBe(200);
    const result = await response.json() as {
      status: string;
      logs: Array<{ message: string }>;
      diagnostics: unknown[];
    };
    expect(result.status).toBe("completed");
    expect(result.diagnostics).toHaveLength(0);
    expect(result.logs.some((entry) => entry.message.includes("large code stdout"))).toBe(true);
  });

  test("rejects invalid deterministic code before persisting an agent", async () => {
    const response = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid deterministic agent",
        workspaceId,
        prompt: "Check the workspace and report status",
        code: "const invalid = ;",
        model: testModel,
        useWorktree: false,
        schedule: {
          startAtLocal: "2030-01-01T09:00",
          timezone: "UTC",
          interval: {
            value: 1,
            unit: "hours",
          },
        },
        enabled: true,
      }),
    });

    expect(response.status).toBe(400);
    expect((await response.json() as { error?: string }).error).toBe("agent_code_invalid");
  });

  test("rejects Node-incompatible TypeScript and ignores fake exports in comments", async () => {
    const response = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Node-incompatible deterministic agent",
        workspaceId,
        prompt: "Check the workspace and report status",
        code: `// export default function run(ctx) {}
enum Result {
  Ok,
}
const result = Result.Ok;
export default async function run(ctx) {
  void result;
}`,
        model: testModel,
        useWorktree: false,
        schedule: {
          startAtLocal: "2030-01-01T09:00",
          timezone: "UTC",
          interval: {
            value: 1,
            unit: "hours",
          },
        },
        enabled: true,
      }),
    });

    expect(response.status).toBe(400);
    expect((await response.json() as { error?: string }).error).toBe("agent_code_invalid");
  });

  test("scheduler records skipped run when previous run is still active", async () => {
    const agent = await createAgent("Skip overlap agent");
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    const activeRun: AgentRun = {
      id: crypto.randomUUID(),
      agentId: agent!.config.id,
      status: "running",
      trigger: "schedule",
      scheduledFor: dueAt,
      startedAt: dueAt,
      messages: [],
      logs: [],
      toolCalls: [],
      pendingPermissionRequests: [],
      configSnapshot: {
        name: agent!.config.name,
        workspaceId: agent!.config.workspaceId,
        directory: agent!.config.directory,
        prompt: agent!.config.prompt,
        model: agent!.config.model,
        baseBranch: agent!.config.baseBranch,
        useWorktree: agent!.config.useWorktree,
        schedule: agent!.config.schedule,
      },
      createdAt: dueAt,
      updatedAt: dueAt,
    };
    await saveAgentRun(activeRun);
    await saveAgent({
      config: {
        ...agent!.config,
        schedule: {
          ...agent!.config.schedule,
          nextRunAt: dueAt,
        },
      },
      state: {
        ...agent!.state,
        status: "running",
        activeRunId: activeRun.id,
        nextRunAt: dueAt,
      },
    });

    await agentScheduler.tick(new Date());

    const runs = await listAgentRuns(agent!.config.id, { limit: 10 });
    const skipped = runs.find((run) => run.status === "skipped");
    expect(skipped?.skipReason).toBe("Previous agent run is still active");
    const updatedAgent = await loadAgent(agent!.config.id);
    expect(updatedAgent?.state.lastSkippedAt).toBeTruthy();
    expect(updatedAgent?.state.nextRunAt).not.toBe(dueAt);
  });

  test("paused agents do not run on schedule but can run manually and resume", async () => {
    const agent = await createAgent("Pausable agent");
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    await saveAgent({
      config: {
        ...agent!.config,
        schedule: {
          ...agent!.config.schedule,
          nextRunAt: dueAt,
        },
      },
      state: {
        ...agent!.state,
        status: "enabled",
        nextRunAt: dueAt,
      },
    });

    const pauseResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(pauseResponse.status).toBe(200);
    const pausedAgent = await pauseResponse.json() as NonNullable<Awaited<ReturnType<typeof loadAgent>>>;
    expect(pausedAgent.config.enabled).toBe(false);
    expect(pausedAgent.state.status).toBe("paused");

    await agentScheduler.tick(new Date());
    expect(await listAgentRuns(agent!.config.id, { limit: 10 })).toHaveLength(0);

    const runResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(runResponse.status).toBe(202);
    const manualRun = await runResponse.json() as AgentRun;
    expect(manualRun.trigger).toBe("manual");
    const completedRun = await waitForRunTerminal(manualRun.id);
    expect(completedRun.status).toBe("completed");

    const resumeResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resumeResponse.status).toBe(200);
    const resumedAgent = await resumeResponse.json() as NonNullable<Awaited<ReturnType<typeof loadAgent>>>;
    expect(resumedAgent.config.enabled).toBe(true);
    expect(resumedAgent.state.status).toBe("enabled");
    expect(resumedAgent.state.nextRunAt).toBeTruthy();
  });

  test("rejects invalid agent schedule timezone", async () => {
    const response = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid timezone agent",
        workspaceId,
        prompt: "Check the workspace and report status",
        model: testModel,
        useWorktree: false,
        schedule: {
          startAtLocal: "2030-01-01T09:00",
          timezone: "Not/A_Timezone",
          interval: {
            value: 1,
            unit: "hours",
          },
        },
        enabled: true,
      }),
    });

    expect(response.status).toBe(400);
  });

  test("purges large run histories in batches", async () => {
    const agent = await createAgent("Large purge agent");
    const now = new Date("2026-01-01T00:00:00Z").toISOString();
    const runIds: string[] = [];
    for (let index = 0; index < 1005; index += 1) {
      const id = crypto.randomUUID();
      runIds.push(id);
      await saveAgentRun({
        id,
        agentId: agent!.config.id,
        status: "completed",
        trigger: "manual",
        scheduledFor: now,
        startedAt: now,
        completedAt: now,
        messages: [],
        logs: [],
        toolCalls: [],
        pendingPermissionRequests: [],
        configSnapshot: {
          name: agent!.config.name,
          workspaceId: agent!.config.workspaceId,
          directory: agent!.config.directory,
          prompt: agent!.config.prompt,
          model: agent!.config.model,
          baseBranch: agent!.config.baseBranch,
          useWorktree: agent!.config.useWorktree,
          schedule: agent!.config.schedule,
        },
        createdAt: now,
        updatedAt: now,
      });
    }

    const response = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/runs`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        includeCompleted: true,
        includeFailed: false,
        includeSkipped: false,
        includeInterrupted: false,
        includeCancelled: false,
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json() as { deletedRunIds: string[] };
    expect(new Set(data.deletedRunIds)).toEqual(new Set(runIds));
    expect(await listAgentRuns(agent!.config.id, { limit: 10 })).toHaveLength(0);
  });
});
