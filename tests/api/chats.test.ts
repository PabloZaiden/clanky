/**
 * API integration tests for chat endpoints.
 * Tests use actual HTTP requests to a test server.
 *
 * Chats are loops with `mode: "chat"`. They share the same DB table,
 * state machine, and post-completion actions (push, merge, accept, discard).
 */

import { test, expect, describe, beforeAll, afterAll, afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serve, type Server } from "bun";
import { apiRoutes } from "../../src/api";
import { ensureDataDirectories } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { loopManager } from "../../src/core/loop-manager";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { createMockBackend, NeverCompletingMockBackend } from "../mocks/mock-backend";

// Default test model for chat creation (model is required)
const testModel = { providerID: "test-provider", modelID: "test-model" };

describe("Chat API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let testWorkspaceId: string;

  // Helper function to poll for loop/chat completion
  async function waitForCompletion(loopId: string, timeoutMs = 10000): Promise<void> {
    const startTime = Date.now();
    let lastStatus = "unknown";
    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/loops/${loopId}`);
      if (response.ok) {
        const data = await response.json();
        lastStatus = data.state?.status ?? "unknown";
        if (lastStatus === "completed" || lastStatus === "failed") {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Chat ${loopId} did not complete within ${timeoutMs}ms. Last status: ${lastStatus}`);
  }

  async function waitForStatus(loopId: string, expectedStatus: string, timeoutMs = 5000): Promise<void> {
    const startTime = Date.now();
    let lastStatus = "unknown";
    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/loops/${loopId}`);
      if (response.ok) {
        const data = await response.json();
        lastStatus = data.state?.status ?? "unknown";
        if (lastStatus === expectedStatus) {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Chat ${loopId} did not reach status ${expectedStatus} within ${timeoutMs}ms. Last status: ${lastStatus}`);
  }

  async function waitForPlanReady(loopId: string, timeoutMs = 10000): Promise<void> {
    const startTime = Date.now();
    let lastStatus = "unknown";
    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/loops/${loopId}`);
      if (response.ok) {
        const data = await response.json();
        lastStatus = data.state?.status ?? "unknown";
        if (data.state?.planMode?.isPlanReady) {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Chat ${loopId} did not produce a ready plan within ${timeoutMs}ms. Last status: ${lastStatus}`);
  }

  // Helper to create or get a workspace for a directory
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
      return data.existingWorkspace.id;
    }

    if (createResponse.ok && data.id) {
      return data.id;
    }

    throw new Error(`Failed to create workspace: ${JSON.stringify(data)}`);
  }

  beforeAll(async () => {
    // Create temp directories
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-api-chat-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "ralpher-api-chat-test-work-"));

    // Set env var for persistence before importing modules
    process.env["RALPHER_DATA_DIR"] = testDataDir;

    // Ensure directories exist
    await ensureDataDirectories();

    // Initialize git repo in test work directory
    await Bun.$`git init ${testWorkDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${testWorkDir}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Initial commit"`.quiet();

    // Set up backend manager with test executor factory
    // Use a mock backend that generates unique loop names to avoid branch name collisions.
    const mockBackend = createMockBackend();
    let nameCounter = 0;
    const originalSendPrompt = mockBackend.sendPrompt.bind(mockBackend);
    mockBackend.sendPrompt = async (sessionId, prompt) => {
      // Check if this is a name generation prompt (contains "Generate a title")
      const promptText = prompt.parts?.map((part) => part.type === "text" ? part.text : "").join("") ?? "";
      if (promptText.includes("Generate a title")) {
        nameCounter++;
        return {
          id: `msg-name-${Date.now()}`,
          content: `chat-test-${nameCounter}`,
          parts: [{ type: "text" as const, text: `chat-test-${nameCounter}` }],
        };
      }
      return originalSendPrompt(sessionId, prompt);
    };
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    // Start test server on random port
    server = serve({
      port: 0, // Random available port
      routes: {
        ...apiRoutes,
      },
    });
    baseUrl = server.url.toString().replace(/\/$/, "");

    // Create a workspace for the testWorkDir
    testWorkspaceId = await getOrCreateWorkspace(testWorkDir, "Test Workspace");
  });

  afterAll(async () => {
    // Stop server
    server.stop();

    // Reset loop manager and backend manager
    loopManager.resetForTesting();
    backendManager.resetForTesting();

    // Cleanup temp directories
    await rm(testDataDir, { recursive: true, force: true });
    await rm(testWorkDir, { recursive: true, force: true });

    // Clear env
    delete process.env["RALPHER_DATA_DIR"];
  });

  // Clean up any active loops/chats before and after each test
  const cleanupActiveLoops = async () => {
    const { listLoops, updateLoopState, loadLoop } = await import("../../src/persistence/loops");

    // Clear all running engines first
    loopManager.resetForTesting();

    const loops = await listLoops();
    const activeStatuses = ["idle", "planning", "starting", "running", "waiting"];

    for (const loop of loops) {
      if (activeStatuses.includes(loop.state.status)) {
        const fullLoop = await loadLoop(loop.config.id);
        if (fullLoop) {
          await updateLoopState(loop.config.id, {
            ...fullLoop.state,
            status: "deleted",
          });
        }
      }
    }
  };

  beforeEach(cleanupActiveLoops);
  afterEach(cleanupActiveLoops);

  describe("POST /api/loops/chat - Create Chat", () => {
    test("creates a new chat with required fields", async () => {
      const response = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "What files are in this repo?",
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.config.mode).toBe("chat");
      expect(body.config.prompt).toBe("What files are in this repo?");
      expect(body.config.directory).toBe(testWorkDir);
      expect(body.config.id).toBeDefined();
      // Chats are auto-started on creation
      expect(["starting", "running", "completed"]).toContain(body.state.status);
    });

    test("creates a chat with optional git config", async () => {
      const response = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Tell me about the codebase",
          model: testModel,
          useWorktree: true,
          git: { branchPrefix: "chat" },
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.config.mode).toBe("chat");
      expect(body.config.git.branchPrefix).toBe("chat/");
    });

    test("returns 400 for missing workspaceId", async () => {
      const response = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Hello",
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("validation_error");
    });

    test("returns 400 for empty prompt", async () => {
      const response = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "",
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("validation_error");
      expect(body.message).toContain("prompt");
    });

    test("returns 400 for missing prompt", async () => {
      const response = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("validation_error");
    });

    test("returns 400 for invalid JSON", async () => {
      const response = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_json");
    });

    test("returns 404 for non-existent workspace", async () => {
      const response = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "non-existent-workspace-id",
          prompt: "Hello",
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("workspace_not_found");
    });
  });

  describe("POST /api/loops/:id/chat - Send Chat Message", () => {
    test("sends a message to a completed chat", async () => {
      // Create a chat and wait for its first turn to complete
      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Hello",
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const chatBody = await createResponse.json();
      const chatId = chatBody.config.id;

      // Wait for first turn to complete
      await waitForCompletion(chatId);

      // Send a follow-up message
      const messageResponse = await fetch(`${baseUrl}/api/loops/${chatId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Can you elaborate?",
        }),
      });

      expect(messageResponse.status).toBe(200);
      const messageBody = await messageResponse.json();
      expect(messageBody.success).toBe(true);
      expect(messageBody.loopId).toBe(chatId);
    });

    test("returns 400 for empty message", async () => {
      // Create a chat
      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Hello",
          model: testModel,
          useWorktree: true,
        }),
      });
      const chatBody = await createResponse.json();
      const chatId = chatBody.config.id;

      await waitForCompletion(chatId);

      // Try to send empty message
      const messageResponse = await fetch(`${baseUrl}/api/loops/${chatId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "",
        }),
      });

      expect(messageResponse.status).toBe(400);
      const body = await messageResponse.json();
      expect(body.error).toBe("validation_error");
    });

    test("returns 400 for whitespace-only message", async () => {
      // Create a chat
      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Hello",
          model: testModel,
          useWorktree: true,
        }),
      });
      const chatBody = await createResponse.json();
      const chatId = chatBody.config.id;

      await waitForCompletion(chatId);

      // Try to send whitespace-only message
      const messageResponse = await fetch(`${baseUrl}/api/loops/${chatId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "   ",
        }),
      });

      expect(messageResponse.status).toBe(400);
      const body = await messageResponse.json();
      expect(body.error).toBe("validation_error");
    });

    test("returns 400 for missing message field", async () => {
      // Create a chat
      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Hello",
          model: testModel,
          useWorktree: true,
        }),
      });
      const chatBody = await createResponse.json();
      const chatId = chatBody.config.id;

      await waitForCompletion(chatId);

      // Try to send without message field
      const messageResponse = await fetch(`${baseUrl}/api/loops/${chatId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(messageResponse.status).toBe(400);
      const body = await messageResponse.json();
      expect(body.error).toBe("validation_error");
    });

    test("returns 404 for non-existent chat", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent-id/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Hello",
        }),
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("not_found");
    });

    test("returns 400 for invalid JSON", async () => {
      // Create a chat first
      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Hello",
          model: testModel,
          useWorktree: true,
        }),
      });
      const chatBody = await createResponse.json();
      const chatId = chatBody.config.id;

      await waitForCompletion(chatId);

      const response = await fetch(`${baseUrl}/api/loops/${chatId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_json");
    });

    test("rejects sending message to a loop (not a chat)", async () => {
      // Create a regular loop (not a chat)
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Build something",
          name: "Test Loop",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const loopBody = await createResponse.json();
      const loopId = loopBody.config.id;

      await waitForCompletion(loopId);

      // Try to send a chat message to a loop
      const messageResponse = await fetch(`${baseUrl}/api/loops/${loopId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Hello",
        }),
      });

      expect(messageResponse.status).toBe(400);
      const body = await messageResponse.json();
      expect(body.error).toBe("not_chat");
    });

    test("stops the active chat turn before accepting a follow-up message", async () => {
      let abortCalls = 0;
      const backend = new NeverCompletingMockBackend({
        supportsActivePromptQueueing: true,
      });
      backend.abortSession = async (): Promise<void> => {
        abortCalls += 1;
      };
      backendManager.setBackendForTesting(backend);

      try {
        const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: testWorkspaceId,
            prompt: "Start a long running chat",
            model: testModel,
            useWorktree: true,
          }),
        });
        expect(createResponse.status).toBe(201);
        const chatBody = await createResponse.json();
        const chatId = chatBody.config.id;

        await waitForStatus(chatId, "running");

        const messageResponse = await fetch(`${baseUrl}/api/loops/${chatId}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "Please stop and do this instead",
          }),
        });

        expect(messageResponse.status).toBe(200);
        expect(abortCalls).toBe(1);

        const startTime = Date.now();
        let followUpPersisted = false;

        while (Date.now() - startTime < 5000) {
          const persistedResponse = await fetch(`${baseUrl}/api/loops/${chatId}`);
          expect(persistedResponse.status).toBe(200);
          const persistedChat = await persistedResponse.json();
          const messages = persistedChat.state.messages ?? [];
          followUpPersisted = messages.some(
            (message: { role?: string; content?: string }) =>
              message.role === "user" && message.content === "Please stop and do this instead",
          );
          if (followUpPersisted) {
            expect(persistedChat.state.pendingPrompt).toBeUndefined();
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(followUpPersisted).toBe(true);

        await loopManager.stopLoop(chatId);
      } finally {
        backendManager.setBackendForTesting(createMockBackend());
      }
    });
  });

  describe("POST /api/loops/:id/stop", () => {
    test("stops a running chat without deleting it", async () => {
      let abortCalls = 0;
      const backend = new NeverCompletingMockBackend();
      backend.abortSession = async (): Promise<void> => {
        abortCalls += 1;
      };
      backendManager.setBackendForTesting(backend);

      try {
        const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: testWorkspaceId,
            prompt: "Keep running until stopped",
            model: testModel,
            useWorktree: true,
          }),
        });
        expect(createResponse.status).toBe(201);
        const chatBody = await createResponse.json();
        const chatId = chatBody.config.id;

        await waitForStatus(chatId, "running");

        const stopResponse = await fetch(`${baseUrl}/api/loops/${chatId}/stop`, {
          method: "POST",
        });

        expect(stopResponse.status).toBe(200);
        const body = await stopResponse.json();
        expect(body.success).toBe(true);
        expect(body.loopId).toBe(chatId);
        expect(abortCalls).toBe(1);

        const loopResponse = await fetch(`${baseUrl}/api/loops/${chatId}`);
        const loopData = await loopResponse.json();
        expect(loopData.state.status).toBe("stopped");
      } finally {
        backendManager.setBackendForTesting(createMockBackend());
      }
    });

    test("returns 409 when the loop exists but is not running", async () => {
      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Short chat",
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const chatBody = await createResponse.json();
      const chatId = chatBody.config.id;

      await waitForCompletion(chatId);

      const stopResponse = await fetch(`${baseUrl}/api/loops/${chatId}/stop`, {
        method: "POST",
      });

      expect(stopResponse.status).toBe(409);
      const body = await stopResponse.json();
      expect(body.error).toBe("not_running");
    });

    test("returns 404 for a non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent-id/stop`, {
        method: "POST",
      });

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe("not_found");
    });
  });

  describe("GET /api/loops?mode= - Mode Filtering", () => {
    test("filters loops by mode=chat", async () => {
      // Create a chat
      const chatResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Chat message",
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(chatResponse.status).toBe(201);
      const chatBody = await chatResponse.json();
      await waitForCompletion(chatBody.config.id);

      // List with mode=chat filter
      const response = await fetch(`${baseUrl}/api/loops?mode=chat`);
      expect(response.status).toBe(200);
      const loops = await response.json();
      expect(Array.isArray(loops)).toBe(true);
      // All returned loops should be chats
      for (const loop of loops) {
        expect(loop.config.mode).toBe("chat");
      }
      // Should include the chat we just created
      expect(loops.some((l: { config: { id: string } }) => l.config.id === chatBody.config.id)).toBe(true);
    });

    test("filters loops by mode=loop", async () => {
      // Create a regular loop
      const loopResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Loop task",
          name: "Test Loop",
          planMode: false,
          draft: true,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(loopResponse.status).toBe(201);
      const loopBody = await loopResponse.json();

      // List with mode=loop filter
      const response = await fetch(`${baseUrl}/api/loops?mode=loop`);
      expect(response.status).toBe(200);
      const loops = await response.json();
      expect(Array.isArray(loops)).toBe(true);
      // All returned loops should be regular loops
      for (const loop of loops) {
        expect(loop.config.mode).toBe("loop");
      }
      // Should include the loop we just created
      expect(loops.some((l: { config: { id: string } }) => l.config.id === loopBody.config.id)).toBe(true);
    });

    test("returns all loops without mode filter", async () => {
      // List without filter
      const response = await fetch(`${baseUrl}/api/loops`);
      expect(response.status).toBe(200);
      const loops = await response.json();
      expect(Array.isArray(loops)).toBe(true);
      // Should include both modes (from previous tests)
      const modes = new Set(loops.map((l: { config: { mode: string } }) => l.config.mode));
      expect(modes.has("chat")).toBe(true);
      expect(modes.has("loop")).toBe(true);
    });

    test("ignores invalid mode filter value", async () => {
      // Invalid mode should return all loops (no filtering)
      const response = await fetch(`${baseUrl}/api/loops?mode=invalid`);
      expect(response.status).toBe(200);
      const loops = await response.json();
      expect(Array.isArray(loops)).toBe(true);
      // Should return all loops since 'invalid' is not 'loop' or 'chat'
      expect(loops.length).toBeGreaterThan(0);
    });
  });

  describe("Existing loop endpoints work for chats", () => {
    test("GET /api/loops/:id returns a chat", async () => {
      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Hello",
          model: testModel,
          useWorktree: true,
        }),
      });
      const chatBody = await createResponse.json();
      const chatId = chatBody.config.id;

      await waitForCompletion(chatId);

      const getResponse = await fetch(`${baseUrl}/api/loops/${chatId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.config.id).toBe(chatId);
      expect(getBody.config.mode).toBe("chat");
      expect(getBody.state.status).toBe("completed");
    });

    test("DELETE /api/loops/:id deletes a chat", async () => {
      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Delete me",
          model: testModel,
          useWorktree: true,
        }),
      });
      const chatBody = await createResponse.json();
      const chatId = chatBody.config.id;

      await waitForCompletion(chatId);

      // Delete the chat
      const deleteResponse = await fetch(`${baseUrl}/api/loops/${chatId}`, {
        method: "DELETE",
      });
      expect(deleteResponse.status).toBe(200);

      // Verify it's soft-deleted
      const getResponse = await fetch(`${baseUrl}/api/loops/${chatId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.state.status).toBe("deleted");
    });

    test("PATCH /api/loops/:id renames a chat", async () => {
      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Rename me",
          model: testModel,
          useWorktree: true,
        }),
      });
      const chatBody = await createResponse.json();
      const chatId = chatBody.config.id;

      await waitForCompletion(chatId);

      // Rename the chat
      const renameResponse = await fetch(`${baseUrl}/api/loops/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "My Renamed Chat" }),
      });
      expect(renameResponse.status).toBe(200);
      const renameBody = await renameResponse.json();
      expect(renameBody.config.name).toBe("My Renamed Chat");
    });

    test("POST /api/loops/:id/discard discards a chat", async () => {
      // Use unique directory to avoid branch collisions
      const uniqueWorkDir = await mkdtemp(join(tmpdir(), "ralpher-chat-discard-test-"));
      await Bun.$`git init ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();

      try {
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Discard me",
            model: testModel,
            useWorktree: true,
          }),
        });
        expect(createResponse.status).toBe(201);
        const chatBody = await createResponse.json();
        const chatId = chatBody.config.id;

        await waitForCompletion(chatId);

        // Discard the chat
        const discardResponse = await fetch(`${baseUrl}/api/loops/${chatId}/discard`, {
          method: "POST",
        });
        expect(discardResponse.status).toBe(200);
        const discardBody = await discardResponse.json();
        expect(discardBody.success).toBe(true);
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("POST /api/loops/:id/mark-merged marks a completed chat as merged", async () => {
      // Use unique directory to avoid branch collisions
      const uniqueWorkDir = await mkdtemp(join(tmpdir(), "ralpher-chat-merged-test-"));
      await Bun.$`git init ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();

      try {
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Mark me merged",
            model: testModel,
            useWorktree: true,
          }),
        });
        expect(createResponse.status).toBe(201);
        const chatBody = await createResponse.json();
        const chatId = chatBody.config.id;

        await waitForCompletion(chatId);

        // Mark as merged
        const mergedResponse = await fetch(`${baseUrl}/api/loops/${chatId}/mark-merged`, {
          method: "POST",
        });
        expect(mergedResponse.status).toBe(200);
        const mergedBody = await mergedResponse.json();
        expect(mergedBody.success).toBe(true);

        // Verify status is merged
        const getResponse = await fetch(`${baseUrl}/api/loops/${chatId}`);
        const getBody = await getResponse.json();
        expect(getBody.state.status).toBe("merged");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });
  });

  describe("Chat lifecycle", () => {
    test("chat config has correct default values", async () => {
      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Check defaults",
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const body = await createResponse.json();

      // Chat-specific defaults
      expect(body.config.mode).toBe("chat");
      expect(body.config.planMode).toBe(false);
      expect(body.config.maxIterations).toBe(1);
    });

    test("chat completes its first turn and reaches completed status", async () => {
      // Use unique directory to avoid branch collisions
      const uniqueWorkDir = await mkdtemp(join(tmpdir(), "ralpher-chat-lifecycle-test-"));
      await Bun.$`git init ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();

      try {
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Tell me about this repo",
            model: testModel,
            useWorktree: true,
          }),
        });
        expect(createResponse.status).toBe(201);
        const chatBody = await createResponse.json();
        const chatId = chatBody.config.id;

        // Wait for first turn to complete
        await waitForCompletion(chatId);

        // Verify the chat is in completed status (waiting for next message)
        const getResponse = await fetch(`${baseUrl}/api/loops/${chatId}`);
        const getBody = await getResponse.json();
        expect(getBody.state.status).toBe("completed");
        expect(getBody.config.mode).toBe("chat");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });
  });

  describe("POST /api/loops/:id/follow-up", () => {
    test("restarts a stopped chat", async () => {
      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Hello",
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const chatBody = await createResponse.json();
      const chatId = chatBody.config.id;

      await waitForCompletion(chatId);

      await loopManager.stopLoop(chatId);

      const followUpResponse = await fetch(`${baseUrl}/api/loops/${chatId}/follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Please continue",
        }),
      });

      expect(followUpResponse.status).toBe(200);
      const followUpBody = await followUpResponse.json();
      expect(followUpBody.success).toBe(true);

      await waitForCompletion(chatId);
    });

    test("revives a deleted chat before purge", async () => {
      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Hello",
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const chatBody = await createResponse.json();
      const chatId = chatBody.config.id;

      await waitForCompletion(chatId);

      const deleteResponse = await fetch(`${baseUrl}/api/loops/${chatId}`, {
        method: "DELETE",
      });
      expect(deleteResponse.status).toBe(200);

      const followUpResponse = await fetch(`${baseUrl}/api/loops/${chatId}/follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Please revive this chat",
        }),
      });

      expect(followUpResponse.status).toBe(200);
      const followUpBody = await followUpResponse.json();
      expect(followUpBody.success).toBe(true);

      await waitForCompletion(chatId);
    });
  });

  describe("POST /api/loops/:id/chat/convert-to-loop", () => {
    test("converts a completed chat into a planning loop while preserving the session", async () => {
      backendManager.setBackendForTesting(createMockBackend([
        "<promise>COMPLETE</promise>",
        "Planning... <promise>PLAN_READY</promise>",
      ]));

      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Help me turn this discussion into a concrete implementation plan",
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const chatBody = await createResponse.json();
      const chatId = chatBody.config.id;

      await waitForCompletion(chatId);

      const beforeConvertResponse = await fetch(`${baseUrl}/api/loops/${chatId}`);
      const beforeConvertLoop = await beforeConvertResponse.json();
      const originalSessionId = beforeConvertLoop.state.session?.id;

      const convertResponse = await fetch(`${baseUrl}/api/loops/${chatId}/chat/convert-to-loop`, {
        method: "POST",
      });

      expect(convertResponse.status).toBe(200);
      const convertedLoop = await convertResponse.json();
      expect(convertedLoop.config.id).toBe(chatId);
      expect(convertedLoop.config.mode).toBe("loop");
      expect(convertedLoop.state.status).toBe("planning");
      expect(convertedLoop.state.session?.id).toBe(originalSessionId);
      expect(convertedLoop.state.planMode?.planSessionId).toBe(originalSessionId);
      expect(convertedLoop.config.prompt).toContain("Original chat prompt:");
      expect(convertedLoop.config.prompt).toContain("Recent chat transcript:");

      await waitForPlanReady(chatId);

      const planningResponse = await fetch(`${baseUrl}/api/loops/${chatId}`);
      const planningLoop = await planningResponse.json();
      expect(planningLoop.config.mode).toBe("loop");
      expect(planningLoop.state.status).toBe("planning");
      expect(planningLoop.state.planMode?.isPlanReady).toBe(true);
      expect(planningLoop.state.session?.id).toBe(originalSessionId);
    });

    test("returns 409 when a completed chat has no usable history for plan generation", async () => {
      backendManager.setBackendForTesting(createMockBackend([
        "<promise>COMPLETE</promise>",
      ]));

      const createResponse = await fetch(`${baseUrl}/api/loops/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Create a temporary chat that will be scrubbed before conversion",
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const chatBody = await createResponse.json();
      const chatId = chatBody.config.id;

      await waitForCompletion(chatId);

      const { loadLoop, updateLoopConfig, updateLoopState } = await import("../../src/persistence/loops");
      const persistedChat = await loadLoop(chatId);
      expect(persistedChat).toBeDefined();

      await updateLoopConfig(chatId, {
        ...persistedChat!.config,
        prompt: "   ",
      });
      await updateLoopState(chatId, {
        ...persistedChat!.state,
        messages: [],
      });
      loopManager.resetForTesting();

      const convertResponse = await fetch(`${baseUrl}/api/loops/${chatId}/chat/convert-to-loop`, {
        method: "POST",
      });

      expect(convertResponse.status).toBe(409);
      const errorBody = await convertResponse.json();
      expect(errorBody.error).toBe("missing_chat_history");
      expect(errorBody.message).toContain("no chat history");
    });
  });
});
