/**
 * API integration tests for scheduled agents.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { TEST_CODE_HEARTBEAT_INTERVAL_MS } from "../../src/api/agents";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { agentScheduler } from "../../src/core/agent-scheduler";
import { backendManager } from "../../src/core/backend-manager";
import { chatManager } from "../../src/core/chat-manager";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { listAgentRuns, loadAgent, saveAgent, saveAgentRun } from "../../src/persistence/agents";
import { listTasks } from "../../src/persistence/tasks";
import type { AgentRun } from "@/shared/agent";
import { agentEventEmitter } from "../../src/core/event-emitter";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { MockAcpBackend, NeverCompletingMockBackend, defaultTestModel } from "../mocks/mock-backend";
import { fetchTestLocalExecutionHost, seedTestOwnerUser } from "../setup";
import { initializeGitRepository } from "../helpers/git-fixtures";
import { pollUntil } from "../helpers/polling";

const testModel = { providerID: "test-provider", modelID: "test-model", variant: "" };
const TEST_HTTP_IDLE_TIMEOUT_SECONDS = 1;
const TEST_HTTP_IDLE_TIMEOUT_MS = TEST_HTTP_IDLE_TIMEOUT_SECONDS * 1000;
const TEST_IDLE_TIMEOUT_MARGIN_MS = 500;
const TEST_STREAM_SILENCE_MS = Math.max(
  TEST_HTTP_IDLE_TIMEOUT_MS,
  TEST_CODE_HEARTBEAT_INTERVAL_MS,
) + TEST_IDLE_TIMEOUT_MARGIN_MS;

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
  let generationSourceWriter: ((
    outputPath: string,
    promptText: string,
    generationTurn: number,
  ) => Promise<void>) | undefined;
  let generationTurn = 0;

  async function getOrCreateWorkspace(directory: string): Promise<string> {
    const executionHost = await fetchTestLocalExecutionHost(baseUrl);
    const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Agent Test Workspace",
        directory,
        executionHost,
        serverSettings: { agent: { provider: "opencode" } },
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
    const observation = await pollUntil(
      async () => {
        const response = await fetch(`${baseUrl}/api/agent-runs/${runId}`);
        if (!response.ok) {
          return { statusCode: response.status, run: null };
        }
        const run = await response.json() as AgentRun;
        if (!terminalStatuses.has(run.status)) {
          return { statusCode: response.status, run };
        }
        const snapshotResponse = await fetch(`${baseUrl}/api/agent-runs/${runId}/snapshot`);
        expect(snapshotResponse.status).toBe(200);
        const snapshot = await snapshotResponse.json() as {
          transcript: Pick<AgentRun, "messages" | "logs" | "toolCalls">;
        };
        return {
          statusCode: response.status,
          run: {
            ...run,
            messages: snapshot.transcript.messages,
            logs: snapshot.transcript.logs,
            toolCalls: snapshot.transcript.toolCalls,
          },
        };
      },
      (value) => value.run !== null && terminalStatuses.has(value.run.status),
      {
        description: `agent run ${runId} to complete`,
        timeoutMs,
        formatLastObserved: (value) => `HTTP ${value.statusCode}; status=${value.run?.status ?? "unavailable"}`,
      },
    );
    if (observation.run === null) {
      throw new Error(`Agent run ${runId} returned no run after polling`);
    }
    return observation.run;
  }

  async function waitForAgentDraft(agentId: string, expectedCode: string, timeoutMs = 5000): Promise<void> {
    await pollUntil(
      async () => {
        const response = await fetch(`${baseUrl}/api/agents/${agentId}/code/draft`);
        if (!response.ok) {
          return { statusCode: response.status, code: "" };
        }
        const body = await response.json() as { code?: unknown };
        return {
          statusCode: response.status,
          code: typeof body.code === "string" ? body.code : "",
        };
      },
      (value) => value.code === expectedCode,
      {
        description: `agent ${agentId} draft to be restored`,
        timeoutMs,
        formatLastObserved: (value) => `HTTP ${value.statusCode}; code=${value.code}`,
      },
    );
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

    await initializeGitRepository(testWorkDir, { initialCommit: "readme" });

    mockBackend = new MockAcpBackend({
      responses: ["```typescript\nexport default async function run(ctx) {\n  ctx.stdout.write(\"Agent run completed\");"],
      models: [defaultTestModel],
      onPrompt: async (prompt, _directory) => {
        const promptText = prompt.parts
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const markers = [
          "Write only raw TypeScript source to this exact absolute file path:\n---\n",
          "Current source file to repair:\n---\n",
        ];
        const marker = markers.find((candidate) => promptText.includes(candidate));
        const markerStart = marker ? promptText.indexOf(marker) : -1;
        if (markerStart < 0) {
          return;
        }
        const pathStart = markerStart + marker!.length;
        const pathEnd = promptText.indexOf("\n---", pathStart);
        if (pathEnd < 0) {
          return;
        }
        const outputPath = promptText.slice(pathStart, pathEnd).trim();
        generatedSourcePaths.push(outputPath);
        generationTurn += 1;
        if (writeGenerationSource) {
          if (generationSourceWriter) {
            await generationSourceWriter(outputPath, promptText, generationTurn);
          } else {
            await Bun.write(outputPath, generatedCode);
          }
        }
      },
    });
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    server = serveNativeApiRoutes({ idleTimeout: TEST_HTTP_IDLE_TIMEOUT_SECONDS });
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

  test("completes an agent run when its chat stream becomes inactive", async () => {
    backendManager.setBackendForTesting(new NeverCompletingMockBackend({
      models: [defaultTestModel],
    }));
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
    chatManager.setActivityTimeoutForTesting(10);

    try {
      const agent = await createAgent("Inactive agent");
      const runResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(runResponse.status).toBe(202);
      const startedRun = await runResponse.json() as AgentRun;
      const completedRun = await waitForRunTerminal(startedRun.id);

      expect(completedRun.status).toBe("completed");
      expect(completedRun.error).toBeUndefined();
      expect(completedRun.messages).toContainEqual(expect.objectContaining({
        role: "assistant",
        content: "Still working...",
      }));
    } finally {
      chatManager.setActivityTimeoutForTesting(undefined);
      backendManager.setBackendForTesting(mockBackend);
      backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
    }
  });

  test("runs agents directly in directory workspaces and rejects Git options", async () => {
    const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Directory Agent Workspace",
        directory: testWorkDir,
        workspaceType: "directory",
        executionHost: await fetchTestLocalExecutionHost(baseUrl),
        serverSettings: { agent: { provider: "opencode" } },
      }),
    });
    expect(workspaceResponse.status).toBe(201);
    const directoryWorkspace = await workspaceResponse.json() as { id: string };

    const invalidResponse = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid directory agent",
        workspaceId: directoryWorkspace.id,
        prompt: "This should be rejected",
        model: testModel,
        useWorktree: true,
        schedule: {
          startAtLocal: "2030-01-01T09:00",
          timezone: "UTC",
          interval: { value: 1, unit: "hours" },
        },
      }),
    });
    expect(invalidResponse.status).toBe(409);
    expect(await invalidResponse.json()).toMatchObject({
      error: "workspace_git_required",
    });

    const createResponse = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Direct directory agent",
        workspaceId: directoryWorkspace.id,
        prompt: "Run directly in the workspace",
        model: testModel,
        useWorktree: false,
        schedule: {
          startAtLocal: "2030-01-01T09:00",
          timezone: "UTC",
          interval: { value: 1, unit: "hours" },
        },
      }),
    });
    expect(createResponse.status).toBe(201);
    const agent = await createResponse.json() as { config: { id: string; useWorktree: boolean; baseBranch?: string } };
    expect(agent.config.useWorktree).toBe(false);
    expect(agent.config.baseBranch).toBeUndefined();

    const runResponse = await fetch(`${baseUrl}/api/agents/${agent.config.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(runResponse.status).toBe(202);
    const startedRun = await runResponse.json() as AgentRun;
    const completedRun = await waitForRunTerminal(startedRun.id);
    expect(completedRun.status).toBe("completed");
    expect(completedRun.configSnapshot.useWorktree).toBe(false);
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

  test("generates an editable draft in the persistent hidden agent chat", async () => {
    const agent = await createAgent("Generation draft agent");
    const previousCode = "export default async function run(ctx) {}";
    const response = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Use the current editor instructions",
        previousCode,
        workspaceId,
        model: testModel,
      }),
    });

    expect(response.status).toBe(200);
    const generated = await response.json() as {
      code: string;
      diagnostics: Array<{ message: string }>;
      chat: { config: { id: string; scope: string } };
    };
    expect(generated.code).toContain("generated from temporary file");
    expect(generated.code).not.toContain("Agent run completed");
    expect(generated.diagnostics).toHaveLength(0);
    expect(generated.chat.config.scope).toBe("agent");
    const savedAgent = await fetch(`${baseUrl}/api/agents/${agent!.config.id}`).then((result) => result.json()) as {
      config: { generationChatId?: string };
    };
    expect(savedAgent.config.generationChatId).toBe(generated.chat.config.id);

    const generationPrompt = mockBackend.getSentPrompts()
      .at(-1)
      ?.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
    expect(generationPrompt).toContain("Use the current editor instructions");
    expect(generationPrompt).toContain(previousCode);
    expect((await fetch(`${baseUrl}/api/agents/${agent!.config.id}`).then((result) => result.json()) as {
      config: { code?: string };
    }).config.code).toBeUndefined();
    expect(generatedSourcePaths.at(-1)).toBeTruthy();
    expect(await Bun.file(generatedSourcePaths.at(-1)!).exists()).toBe(true);

    const saveResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: generated.code }),
    });
    expect(saveResponse.status).toBe(200);

    const draftResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/draft`);
    expect(draftResponse.status).toBe(200);
    expect((await draftResponse.json() as { code: string }).code).toContain("generated from temporary file");

    const snapshotResponse = await fetch(`${baseUrl}/api/chats/${generated.chat.config.id}/snapshot`);
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json() as {
      transcript: { messages: Array<{ content: string }> };
    };
    expect(snapshot.transcript.messages.some((message) => message.content.includes("Use the current editor instructions"))).toBe(true);
  });

  test("repairs invalid generated code once through the same generation conversation", async () => {
    const invalidCode = `export default function run(ctx) {
  enum Result {
    Ok,
  }
  void Result.Ok;
}`;
    const repairedCode = `export default async function run(ctx) {
  ctx.stdout.write("repaired source\\n");
}`;
    const turns: number[] = [];
    generationTurn = 0;
    generationSourceWriter = async (outputPath, _promptText, generationNumber) => {
      turns.push(generationNumber);
      await Bun.write(outputPath, generationNumber === 1 ? invalidCode : repairedCode);
    };

    try {
      const agent = await createAgent("Repair generation agent");
      const response = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Repair generation agent",
          prompt: "Generate a valid deterministic agent",
          previousCode: "",
          workspaceId,
          model: testModel,
        }),
      });

      expect(response.status).toBe(200);
      const generated = await response.json() as {
        code: string;
        diagnostics: Array<{ message: string }>;
        chat: { config: { id: string } };
      };
      expect(generated.code).toContain("repaired source");
      expect(generated.diagnostics).toHaveLength(0);
      expect(turns).toEqual([1, 2]);

      const snapshotResponse = await fetch(`${baseUrl}/api/chats/${generated.chat.config.id}/snapshot`);
      expect(snapshotResponse.status).toBe(200);
      const snapshot = await snapshotResponse.json() as {
        transcript: { messages: Array<{ role: string }> };
      };
      expect(snapshot.transcript.messages.filter((message) => message.role === "user")).toHaveLength(2);
    } finally {
      generationSourceWriter = undefined;
    }
  });

  test("returns unresolved diagnostics after one failed repair turn", async () => {
    const invalidSources = [
      `export default function run(ctx) {
  enum Result {
    Ok,
  }
  void Result.Ok;
}`,
      `export default function run(ctx) {
  class Example {
    constructor(private readonly value: string) {}
  }
  void Example;
}`,
    ];
    const turns: number[] = [];
    generationTurn = 0;
    generationSourceWriter = async (outputPath, _promptText, generationNumber) => {
      turns.push(generationNumber);
      await Bun.write(outputPath, invalidSources[Math.min(generationNumber - 1, invalidSources.length - 1)]!);
    };

    try {
      const agent = await createAgent("Unresolved repair generation agent");
      const response = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Unresolved repair generation agent",
          prompt: "Generate a deterministic agent",
          previousCode: "",
          workspaceId,
          model: testModel,
        }),
      });

      expect(response.status).toBe(200);
      const generated = await response.json() as {
        diagnostics: Array<{ message: string }>;
      };
      expect(generated.diagnostics.length).toBeGreaterThan(0);
      expect(turns).toEqual([1, 2]);
    } finally {
      generationSourceWriter = undefined;
    }
  });

  test("prepares the hidden generation chat before the initial generation request", async () => {
    const agent = await createAgent("Prepared generation agent");
    const prepareResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        model: testModel,
      }),
    });

    expect(prepareResponse.status).toBe(200);
    const prepared = await prepareResponse.json() as { chatId: string };
    expect(prepared.chatId).toBeTruthy();
    expect(await fetch(`${baseUrl}/api/chats/${prepared.chatId}`).then((response) => response.status)).toBe(200);

    const visibleChats = await fetch(`${baseUrl}/api/chats`).then((response) => response.json()) as Array<{
      config: { id: string };
    }>;
    expect(visibleChats.some((chat) => chat.config.id === prepared.chatId)).toBe(false);

    const generateResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: prepared.chatId,
        generationMode: "initial",
        prompt: "Generate the first version",
        previousCode: "",
        workspaceId,
        model: testModel,
      }),
    });

    expect(generateResponse.status).toBe(200);
    const generated = await generateResponse.json() as {
      chat: { config: { id: string; scope: string } };
    };
    expect(generated.chat.config.id).toBe(prepared.chatId);
    expect(generated.chat.config.scope).toBe("agent");
  });

  test("continues generation follow-ups in the same hidden conversation", async () => {
    const agent = await createAgent("Follow-up generation agent");
    const sourcePathCountBefore = generatedSourcePaths.length;
    const firstResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Create the first version",
        previousCode: "",
        workspaceId,
        model: testModel,
      }),
    });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as {
      code: string;
      chat: { config: { id: string } };
    };

    const followUpResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: first.chat.config.id,
        message: "Change the output wording",
        previousCode: first.code,
        workspaceId,
        model: testModel,
      }),
    });
    expect(followUpResponse.status).toBe(200);
    const followUp = await followUpResponse.json() as {
      code: string;
      chat: { config: { id: string } };
    };
    expect(followUp.chat.config.id).toBe(first.chat.config.id);
    expect(followUp.code).toContain("generated from temporary file");
    expect(generatedSourcePaths).toHaveLength(sourcePathCountBefore + 2);
    expect(generatedSourcePaths.at(-1)).toBe(generatedSourcePaths.at(-2));
    expect(await Bun.file(generatedSourcePaths.at(-1)!).exists()).toBe(true);

    const snapshotResponse = await fetch(`${baseUrl}/api/chats/${first.chat.config.id}/snapshot`);
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json() as {
      transcript: { messages: Array<{ content: string }> };
    };
    expect(snapshot.transcript.messages.some((message) => message.content.includes("Change the output wording"))).toBe(true);
  });

  test("replaces the prior generation conversation when Generate is pressed again", async () => {
    const agent = await createAgent("Reset generation agent");
    const firstResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ previousCode: "", workspaceId, model: testModel }),
    });
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as {
      chat: { config: { id: string } };
    };
    const firstSource = generatedSourcePaths.at(-1)!;
    expect(await Bun.file(firstSource).exists()).toBe(true);

    const secondResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ previousCode: "", workspaceId, model: testModel }),
    });
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json() as {
      chat: { config: { id: string } };
    };
    expect(second.chat.config.id).not.toBe(first.chat.config.id);
    expect(await fetch(`${baseUrl}/api/chats/${first.chat.config.id}`).then((response) => response.status)).toBe(404);
    expect(await Bun.file(firstSource).exists()).toBe(false);
    const savedAgent = await fetch(`${baseUrl}/api/agents/${agent!.config.id}`).then((result) => result.json()) as {
      config: { generationChatId?: string };
    };
    expect(savedAgent.config.generationChatId).toBe(second.chat.config.id);

    const deleteResponse = await fetch(`${baseUrl}/api/agents/${agent!.config.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    expect(await fetch(`${baseUrl}/api/chats/${second.chat.config.id}`).then((response) => response.status)).toBe(404);
    expect(await Bun.file(generatedSourcePaths.at(-1)!).exists()).toBe(false);
  });

  test("rejects generation before an agent is saved", async () => {
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

    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe("agent_required");
  });

  test("keeps the code generation response alive while the provider is pending", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    mockBackend.setResponseGate(() => providerGate);

    try {
      const agent = await createAgent("Pending generation agent");
      const response = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate`, {
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
      const agent = await createAgent("Streaming generation agent");
      const response = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate`, {
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

    // Deliberately cross the configured test idle timeout to prove this request
    // has an explicit unlimited timeout rather than relying only on heartbeats.
    const releaseTimer = setTimeout(
      releaseProvider,
      TEST_HTTP_IDLE_TIMEOUT_MS + TEST_IDLE_TIMEOUT_MARGIN_MS,
    );
    try {
      const agent = await createAgent("Idle timeout generation agent");
      const response = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate`, {
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
    const previousCode = "export default async function run(ctx) {}";
    mockBackend.setResponseGate(() => providerGate);

    try {
      const agent = await createAgent(generationName);
      const response = await fetch(`${baseUrl}/api/agents/${agent!.config.id}/code/generate`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: generationName,
          prompt: "Generate code until the client disconnects",
          comments: "",
          previousCode,
          workspaceId,
          model: testModel,
        }),
      });

      const reader = response.body?.getReader();
      expect(reader).toBeTruthy();
      await reader!.read();
      controller.abort();
      await reader!.read().catch(() => undefined);
      releaseProvider();
      const chatId = response.headers.get("X-Clanky-Generation-Chat-Id");
      expect(chatId).toBeTruthy();
      expect(await fetch(`${baseUrl}/api/chats/${chatId}`).then((result) => result.status)).toBe(200);
      await waitForAgentDraft(agent!.config.id, previousCode);
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
  await new Promise((resolve) => setTimeout(resolve, ${TEST_STREAM_SILENCE_MS}));
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
    expect(blankLineCount).toBeGreaterThanOrEqual(2);
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

    const visibleChatsResponse = await fetch(`${baseUrl}/api/chats`);
    expect(visibleChatsResponse.ok).toBe(true);
    const visibleChats = await visibleChatsResponse.json() as Array<{
      config?: { name?: string };
    }>;
    expect(visibleChats.some((chat) => chat.config?.name === `Test code: ${testName}`)).toBe(false);

    controller.abort();
    await expect(reader!.read()).rejects.toThrow();

    const hasTestChat = (chats: unknown[]): boolean => chats.some((chat) => (
        typeof chat === "object"
        && chat !== null
        && "config" in chat
        && typeof chat.config === "object"
        && chat.config !== null
        && "name" in chat.config
        && chat.config.name === `Test code: ${testName}`
      ));
    const remainingChats = await pollUntil(
      async () => {
        const chatsResponse = await fetch(`${baseUrl}/api/chats`);
        expect(chatsResponse.ok).toBe(true);
        return await chatsResponse.json() as unknown[];
      },
      (chats) => !hasTestChat(chats),
      {
        description: `temporary chat ${testName} to be removed`,
        timeoutMs: 5000,
        formatLastObserved: (chats) => `matchingChats=${hasTestChat(chats) ? "present" : "absent"}, total=${chats.length}`,
      },
    );
    expect(hasTestChat(remainingChats)).toBe(false);
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

  test("loads complete lightweight agent-run transcripts and lazy-loads tool call payloads", async () => {
    const agent = await createAgent("Agent transcript snapshot");
    const runId = crypto.randomUUID();
    const firstTimestamp = Date.parse("2025-03-02T00:00:00.000Z");
    const messages = Array.from({ length: 3 }, (_, index) => ({
      id: `agent-page-message-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `Agent message ${index}`,
      timestamp: new Date(firstTimestamp + index * 1_000).toISOString(),
    }));
    const logs = Array.from({ length: 2 }, (_, index) => ({
      id: `agent-page-log-${index}`,
      level: "info" as const,
      message: `Agent log ${index}`,
      timestamp: new Date(firstTimestamp + (10 + index) * 1_000).toISOString(),
    }));
    const toolCalls = Array.from({ length: 4 }, (_, index) => ({
      id: `agent-page-tool-${index}`,
      name: "Execute",
      input: { command: `printf agent-${index}` },
      output: { content: `agent-large-output-${index}-${"x".repeat(2_000)}` },
      status: "completed" as const,
      timestamp: new Date(firstTimestamp + (20 + index) * 1_000).toISOString(),
    }));
    const configSnapshot = {
      name: agent!.config.name,
      workspaceId: agent!.config.workspaceId,
      directory: agent!.config.directory,
      prompt: agent!.config.prompt,
      model: agent!.config.model,
      baseBranch: agent!.config.baseBranch,
      useWorktree: agent!.config.useWorktree,
      schedule: agent!.config.schedule,
    };
    await saveAgentRun({
      id: runId,
      agentId: agent!.config.id,
      status: "completed",
      trigger: "manual",
      scheduledFor: new Date(firstTimestamp).toISOString(),
      startedAt: new Date(firstTimestamp).toISOString(),
      completedAt: toolCalls.at(-1)!.timestamp,
      messages,
      logs,
      toolCalls,
      pendingPermissionRequests: [],
      configSnapshot,
      createdAt: new Date(firstTimestamp).toISOString(),
      updatedAt: toolCalls.at(-1)!.timestamp,
    });

    const snapshotResponse = await fetch(`${baseUrl}/api/agent-runs/${runId}/snapshot`);
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json() as {
      run: Record<string, unknown>;
      transcript: {
        messages: typeof messages;
        logs: typeof logs;
        toolCalls: Array<Record<string, unknown>>;
        totalEntries: number;
      };
    };

    expect(snapshot.run["messages"]).toBeUndefined();
    expect(snapshot.run["logs"]).toBeUndefined();
    expect(snapshot.run["toolCalls"]).toBeUndefined();
    expect(snapshot.transcript.totalEntries).toBe(9);
    expect(snapshot.transcript.messages).toHaveLength(3);
    expect(snapshot.transcript.logs).toHaveLength(2);
    expect(snapshot.transcript.toolCalls).toHaveLength(4);
    expect(snapshot.transcript.toolCalls.every((tool) => "input" in tool && !("output" in tool))).toBe(true);

    const etag = snapshotResponse.headers.get("ETag");
    expect(etag).toBeString();
    const notModifiedResponse = await fetch(`${baseUrl}/api/agent-runs/${runId}/snapshot`, {
      headers: { "If-None-Match": etag! },
    });
    expect(notModifiedResponse.status).toBe(304);

    const detailResponse = await fetch(
      `${baseUrl}/api/agent-runs/${runId}/tool-calls/${encodeURIComponent(toolCalls.at(-1)!.id)}`,
    );
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(detail.output.content).toContain("agent-large-output-3");
    expect(JSON.stringify(snapshot)).not.toContain("agent-large-output-3");

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
