/**
 * API integration tests for scheduled agents.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve, type Server } from "bun";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { apiRoutes } from "../../src/api";
import { agentScheduler } from "../../src/core/agent-scheduler";
import { backendManager } from "../../src/core/backend-manager";
import { closeDatabase, ensureDataDirectories } from "../../src/persistence/database";
import { listAgentRuns, loadAgent, saveAgent, saveAgentRun } from "../../src/persistence/agents";
import { listTasks } from "../../src/persistence/tasks";
import type { AgentRun } from "../../src/types/agent";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { MockAcpBackend, defaultTestModel } from "../mocks/mock-backend";

const testModel = { providerID: "test-provider", modelID: "test-model", variant: "" };

describe("Agents API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let workspaceId: string;

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

  async function createAgent(name = "Scheduled build fixer") {
    const response = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        workspaceId,
        prompt: "Check the workspace and report status",
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
    await ensureDataDirectories();

    await Bun.$`git init ${testWorkDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${testWorkDir}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Initial commit"`.quiet();

    backendManager.setBackendForTesting(new MockAcpBackend({
      responses: ["Agent run completed"],
      models: [defaultTestModel],
    }));
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    server = serve({
      port: 0,
      routes: {
        ...apiRoutes,
      },
    });
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
