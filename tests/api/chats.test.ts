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
import { saveTask } from "../../src/persistence/tasks";
import { setQuickChatSettings } from "../../src/persistence/preferences";
import { normalizeQuickChatSettings } from "../../src/types/schemas";
import { backendManager } from "../../src/core/backend-manager";
import { chatEventEmitter } from "../../src/core/event-emitter";
import { getPlanFilePath } from "../../src/lib/planning-files";
import type { Task, TaskLogEntry, PersistedMessage, PersistedToolCall } from "../../src/types";
import { DEFAULT_QUICK_CHAT_SETTINGS } from "../../src/types/preferences";
import type { ChatEvent } from "../../src/types/events";
import { DEFAULT_TASK_CONFIG } from "../../src/types/task";
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

  function createTestTask(taskId: string, workingDirectory: string): Task {
    const now = new Date().toISOString();
    return {
      config: {
        ...DEFAULT_TASK_CONFIG,
        id: taskId,
        name: `Task ${taskId}`,
        directory: testWorkDir,
        prompt: "Investigate the task chat flow",
        createdAt: now,
        updatedAt: now,
        workspaceId: testWorkspaceId,
        model: testModel,
        baseBranch: "main",
        useWorktree: true,
        mode: "task",
      },
      state: {
        id: taskId,
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
          workingBranch: `feature/${taskId}`,
          worktreePath: workingDirectory,
          commits: [],
        },
      },
    };
  }

  beforeAll(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-api-chats-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "clanky-api-chats-test-work-"));
    testOriginDir = await mkdtemp(join(tmpdir(), "clanky-api-chats-test-origin-"));

    process.env["CLANKY_DATA_DIR"] = testDataDir;

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
    delete process.env["CLANKY_DATA_DIR"];
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
    expect(created.config.autoApprovePermissions).toBe(true);
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
    const sendData = await sendResponse.json();
    expect(sendData).toEqual({
      success: true,
      chatId: created.config.id,
    });
    expect(sendData.state).toBeUndefined();

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

  test("exports chat transcript as markdown without tool call details", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Transcript Export Test",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const persisted = await loadChat(created.config.id);
    expect(persisted).not.toBeNull();
    if (!persisted) {
      throw new Error("Expected persisted chat");
    }

    const messages: PersistedMessage[] = [
      {
        id: "msg-user",
        role: "user",
        content: "Please inspect the README",
        timestamp: "2026-06-04T12:00:00.000Z",
      },
      {
        id: "msg-assistant",
        role: "assistant",
        content: "I inspected it and found the issue.",
        timestamp: "2026-06-04T12:02:00.000Z",
      },
    ];
    const toolCalls: PersistedToolCall[] = [
      {
        id: "tool-read",
        name: "Read\n\tInjected",
        input: { path: "/tmp/secret-readme.md", includeDetails: "must-not-export" },
        output: { content: "private tool output must not export" },
        status: "completed",
        timestamp: "2026-06-04T12:01:00.000Z",
      },
    ];
    await updateChatState(created.config.id, {
      ...persisted.state,
      messages,
      toolCalls,
    });

    const transcriptResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/transcript.md`);
    expect(transcriptResponse.status).toBe(200);
    expect(transcriptResponse.headers.get("Content-Type")).toContain("text/markdown");
    const markdown = await transcriptResponse.text();

    expect(markdown).toContain("# Transcript Export Test");
    expect(markdown.indexOf("Please inspect the README")).toBeLessThan(markdown.indexOf("### Tool: Read Injected"));
    expect(markdown.indexOf("### Tool: Read Injected")).toBeLessThan(
      markdown.indexOf("I inspected it and found the issue."),
    );
    expect(markdown).not.toContain("### Tool: Read\n");
    expect(markdown).not.toContain("- Directory:");
    expect(markdown).not.toContain(testWorkDir);
    expect(markdown).not.toContain("must-not-export");
    expect(markdown).not.toContain("private tool output must not export");
    expect(markdown).not.toContain("/tmp/secret-readme.md");

    const downloadResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/transcript.md?download=1`);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="transcript-export-test-.+\.md"$/,
    );
  });

  test("exports attachment-only chat messages with a safe placeholder", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Attachment Only Transcript",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const persisted = await loadChat(created.config.id);
    if (!persisted) {
      throw new Error("Expected persisted chat");
    }

    const messages: PersistedMessage[] = [
      {
        id: "msg-attachment-only",
        role: "user",
        content: "   ",
        timestamp: "2026-06-04T12:03:00.000Z",
        attachments: [
          {
            id: "attachment-1",
            filename: "secret-screenshot.png",
            mimeType: "image/png",
            data: "private-base64-data",
            size: 123,
          },
        ],
      },
    ];
    await updateChatState(created.config.id, {
      ...persisted.state,
      messages,
      toolCalls: [],
    });

    const transcriptResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/transcript.md`);
    expect(transcriptResponse.status).toBe(200);
    const markdown = await transcriptResponse.text();

    expect(markdown).toContain("### User - 2026-06-04T12:03:00.000Z");
    expect(markdown).toContain("Attachment sent. Attachment data is not included in this transcript.");
    expect(markdown).not.toContain("secret-screenshot.png");
    expect(markdown).not.toContain("private-base64-data");
  });

  test("returns clear transcript export errors for missing or empty chats", async () => {
    const missingResponse = await fetch(`${baseUrl}/api/chats/missing-chat/transcript.md`);
    expect(missingResponse.status).toBe(404);

    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Empty Transcript Export",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();

    const emptyResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/transcript.md`);
    expect(emptyResponse.status).toBe(400);
    expect((await emptyResponse.json()).error).toBe("empty_transcript");
  });

  test("renames autogenerated chats from the first user message and emits chat.updated", async () => {
    installMockBackend(["Investigate Login Bug", "Assistant response"]);
    const events: ChatEvent[] = [];
    const unsubscribe = chatEventEmitter.subscribe((event) => {
      events.push(event);
    });

    try {
      const createResponse = await fetch(`${baseUrl}/api/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          model: testModel,
          useWorktree: false,
          baseBranch: "main",
        }),
      });

      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();
      expect(created.config.name).toStartWith("Chat Test Workspace - ");

      const sendResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Please investigate why login fails after OAuth callback",
        }),
      });
      expect(sendResponse.status).toBe(200);

      const settled = await waitForChatIdle(created.config.id) as Awaited<ReturnType<typeof loadChat>>;
      expect(settled?.config.name).toBe("Investigate Login Bug");
      expect(settled?.state.messages.map((message) => message.content)).toEqual([
        "Please investigate why login fails after OAuth callback",
        "Assistant response",
      ]);

      const updateEvent = events.find((event) => event.type === "chat.updated" && event.chatId === created.config.id);
      expect(updateEvent).toBeDefined();
      if (updateEvent?.type === "chat.updated") {
        expect(updateEvent.chat.config.name).toBe("Investigate Login Bug");
      }
    } finally {
      unsubscribe();
    }
  });

  test("rejects concurrent sends while first-message rename is generating", async () => {
    installMockBackend(["Generated Busy Name", "Assistant response"]);
    let releaseNameGeneration!: () => void;
    const nameGenerationStarted = new Promise<void>((resolve) => {
      const originalSendPrompt = mockBackend.sendPrompt.bind(mockBackend);
      mockBackend.sendPrompt = async (sessionId, prompt) => {
        const isChatNamePrompt = prompt.parts.some((part) =>
          part.type === "text" && part.text.includes("Generate a short name for a chat")
        );
        if (!isChatNamePrompt) {
          return originalSendPrompt(sessionId, prompt);
        }

        resolve();
        await new Promise<void>((release) => {
          releaseNameGeneration = release;
        });
        return originalSendPrompt(sessionId, prompt);
      };
    });

    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();

    const firstSendPromise = fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Name this chat while busy" }),
    });
    await nameGenerationStarted;

    const concurrentSendResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "This concurrent message should be rejected" }),
    });
    expect(concurrentSendResponse.status).toBe(409);

    releaseNameGeneration();
    const firstSendResponse = await firstSendPromise;
    expect(firstSendResponse.status).toBe(200);

    const settled = await waitForChatIdle(created.config.id) as Awaited<ReturnType<typeof loadChat>>;
    expect(settled?.config.name).toBe("Generated Busy Name");
    expect(settled?.state.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "Name this chat while busy",
    ]);
  });

  test("continues first send if temporary chat-name session creation fails", async () => {
    installMockBackend(["Assistant response after rename failure"]);
    const originalCreateSession = mockBackend.createSession.bind(mockBackend);
    mockBackend.createSession = async (options) => {
      if (options.title === "Chat Name Generation") {
        throw new Error("temporary session unavailable");
      }
      return originalCreateSession(options);
    };

    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const originalName = created.config.name;

    const sendResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Continue even when helper session fails" }),
    });
    expect(sendResponse.status).toBe(200);

    const settled = await waitForChatIdle(created.config.id) as Awaited<ReturnType<typeof loadChat>>;
    expect(settled?.config.name).toBe(originalName);
    expect(settled?.state.messages.map((message) => message.content)).toEqual([
      "Continue even when helper session fails",
      "Assistant response after rename failure",
    ]);

    const nameGenerationPrompts = mockBackend.getSentPrompts().filter((prompt) =>
      prompt.parts.some((part) => part.type === "text" && part.text.includes("Generate a short name for a chat"))
    );
    expect(nameGenerationPrompts).toHaveLength(0);
  });

  test("renames autogenerated chats with long truncated workspace names", async () => {
    installMockBackend(["Long Workspace Topic", "Assistant response"]);
    const longWorkspaceDir = await mkdtemp(join(tmpdir(), "clanky-chat-long-workspace-"));
    try {
      await Bun.$`git -C ${longWorkspaceDir} init --quiet --initial-branch=main`;
      const longWorkspaceName = `${"Very Long Workspace Name ".repeat(8)}Suffix`;
      const longWorkspaceId = await getOrCreateWorkspace(longWorkspaceDir, longWorkspaceName);

      const createResponse = await fetch(`${baseUrl}/api/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: longWorkspaceId,
          model: testModel,
          useWorktree: false,
          baseBranch: "main",
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();
      expect(created.config.name).toEndWith(" - 1");
      expect(created.config.name.length).toBeLessThanOrEqual(100);

      const sendResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Summarize the long workspace issue" }),
      });
      expect(sendResponse.status).toBe(200);

      const settled = await waitForChatIdle(created.config.id) as Awaited<ReturnType<typeof loadChat>>;
      expect(settled?.config.name).toBe("Long Workspace Topic");
    } finally {
      await rm(longWorkspaceDir, { recursive: true, force: true });
    }
  });

  test("does not automatically rename explicit chats or rename autogenerated chats after the first message", async () => {
    installMockBackend(["Explicit response", "Generated Chat Topic", "First generated response", "Second generated response"]);
    const explicitResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Explicit Chat Name",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });
    expect(explicitResponse.status).toBe(201);
    const explicitChat = await explicitResponse.json();

    const explicitSendResponse = await fetch(`${baseUrl}/api/chats/${explicitChat.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "This should not rename the explicit chat" }),
    });
    expect(explicitSendResponse.status).toBe(200);
    const settledExplicit = await waitForChatIdle(explicitChat.config.id) as Awaited<ReturnType<typeof loadChat>>;
    expect(settledExplicit?.config.name).toBe("Explicit Chat Name");

    const generatedResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });
    expect(generatedResponse.status).toBe(201);
    const generatedChat = await generatedResponse.json();

    const firstSendResponse = await fetch(`${baseUrl}/api/chats/${generatedChat.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Summarize the billing webhook failure" }),
    });
    expect(firstSendResponse.status).toBe(200);
    const firstSettled = await waitForChatIdle(generatedChat.config.id) as Awaited<ReturnType<typeof loadChat>>;
    expect(firstSettled?.config.name).toBe("Generated Chat Topic");

    const secondSendResponse = await fetch(`${baseUrl}/api/chats/${generatedChat.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Add more detail to the investigation" }),
    });
    expect(secondSendResponse.status).toBe(200);
    const secondSettled = await waitForChatIdle(generatedChat.config.id) as Awaited<ReturnType<typeof loadChat>>;
    expect(secondSettled?.config.name).toBe("Generated Chat Topic");

    const nameGenerationPrompts = mockBackend.getSentPrompts().filter((prompt) =>
      prompt.parts.some((part) => part.type === "text" && part.text.includes("Generate a short name for a chat"))
    );
    expect(nameGenerationPrompts).toHaveLength(1);
  });

  test("allows model validation bypass only for saved quick chat settings", async () => {
    const unavailableModel = { providerID: "missing-provider", modelID: "missing-model", variant: "" };

    const standardResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Unavailable Standard Chat",
        workspaceId: testWorkspaceId,
        model: unavailableModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });
    expect(standardResponse.status).toBe(400);
    expect((await standardResponse.json()).error).toBe("provider_not_found");

    const mismatchedQuickResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Mismatched Quick Chat",
        workspaceId: testWorkspaceId,
        model: unavailableModel,
        useWorktree: false,
        baseBranch: "main",
        quick: true,
      }),
    });
    expect(mismatchedQuickResponse.status).toBe(400);
    expect((await mismatchedQuickResponse.json()).error).toBe("quick_chat_model_mismatch");

    await setQuickChatSettings({
      workspaceId: testWorkspaceId,
      model: unavailableModel,
      useWorktree: false,
    });

    const quickResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Configured Quick Chat",
        workspaceId: testWorkspaceId,
        model: unavailableModel,
        useWorktree: false,
        baseBranch: "main",
        quick: true,
      }),
    });
    expect(quickResponse.status).toBe(201);
    const quickChat = await quickResponse.json();
    expect(quickChat.config.model).toEqual(unavailableModel);
  });

  test("creates configured quick chats without preparing a worktree before responding", async () => {
    await setQuickChatSettings({
      workspaceId: testWorkspaceId,
      model: testModel,
      useWorktree: true,
    });

    const quickResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Deferred Worktree Quick Chat",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: true,
        quick: true,
      }),
    });

    expect(quickResponse.status).toBe(201);
    const quickChat = await quickResponse.json();
    expect(quickChat.config.useWorktree).toBe(true);
    expect(quickChat.config.skipBaseBranchSync).toBe(true);
    expect(quickChat.state.worktree).toBeUndefined();

    const persisted = await loadChat(quickChat.config.id);
    expect(persisted?.state.worktree).toBeUndefined();
  });

  test("persists quick chat worktree preference and defaults legacy settings to disabled", async () => {
    await setQuickChatSettings(DEFAULT_QUICK_CHAT_SETTINGS);

    const defaultResponse = await fetch(`${baseUrl}/api/preferences/quick-chat`);
    expect(defaultResponse.status).toBe(200);
    expect((await defaultResponse.json()).useWorktree).toBe(false);

    const enableResponse = await fetch(`${baseUrl}/api/preferences/quick-chat`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: true,
      }),
    });
    expect(enableResponse.status).toBe(200);
    expect((await enableResponse.json()).settings.useWorktree).toBe(true);

    const enabledResponse = await fetch(`${baseUrl}/api/preferences/quick-chat`);
    expect(enabledResponse.status).toBe(200);
    expect((await enabledResponse.json()).useWorktree).toBe(true);

    const disableResponse = await fetch(`${baseUrl}/api/preferences/quick-chat`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
      }),
    });
    expect(disableResponse.status).toBe(200);
    expect((await disableResponse.json()).settings.useWorktree).toBe(false);

    expect(normalizeQuickChatSettings({
      workspaceId: testWorkspaceId,
      model: testModel,
    }).useWorktree).toBe(false);
  });

  test("creates chats without an explicit base branch", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Chat Without Base Branch",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: true,
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.config.name).toBe("Chat Without Base Branch");
    expect(created.config.workspaceId).toBe(testWorkspaceId);
    expect(created.config.useWorktree).toBe(true);
    expect(created.config.baseBranch).toBeUndefined();

    const expectedWorktreePath = `${testWorkDir}/.clanky-worktrees/${created.config.id}`;
    expect(created.state.worktree?.originalBranch).toBe("main");
    expect(created.state.worktree?.workingBranch).toContain("chat-chat-without-base-branch-");
    expect(created.state.worktree?.worktreePath).toBe(expectedWorktreePath);

    const persisted = await loadChat(created.config.id);
    expect(persisted?.state.worktree?.worktreePath).toBe(expectedWorktreePath);
  });

  test("lists chats without hydrating transcript payloads", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Chat List Summary Test",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        baseBranch: "main",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const timestamp = new Date().toISOString();
    const messages: PersistedMessage[] = [{
      id: "message-1",
      role: "assistant",
      content: "Large transcript content that should not be returned by the list endpoint",
      timestamp,
    }];
    const logs: TaskLogEntry[] = [{
      id: "log-1",
      level: "agent",
      message: "Large log content that should not be returned by the list endpoint",
      timestamp,
    }];
    const toolCalls: PersistedToolCall[] = [{
      id: "tool-1",
      name: "Read",
      input: { filePath: "src/index.ts" },
      output: { content: "Large tool output that should not be returned by the list endpoint" },
      status: "completed",
      timestamp,
    }];

    const updated = await updateChatState(created.config.id as string, {
      ...created.state,
      messages,
      logs,
      toolCalls,
      lastActivityAt: timestamp,
    });
    expect(updated).not.toBeNull();

    const listResponse = await fetch(`${baseUrl}/api/chats?workspaceId=${testWorkspaceId}`);
    expect(listResponse.status).toBe(200);
    const listedChats = await listResponse.json();
    const listed = listedChats.find((chat: { config: { id: string } }) => chat.config.id === created.config.id);
    expect(listed).toBeDefined();
    expect(listed.state.messages).toEqual([]);
    expect(listed.state.logs).toEqual([]);
    expect(listed.state.toolCalls).toEqual([]);

    const detailResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(detail.state.messages).toEqual(messages);
    expect(detail.state.logs).toEqual(logs);
    expect(detail.state.toolCalls).toEqual(toolCalls);
  });

  test("replies to pending chat permission requests", async () => {
    const createResponse = await fetch(`${baseUrl}/api/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Permission Reply API",
        workspaceId: testWorkspaceId,
        model: testModel,
        useWorktree: false,
        autoApprovePermissions: false,
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
        message: "Establish the backend connection",
        attachments: [],
      }),
    });
    expect(sendResponse.status).toBe(200);
    const settled = await waitForChatIdle(chatId) as Awaited<ReturnType<typeof loadChat>>;
    expect(settled).not.toBeNull();

    await updateChatState(chatId, {
      ...settled!.state,
      status: "streaming",
      pendingPermissionRequests: [{
        requestId: "permission-api-1",
        sessionId: settled!.state.session?.id ?? "session-1",
        permission: "execute",
        patterns: ["bun test"],
        status: "pending",
        createdAt: new Date().toISOString(),
      }],
    });

    const replyResponse = await fetch(`${baseUrl}/api/chats/${chatId}/permissions/permission-api-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });

    expect(replyResponse.status).toBe(200);
    const replied = await replyResponse.json();
    expect(replied.state.pendingPermissionRequests?.[0]).toMatchObject({
      requestId: "permission-api-1",
      status: "approved",
      decision: "allow",
    });
    expect(mockBackend.getPermissionReplies().at(-1)).toEqual({
      requestId: "permission-api-1",
      response: "once",
    });

    const staleReplyResponse = await fetch(`${baseUrl}/api/chats/${chatId}/permissions/missing-permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    expect(staleReplyResponse.status).toBe(404);
    await expect(staleReplyResponse.json()).resolves.toMatchObject({
      error: "permission_request_not_found",
    });
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

  test("does not checkout the base branch when following up on an established standalone chat", async () => {
    const originalBranch = (await Bun.$`git -C ${testWorkDir} branch --show-current`.text()).trim();
    const selectedBranch = `selected-chat-followup-base-${crypto.randomUUID().slice(0, 8)}`;
    const followupBranch = `selected-chat-followup-current-${crypto.randomUUID().slice(0, 8)}`;
    const dirtyFile = join(testWorkDir, "standalone-chat-dirty.txt");

    await Bun.$`git -C ${testWorkDir} checkout -b ${selectedBranch}`.quiet();
    await Bun.$`git -C ${testWorkDir} checkout ${originalBranch}`.quiet();

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
      const chatId = created.config.id as string;

      const firstSendResponse = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Establish the chat session",
          attachments: [],
        }),
      });
      expect(firstSendResponse.status).toBe(200);
      await waitForChatIdle(chatId);

      await Bun.$`git -C ${testWorkDir} checkout -b ${followupBranch}`.quiet();
      await writeFile(dirtyFile, "dirty working tree\n");

      const followupResponse = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Follow up without changing branches",
          attachments: [],
        }),
      });
      expect(followupResponse.status).toBe(200);
      await waitForChatIdle(chatId);

      const currentBranch = (await Bun.$`git -C ${testWorkDir} branch --show-current`.text()).trim();
      expect(currentBranch).toBe(followupBranch);
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

  test("creates a task-owned default chat that stays out of standalone chat APIs", async () => {
    const taskId = "task-chat-api-test";
    const taskWorkingDirectory = join(testWorkDir, ".clanky-worktrees", taskId);
    await saveTask(createTestTask(taskId, taskWorkingDirectory));

    const createResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/chat`, {
      method: "POST",
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.config.scope).toBe("task");
    expect(created.config.taskId).toBe(taskId);
    expect(created.config.directory).toBe(taskWorkingDirectory);
    expect(created.config.useWorktree).toBe(false);

    const sendResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Stay in the task worktree",
        attachments: [],
      }),
    });
    expect(sendResponse.status).toBe(200);

    await waitForChatIdle(created.config.id as string);
    expect(mockBackend.getDirectory()).toBe(taskWorkingDirectory);

    const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/chat`);
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

  test("spawns a plan-mode task from an existing chat without deleting the chat", async () => {
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
        message: "Turn this debugging conversation into a task plan.",
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

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-task`, {
      method: "POST",
    });
    expect(spawnResponse.status).toBe(201);
    const spawnedTask = await spawnResponse.json();

    expect(spawnedTask.config.id).not.toBe(chatId);
    expect(spawnedTask.config.workspaceId).toBe(testWorkspaceId);
    expect(spawnedTask.config.planMode).toBe(true);
    expect(spawnedTask.config.autoAcceptPlan).toBe(false);
    expect(spawnedTask.config.fullyAutonomous).toBe(false);
    expect(spawnedTask.config.name).toBe("Turn this debugging conversation into a task plan");
    expect(spawnedTask.config.name).not.toContain("Plan from");
    expect(spawnedTask.state.status).toBe("planning");
    expect(spawnedTask.config.prompt).toContain("You are creating a new Clanky plan task from an existing chat conversation.");
    expect(spawnedTask.config.prompt).toContain("Chat title: Spawn Source Chat");
    expect(spawnedTask.config.prompt).toContain("Only the user and assistant messages are included here; tool calls and hidden reasoning are intentionally excluded.");
    expect(spawnedTask.config.prompt).toContain("Turn this debugging conversation into a task plan.");
    expect(spawnedTask.config.prompt).toContain("Hello from chat API");

    const listTasksResponse = await fetch(`${baseUrl}/api/tasks`);
    expect(listTasksResponse.status).toBe(200);
    const tasks = await listTasksResponse.json();
    expect(tasks.some((task: { config: { id: string } }) => task.config.id === spawnedTask.config.id)).toBe(true);

    const chatResponse = await fetch(`${baseUrl}/api/chats/${chatId}`);
    expect(chatResponse.status).toBe(200);
    const chatAfterSpawn = await chatResponse.json();
    expect(
      chatAfterSpawn.state.messages.map((message: { content: string }) => message.content),
    ).toEqual(
      settledChat.state.messages.map((message) => message.content),
    );
  });

  test("rejects spawn-task when the chat transcript is empty", async () => {
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

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${created.config.id}/spawn-task`, {
      method: "POST",
    });

    expect(spawnResponse.status).toBe(400);
    await expect(spawnResponse.json()).resolves.toMatchObject({
      error: "empty_transcript",
      message: "Chat transcript is empty. Send at least one message before spawning a task.",
    });
  });

  test("rejects spawn-task while a chat response is still in progress", async () => {
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

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-task`, {
      method: "POST",
    });

    expect(spawnResponse.status).toBe(409);
    await expect(spawnResponse.json()).resolves.toMatchObject({
      error: "chat_busy",
      message: "Chat is busy",
    });
  });

  test("spawns a task from the chat's current plan", async () => {
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
        message: "Turn this into a plan-ready task.",
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

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-task-from-current-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planFilePath: "plans/seeded-plan.md",
      }),
    });

    expect(spawnResponse.status).toBe(201);
    const spawnedTask = await spawnResponse.json();
    expect(spawnedTask.config.autoAcceptPlan).toBe(false);
    expect(spawnedTask.config.fullyAutonomous).toBe(false);
    expect(spawnedTask.config.name).toBe("Imported plan");
    expect(spawnedTask.config.name).not.toContain("Plan from");
    expect(spawnedTask.state.status).toBe("planning");
    expect(spawnedTask.state.planMode?.isPlanReady).toBe(true);
    expect(spawnedTask.state.planMode?.planContent).toBe("# Imported plan\n\n1. Do the seeded work.");

    const planResponse = await fetch(`${baseUrl}/api/tasks/${spawnedTask.config.id}/plan`);
    expect(planResponse.status).toBe(200);
    await expect(planResponse.json()).resolves.toMatchObject({
      exists: true,
      content: "# Imported plan\n\n1. Do the seeded work.",
    });

    const statusResponse = await fetch(`${baseUrl}/api/tasks/${spawnedTask.config.id}/status-file`);
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
    await mkdir(join(chatWorktreePath, ".clanky-planning"), { recursive: true });
    await writeFile(getPlanFilePath(chatWorktreePath), "# Fallback plan\n\n1. Use the default path.\n");

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-task-from-current-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planFilePath: "   ",
      }),
    });

    expect(spawnResponse.status).toBe(201);
    const spawnedTask = await spawnResponse.json();
    expect(spawnedTask.state.planMode?.planContent).toBe("# Fallback plan\n\n1. Use the default path.");
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

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-task-from-current-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planFilePath: importedPlanPath,
      }),
    });

    expect(spawnResponse.status).toBe(201);
    const spawnedTask = await spawnResponse.json();
    expect(spawnedTask.state.planMode?.planContent).toBe("# External plan\n\n1. Import from an absolute path.");

    const planResponse = await fetch(`${baseUrl}/api/tasks/${spawnedTask.config.id}/plan`);
    expect(planResponse.status).toBe(200);
    await expect(planResponse.json()).resolves.toMatchObject({
      exists: true,
      content: "# External plan\n\n1. Import from an absolute path.",
    });

    const statusResponse = await fetch(`${baseUrl}/api/tasks/${spawnedTask.config.id}/status-file`);
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

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-task-from-current-plan`, {
      method: "POST",
    });

    expect(spawnResponse.status).toBe(400);
    await expect(spawnResponse.json()).resolves.toMatchObject({
      error: "invalid_current_plan",
      message: "No Clanky plan file was found in the current chat workspace.",
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
    await mkdir(join(chatWorktreePath, ".clanky-planning"), { recursive: true });
    await writeFile(getPlanFilePath(chatWorktreePath), "\n<promise>PLAN_READY</promise>\n");

    const spawnResponse = await fetch(`${baseUrl}/api/chats/${chatId}/spawn-task-from-current-plan`, {
      method: "POST",
    });

    expect(spawnResponse.status).toBe(400);
    await expect(spawnResponse.json()).resolves.toMatchObject({
      error: "invalid_current_plan",
      message: "The current Clanky plan file is empty.",
    });
  });
});
