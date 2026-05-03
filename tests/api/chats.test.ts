/**
 * API integration tests for chat endpoints.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve, type Server } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { apiRoutes } from "../../src/api";
import { ensureDataDirectories } from "../../src/persistence/database";
import { loadChat, updateChatState } from "../../src/persistence/chats";
import { saveLoop } from "../../src/persistence/loops";
import { backendManager } from "../../src/core/backend-manager";
import { getPlanFilePath } from "../../src/lib/planning-files";
import type { Loop } from "../../src/types";
import { DEFAULT_LOOP_CONFIG } from "../../src/types/loop";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { MockAcpBackend, defaultTestModel } from "../mocks/mock-backend";

const testModel = { providerID: "test-provider", modelID: "test-model", variant: "" };
const updatedTestModel = { providerID: "test-provider", modelID: "test-model-2", variant: "" };

describe("Chats API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let testOriginDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let testWorkspaceId: string;
  let mockBackend: MockAcpBackend;

  function installMockBackend(responses: string[]): void {
    mockBackend = new MockAcpBackend({
      responses,
      models: [
        defaultTestModel,
        {
          ...defaultTestModel,
          modelID: updatedTestModel.modelID,
          modelName: "Test Model 2",
        },
      ],
    });
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
  }

  async function getOrCreateWorkspace(directory: string, name?: string): Promise<string> {
    const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name || directory.split("/").pop() || "Test",
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

  async function waitForChatIdle(chatId: string, timeoutMs = 5000): Promise<unknown> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/chats/${chatId}`);
      if (response.ok) {
        const chat = await response.json();
        if (chat.state?.status === "idle" || chat.state?.status === "failed") {
          return chat;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Timed out waiting for chat ${chatId} to settle`);
  }

  function createTestLoop(loopId: string, workingDirectory: string): Loop {
    const now = new Date().toISOString();
    return {
      config: {
        ...DEFAULT_LOOP_CONFIG,
        id: loopId,
        name: `Loop ${loopId}`,
        directory: testWorkDir,
        prompt: "Investigate the loop chat flow",
        createdAt: now,
        updatedAt: now,
        workspaceId: testWorkspaceId,
        model: testModel,
        baseBranch: "main",
        useWorktree: true,
        mode: "loop",
      },
      state: {
        id: loopId,
        status: "completed",
        currentIteration: 1,
        startedAt: now,
        completedAt: now,
        recentIterations: [],
        logs: [],
        messages: [],
        toolCalls: [],
        git: {
          originalBranch: "main",
          workingBranch: `feature/${loopId}`,
          worktreePath: workingDirectory,
          commits: [],
        },
      },
    };
  }

  beforeAll(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-api-chats-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "ralpher-api-chats-test-work-"));
    testOriginDir = await mkdtemp(join(tmpdir(), "ralpher-api-chats-test-origin-"));

    process.env["RALPHER_DATA_DIR"] = testDataDir;

    await ensureDataDirectories();

    await Bun.$`git init -b main ${testWorkDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${testWorkDir}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Initial commit"`.quiet();
    await Bun.$`git init --bare ${testOriginDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} remote add origin ${testOriginDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} push -u origin main`.quiet();

    installMockBackend(["Hello from chat API", "Second response"]);

    server = serve({
      port: 0,
      routes: {
        ...apiRoutes,
      },
    });
    baseUrl = server.url.toString().replace(/\/$/, "");
    testWorkspaceId = await getOrCreateWorkspace(testWorkDir, "Chat Test Workspace");
  });

  afterAll(async () => {
    server.stop();
    backendManager.resetForTesting();
    await rm(testDataDir, { recursive: true, force: true });
    await rm(testWorkDir, { recursive: true, force: true });
    await rm(testOriginDir, { recursive: true, force: true });
    delete process.env["RALPHER_DATA_DIR"];
  });

  test("creates, lists, sends messages to, and reconnects chats", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Chat API Test",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.config.name).toBe("Chat API Test");
    expect(created.config.workspaceId).toBe(testWorkspaceId);
    expect(created.state.status).toBe("idle");

    const listResponse = await fetch(`${baseUrl}/api/chats?workspaceId=${testWorkspaceId}`);
    expect(listResponse.status).toBe(200);
    const chats = await listResponse.json();
    expect(chats.some((chat: { config: { id: string } }) => chat.config.id === created.config.id)).toBe(true);

    const sendResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Say hello",
      }),
    });
    expect(sendResponse.status).toBe(200);

    const settled = await waitForChatIdle(created.config.id) as {
      state: {
        messages: Array<{ role: string; content: string }>;
        session?: { id?: string };
        status: string;
      };
    };
    expect(settled.state.status).toBe("idle");
    expect(settled.state.messages.map((message) => message.content)).toEqual([
      "Say hello",
      "Hello from chat API",
    ]);

    const reconnectResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/reconnect`, {
      method: "POST",
    });
    expect(reconnectResponse.status).toBe(200);
    const reconnected = await reconnectResponse.json();
    expect(reconnected.state.session.id).toBe(settled.state.session?.id);
    expect(reconnected.state.status).toBe("idle");
  });

  test("checks out the selected branch for non-worktree chats without creating a managed chat branch", async () => {
    const originalBranch = (await Bun.$`git -C ${testWorkDir} branch --show-current`.text()).trim();
    const selectedBranch = "selected-chat-base";

    await Bun.$`git -C ${testWorkDir} checkout -b ${selectedBranch}`.quiet();
    await Bun.$`git -C ${testWorkDir} checkout ${originalBranch}`.quiet();

    try {
      const branchFormat = "%(refname:short)";
      const createResponse = await fetch(`${baseUrl}/api/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Selected Branch Chat",
          workspaceId: testWorkspaceId,
          model: testModel,
          useWorktree: false,
          baseBranch: selectedBranch,
        }),
      });

      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();

      const sendResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Use the selected branch",
          attachments: [],
        }),
      });
      expect(sendResponse.status).toBe(200);

      await waitForChatIdle(created.config.id as string);

      const currentBranch = (await Bun.$`git -C ${testWorkDir} branch --show-current`.text()).trim();
      expect(currentBranch).toBe(selectedBranch);

      const branches = (await Bun.$`git -C ${testWorkDir} for-each-ref --format=${branchFormat} refs/heads`.text())
        .split("\n")
        .map((branch) => branch.trim())
        .filter(Boolean);
      expect(branches.some((branch) => branch.startsWith("chat-selected-branch-chat-"))).toBe(false);
      expect(branches.includes(selectedBranch)).toBe(true);
    } finally {
      await Bun.$`git -C ${testWorkDir} checkout ${originalBranch}`.quiet();
    }
  });

  test("rejects invalid standalone chat base branches before branch checkout", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid Branch Chat",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "-unsafe-branch",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();

    const sendResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Try to use the invalid branch",
        attachments: [],
      }),
    });

    expect(sendResponse.status).toBe(400);
    await expect(sendResponse.json()).resolves.toMatchObject({
      error: "invalid_chat_base_branch",
      message: "Standalone chat base branch '-unsafe-branch' is not a valid git branch name.",
    });
  });

  test("returns a conflict when standalone branch checkout cannot proceed", async () => {
    const originalBranch = (await Bun.$`git -C ${testWorkDir} branch --show-current`.text()).trim();
    const selectedBranch = `selected-chat-conflict-${crypto.randomUUID().slice(0, 8)}`;
    const dirtyFile = join(testWorkDir, "standalone-chat-dirty.txt");

    await Bun.$`git -C ${testWorkDir} checkout -b ${selectedBranch}`.quiet();
    await Bun.$`git -C ${testWorkDir} checkout ${originalBranch}`.quiet();
    await writeFile(dirtyFile, "dirty working tree\n");

    try {
      const createResponse = await fetch(`${baseUrl}/api/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Branch Conflict Chat",
          workspaceId: testWorkspaceId,
          model: testModel,
          useWorktree: false,
          baseBranch: selectedBranch,
        }),
      });

      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();

      const sendResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Try to switch branches with local changes",
          attachments: [],
        }),
      });

      expect(sendResponse.status).toBe(409);
      const errorBody = await sendResponse.json();
      expect(errorBody).toMatchObject({
        error: "chat_branch_checkout_failed",
      });
      expect(errorBody.message).toContain(`Unable to switch the standalone chat to branch '${selectedBranch}'.`);
      expect(errorBody.message).toContain(`Cannot auto-checkout to '${selectedBranch}'`);
    } finally {
      await rm(dirtyFile, { force: true });
      await Bun.$`git -C ${testWorkDir} checkout ${originalBranch}`.quiet();
    }
  });

  test("preserves the original first message after multiple sends and reconnect", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "First Message Ordering",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const chatId = created.config.id as string;

    const firstMessage = "Remember: this is the first message.";

    const firstSendResponse = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: firstMessage,
        attachments: [],
      }),
    });
    expect(firstSendResponse.status).toBe(200);
    await waitForChatIdle(chatId);

    const secondSendResponse = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "This is the second message.",
        attachments: [],
      }),
    });
    expect(secondSendResponse.status).toBe(200);
    await waitForChatIdle(chatId);

    const reconnectResponse = await fetch(`${baseUrl}/api/chats/${chatId}/reconnect`, {
      method: "POST",
    });
    expect(reconnectResponse.status).toBe(200);

    const resumedSendResponse = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "This is the third message after reconnect.",
        attachments: [],
      }),
    });
    expect(resumedSendResponse.status).toBe(200);

    const settled = await waitForChatIdle(chatId) as {
      state: {
        status: string;
        messages: Array<{ id?: string; role: string; content: string; timestamp?: string }>;
      };
    };

    expect(settled.state.status).toBe("idle");
    expect(settled.state.messages[0]).toMatchObject({
      role: "user",
      content: firstMessage,
    });
    expect(
      settled.state.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual([
      "Remember: this is the first message.",
      "This is the second message.",
      "This is the third message after reconnect.",
    ]);
  });

  test("recreates missing persisted sessions during reconnect and send", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Reconnect Failure",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });

    const created = await createResponse.json();
    await fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Create a session", attachments: [] }),
    });

    const settled = await waitForChatIdle(created.config.id) as {
      state: { session?: { id?: string } };
    };

    const sessionId = settled.state.session?.id;
    expect(sessionId).toBeString();
    await mockBackend.deleteSession(sessionId!);

    const reconnectResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/reconnect`, {
      method: "POST",
    });
    expect(reconnectResponse.status).toBe(200);
    const reconnected = await reconnectResponse.json();
    expect(reconnected.state.status).toBe("idle");
    expect(reconnected.state.session.id).not.toBe(sessionId);
    expect(reconnected.state.error).toBeUndefined();

    const replacementSessionId = reconnected.state.session.id as string;
    await mockBackend.deleteSession(replacementSessionId);

    const resumedSendResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Recover automatically", attachments: [] }),
    });
    expect(resumedSendResponse.status).toBe(200);

    const settledAfterRecovery = await waitForChatIdle(created.config.id) as {
      state: {
        status: string;
        session?: { id?: string };
        error?: { message: string };
        messages: Array<{ content: string }>;
      };
    };

    expect(settledAfterRecovery.state.status).toBe("idle");
    expect(settledAfterRecovery.state.session?.id).toBeString();
    expect(settledAfterRecovery.state.session?.id).not.toBe(replacementSessionId);
    expect(settledAfterRecovery.state.error).toBeUndefined();
    expect(settledAfterRecovery.state.messages.some((message) => message.content === "Recover automatically")).toBe(true);
  });

  test("renames an existing chat", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Original Chat Name",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();

    const renameResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Renamed Chat",
      }),
    });

    expect(renameResponse.status).toBe(200);
    const renamed = await renameResponse.json();
    expect(renamed.config.name).toBe("Renamed Chat");
    expect(renamed.config.id).toBe(created.config.id);
    expect(renamed.config.workspaceId).toBe(created.config.workspaceId);
    expect(new Date(renamed.config.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.config.updatedAt).getTime(),
    );

    const getResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}`);
    expect(getResponse.status).toBe(200);
    const persisted = await getResponse.json();
    expect(persisted.config.name).toBe("Renamed Chat");
  });

  test("updates a chat model and uses it for the next turn", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Model Update Chat",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const chatId = created.config.id as string;

    const updateResponse = await fetch(`${baseUrl}/api/chats/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: updatedTestModel,
      }),
    });

    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json();
    expect(updated.config.model).toEqual(updatedTestModel);

    const sendResponse = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Use the updated model",
        attachments: [],
      }),
    });
    expect(sendResponse.status).toBe(200);

    await waitForChatIdle(chatId);

    const lastPrompt = mockBackend.getSentPrompts().at(-1);
    expect(lastPrompt?.model).toEqual(updatedTestModel);

    const persisted = await loadChat(chatId);
    expect(persisted?.config.model).toEqual(updatedTestModel);
  });

  test("creates a loop-owned default chat that stays out of standalone chat APIs", async () => {
    const loopId = "loop-chat-api-test";
    const loopWorkingDirectory = join(testWorkDir, ".ralph-worktrees", loopId);
    await saveLoop(createTestLoop(loopId, loopWorkingDirectory));

    const createResponse = await fetch(`${baseUrl}/api/loops/${loopId}/chat`, {
      method: "POST",
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.config.scope).toBe("loop");
    expect(created.config.loopId).toBe(loopId);
    expect(created.config.directory).toBe(loopWorkingDirectory);
    expect(created.config.useWorktree).toBe(false);

    const sendResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Stay in the loop worktree",
        attachments: [],
      }),
    });
    expect(sendResponse.status).toBe(200);

    await waitForChatIdle(created.config.id as string);
    expect(mockBackend.getDirectory()).toBe(loopWorkingDirectory);

    const getResponse = await fetch(`${baseUrl}/api/loops/${loopId}/chat`);
    expect(getResponse.status).toBe(200);
    const loaded = await getResponse.json();
    expect(loaded.config.id).toBe(created.config.id);

    const allStandaloneListResponse = await fetch(`${baseUrl}/api/chats`);
    expect(allStandaloneListResponse.status).toBe(200);
    const allStandaloneChats = await allStandaloneListResponse.json();
    expect(allStandaloneChats.some((chat: { config: { id: string } }) => chat.config.id === created.config.id)).toBe(false);

    const workspaceStandaloneListResponse = await fetch(`${baseUrl}/api/chats?workspaceId=${testWorkspaceId}`);
    expect(workspaceStandaloneListResponse.status).toBe(200);
    const workspaceStandaloneChats = await workspaceStandaloneListResponse.json();
    expect(workspaceStandaloneChats.some((chat: { config: { id: string } }) => chat.config.id === created.config.id)).toBe(false);

    const renameResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Should fail" }),
    });
    expect(renameResponse.status).toBe(409);

    const deleteResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(409);
  });

  test("spawns a plan-mode loop from an existing chat without deleting the chat", async () => {
    installMockBackend([
      "Hello from chat API",
      "Plan created\n<promise>PLAN_READY</promise>",
    ]);

    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Spawn Source Chat",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const chatId = created.config.id as string;

    const sendResponse = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Turn this debugging conversation into a loop plan.",
        attachments: [],
      }),
    });
    expect(sendResponse.status).toBe(200);

    const settledChat = await waitForChatIdle(chatId) as {
      state: {
        status: string;
        messages: Array<{ role: string; content: string }>;
      };
    };
    expect(settledChat.state.status).toBe("idle");

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-loop`, {
      method: "POST",
    });
    expect(spawnResponse.status).toBe(201);
    const spawnedLoop = await spawnResponse.json();

    expect(spawnedLoop.config.id).not.toBe(chatId);
    expect(spawnedLoop.config.workspaceId).toBe(testWorkspaceId);
    expect(spawnedLoop.config.planMode).toBe(true);
    expect(spawnedLoop.config.autoAcceptPlan).toBe(false);
    expect(spawnedLoop.config.fullyAutonomous).toBe(false);
    expect(spawnedLoop.state.status).toBe("planning");
    expect(spawnedLoop.config.prompt).toContain("You are creating a new Ralph plan loop from an existing chat conversation.");
    expect(spawnedLoop.config.prompt).toContain("Chat title: Spawn Source Chat");
    expect(spawnedLoop.config.prompt).toContain("Only the user and assistant messages are included here; tool calls and hidden reasoning are intentionally excluded.");
    expect(spawnedLoop.config.prompt).toContain("Turn this debugging conversation into a loop plan.");
    expect(spawnedLoop.config.prompt).toContain("Hello from chat API");

    const listLoopsResponse = await fetch(`${baseUrl}/api/loops`);
    expect(listLoopsResponse.status).toBe(200);
    const loops = await listLoopsResponse.json();
    expect(loops.some((loop: { config: { id: string } }) => loop.config.id === spawnedLoop.config.id)).toBe(true);

    const chatResponse = await fetch(`${baseUrl}/api/chats/${chatId}`);
    expect(chatResponse.status).toBe(200);
    const chatAfterSpawn = await chatResponse.json();
    expect(
      chatAfterSpawn.state.messages.map((message: { content: string }) => message.content),
    ).toEqual(
      settledChat.state.messages.map((message) => message.content),
    );
  });

  test("rejects spawn-loop when the chat transcript is empty", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Empty Spawn Source",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/spawn-loop`, {
      method: "POST",
    });

    expect(spawnResponse.status).toBe(400);
    await expect(spawnResponse.json()).resolves.toMatchObject({
      error: "empty_transcript",
      message: "Chat transcript is empty. Send at least one message before spawning a loop.",
    });
  });

  test("rejects spawn-loop while a chat response is still in progress", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Busy Spawn Source",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const chatId = created.config.id as string;

    const storedChat = await loadChat(chatId);
    expect(storedChat).not.toBeNull();
    await updateChatState(chatId, {
      ...storedChat!.state,
      status: "streaming",
    });

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-loop`, {
      method: "POST",
    });

    expect(spawnResponse.status).toBe(409);
    await expect(spawnResponse.json()).resolves.toMatchObject({
      error: "chat_busy",
      message: "Chat is busy",
    });
  });

  test("spawns a loop from the chat's current plan", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Plan`Source\nChat",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: true,
        baseBranch: "main",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const chatId = created.config.id as string;

    const sendResponse = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Turn this into a plan-ready loop.",
        attachments: [],
      }),
    });
    expect(sendResponse.status).toBe(200);

    const settledChat = await waitForChatIdle(chatId) as {
      state: {
        status: string;
        worktree?: {
          worktreePath?: string;
        };
      };
    };
    expect(settledChat.state.status).toBe("idle");
    expect(settledChat.state.worktree?.worktreePath).toBeDefined();

    const chatWorktreePath = settledChat.state.worktree!.worktreePath!;
    await mkdir(join(chatWorktreePath, "plans"), { recursive: true });
    await writeFile(
      join(chatWorktreePath, "plans", "seeded-plan.md"),
      "\uFEFF# Imported plan\n\n1. Do the seeded work.\n\n<promise>PLAN_READY</promise>\n",
    );
    await writeFile(join(chatWorktreePath, "plans", "status.md"), "# Imported status\n\nReady to review.");

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-loop-from-current-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planFilePath: "plans/seeded-plan.md",
      }),
    });

    expect(spawnResponse.status).toBe(201);
    const spawnedLoop = await spawnResponse.json();
    expect(spawnedLoop.config.autoAcceptPlan).toBe(false);
    expect(spawnedLoop.config.fullyAutonomous).toBe(false);
    expect(spawnedLoop.state.status).toBe("planning");
    expect(spawnedLoop.state.planMode?.isPlanReady).toBe(true);
    expect(spawnedLoop.state.planMode?.planContent).toBe("# Imported plan\n\n1. Do the seeded work.");

    const planResponse = await fetch(`${baseUrl}/api/loops/${spawnedLoop.config.id}/plan`);
    expect(planResponse.status).toBe(200);
    await expect(planResponse.json()).resolves.toMatchObject({
      exists: true,
      content: "# Imported plan\n\n1. Do the seeded work.",
    });

    const statusResponse = await fetch(`${baseUrl}/api/loops/${spawnedLoop.config.id}/status-file`);
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      exists: true,
      content: "# Imported status\n\nReady to review.",
    });
  });

  test("falls back to the default plan path when the submitted plan file path is blank", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Blank Path Plan Chat",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: true,
        baseBranch: "main",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const chatId = created.config.id as string;

    const sendResponse = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Use the default plan path when no file path is provided.",
        attachments: [],
      }),
    });
    expect(sendResponse.status).toBe(200);

    const settledChat = await waitForChatIdle(chatId) as {
      state: {
        worktree?: {
          worktreePath?: string;
        };
      };
    };
    const chatWorktreePath = settledChat.state.worktree!.worktreePath!;
    await mkdir(join(chatWorktreePath, ".ralph-planning"), { recursive: true });
    await writeFile(getPlanFilePath(chatWorktreePath), "# Fallback plan\n\n1. Use the default path.\n");

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-loop-from-current-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planFilePath: "   ",
      }),
    });

    expect(spawnResponse.status).toBe(201);
    const spawnedLoop = await spawnResponse.json();
    expect(spawnedLoop.state.planMode?.planContent).toBe("# Fallback plan\n\n1. Use the default path.");
  });

  test("spawns from an absolute plan path outside the chat workspace", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid Path Plan Chat",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: true,
        baseBranch: "main",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const chatId = created.config.id as string;

    const sendResponse = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Use an invalid plan path.",
        attachments: [],
      }),
    });
    expect(sendResponse.status).toBe(200);
    await waitForChatIdle(chatId);

    const importedPlanDir = join(testDataDir, "imported-plan-files");
    await mkdir(importedPlanDir, { recursive: true });
    const importedPlanPath = join(importedPlanDir, "external-plan.md");
    await writeFile(importedPlanPath, "# External plan\n\n1. Import from an absolute path.\n");
    await writeFile(join(importedPlanDir, "status.md"), "# External status\n\nReady from outside workspace.");

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-loop-from-current-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planFilePath: importedPlanPath,
      }),
    });

    expect(spawnResponse.status).toBe(201);
    const spawnedLoop = await spawnResponse.json();
    expect(spawnedLoop.state.planMode?.planContent).toBe("# External plan\n\n1. Import from an absolute path.");

    const planResponse = await fetch(`${baseUrl}/api/loops/${spawnedLoop.config.id}/plan`);
    expect(planResponse.status).toBe(200);
    await expect(planResponse.json()).resolves.toMatchObject({
      exists: true,
      content: "# External plan\n\n1. Import from an absolute path.",
    });

    const statusResponse = await fetch(`${baseUrl}/api/loops/${spawnedLoop.config.id}/status-file`);
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      exists: true,
      content: "# External status\n\nReady from outside workspace.",
    });
  });

  test("rejects spawning from current plan when no plan file exists", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Missing Plan Chat",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: true,
        baseBranch: "main",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const chatId = created.config.id as string;

    const sendResponse = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Create a chat with no plan file.",
        attachments: [],
      }),
    });
    expect(sendResponse.status).toBe(200);
    await waitForChatIdle(chatId);

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-loop-from-current-plan`, {
      method: "POST",
    });

    expect(spawnResponse.status).toBe(400);
    await expect(spawnResponse.json()).resolves.toMatchObject({
      error: "invalid_current_plan",
      message: "No Ralpher plan file was found in the current chat workspace.",
    });
  });

  test("rejects spawning from current plan when the plan file is empty", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Empty Plan Chat",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: true,
        baseBranch: "main",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const chatId = created.config.id as string;

    const sendResponse = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Create a chat with an empty plan file.",
        attachments: [],
      }),
    });
    expect(sendResponse.status).toBe(200);

    const settledChat = await waitForChatIdle(chatId) as {
      state: {
        worktree?: {
          worktreePath?: string;
        };
      };
    };
    const chatWorktreePath = settledChat.state.worktree!.worktreePath!;
    await mkdir(join(chatWorktreePath, ".ralph-planning"), { recursive: true });
    await writeFile(getPlanFilePath(chatWorktreePath), "\n<promise>PLAN_READY</promise>\n");

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-loop-from-current-plan`, {
      method: "POST",
    });

    expect(spawnResponse.status).toBe(400);
    await expect(spawnResponse.json()).resolves.toMatchObject({
      error: "invalid_current_plan",
      message: "The current Ralpher plan file is empty.",
    });
  });
});
