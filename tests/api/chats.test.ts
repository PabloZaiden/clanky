/**
 * API integration tests for chat endpoints.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve, type Server } from "bun";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { apiRoutes } from "../../src/api";
import { ensureDataDirectories } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { createMockBackend } from "../mocks/mock-backend";

const testModel = { providerID: "test-provider", modelID: "test-model" };

describe("Chats API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let testWorkspaceId: string;
  let mockBackend: ReturnType<typeof createMockBackend>;

  async function getOrCreateWorkspace(directory: string, name?: string): Promise<string> {
    const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name || directory.split("/").pop() || "Test",
        directory,
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

  beforeAll(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-api-chats-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "ralpher-api-chats-test-work-"));

    process.env["RALPHER_DATA_DIR"] = testDataDir;

    await ensureDataDirectories();

    await Bun.$`git init ${testWorkDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${testWorkDir}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Initial commit"`.quiet();

    mockBackend = createMockBackend(["Hello from chat API", "Second response"]);
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

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

  test("preserves the original first message after multiple sends and reconnect", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "First Message Ordering",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
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
      }),
    });
    expect(firstSendResponse.status).toBe(200);
    await waitForChatIdle(chatId);

    const secondSendResponse = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "This is the second message.",
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
      }),
    });

    const created = await createResponse.json();
    await fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Create a session" }),
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
      body: JSON.stringify({ message: "Recover automatically" }),
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
});
