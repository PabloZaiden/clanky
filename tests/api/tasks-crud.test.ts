/**
 * API integration tests for tasks CRUD endpoints.
 * Tests use actual HTTP requests to a test server.
 */

import { test, expect, describe, beforeAll, afterAll, afterEach, beforeEach, mock } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serve, type Server } from "bun";
import { apiRoutes } from "../../src/api";
import { ensureDataDirectories } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { taskManager } from "../../src/core/task-manager";
import { TestCommandExecutor } from "../mocks/mock-executor";
import packageJson from "../../package.json";
import { createMockBackend } from "../mocks/mock-backend";
import { updateTaskState } from "../../src/persistence/tasks";
import type { TaskLogEntry, PersistedMessage, PersistedToolCall } from "../../src/types";

// Default test model for task creation (model is now required)
const testModel = { providerID: "test-provider", modelID: "test-model", variant: "" };
const baseCreateTaskPayload = {
  attachments: [],
  cheapModel: { mode: "same-as-task" as const },
  maxIterations: null,
  maxConsecutiveErrors: 10,
  activityTimeoutSeconds: 300,
  stopPattern: "<promise>COMPLETE</promise>$",
  git: {
    branchPrefix: "",
    commitScope: "",
  },
  baseBranch: "main",
  clearPlanningFolder: false,
  autoAcceptPlan: false,
  fullyAutonomous: false,
  draft: false,
};

describe("Tasks CRUD API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let testWorkspaceId: string;
  let mockBackend: ReturnType<typeof createMockBackend>;

  // Helper function to poll for task completion
  async function waitForTaskCompletion(taskId: string, timeoutMs = 10000): Promise<void> {
    const startTime = Date.now();
    let lastStatus = "unknown";
    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      if (response.ok) {
        const data = await response.json();
        lastStatus = data.state?.status ?? "unknown";
        if (lastStatus === "completed" || lastStatus === "failed") {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Task ${taskId} did not complete within ${timeoutMs}ms. Last status: ${lastStatus}`);
  }

  // Helper to create or get a workspace for a directory
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
      return data.existingWorkspace.id;
    }
    
    if (createResponse.ok && data.id) {
      return data.id;
    }
    
    throw new Error(`Failed to create workspace: ${JSON.stringify(data)}`);
  }

  beforeAll(async () => {
    // Create temp directories
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-api-crud-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "clanky-api-crud-test-work-"));

    // Set env var for persistence before importing modules
    process.env["CLANKY_DATA_DIR"] = testDataDir;

    // Ensure directories exist
    await ensureDataDirectories();

    // Initialize git repo in test work directory
    await Bun.$`git init -b main ${testWorkDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${testWorkDir}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Initial commit"`.quiet();

    // Set up backend manager with test executor factory.
    // The mocked backend is also used by the explicit title-generation endpoint tests.
    mockBackend = createMockBackend();
    let nameCounter = 0;
    const originalSendPrompt = mockBackend.sendPrompt.bind(mockBackend);
    mockBackend.sendPrompt = async (sessionId, prompt) => {
      // Check if this is a name generation prompt (contains "Generate a title")
      const promptText = prompt.parts?.map((part) => part.type === "text" ? part.text : "").join("") ?? "";
      if (promptText.includes("Generate a title")) {
        nameCounter++;
        return {
          id: `msg-name-${Date.now()}`,
          content: `crud-test-task-${nameCounter}`,
          parts: [{ type: "text" as const, text: `crud-test-task-${nameCounter}` }],
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

    // Reset backend manager
    backendManager.resetForTesting();

    // Cleanup temp directories
    await rm(testDataDir, { recursive: true, force: true });
    await rm(testWorkDir, { recursive: true, force: true });

    // Clear env
    delete process.env["CLANKY_DATA_DIR"];
  });

  // Clean up any active tasks BEFORE each test to prevent blocking
  const cleanupActiveTasks = async () => {
    const { listTasks, updateTaskState, loadTask } = await import("../../src/persistence/tasks");
    const { taskManager } = await import("../../src/core/task-manager");
    
    // Clear all running engines first
    taskManager.resetForTesting();
    
    const tasks = await listTasks();
    const activeStatuses = ["idle", "planning", "starting", "running", "waiting", "resolving_conflicts"];
    
    for (const task of tasks) {
      if (activeStatuses.includes(task.state.status)) {
        // Load full task to get current state
        const fullTask = await loadTask(task.config.id);
        if (fullTask) {
          // Mark as deleted to make it a terminal state
          await updateTaskState(task.config.id, {
            ...fullTask.state,
            status: "deleted",
          });
        }
      }
    }
  };

  // Clean up before and after each test
  beforeEach(cleanupActiveTasks);
  afterEach(cleanupActiveTasks);

  describe("GET /api/health", () => {
    test("returns healthy status", async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.healthy).toBe(true);
      expect(body.version).toBe(packageJson.version);
    });
  });

  describe("POST /api/tasks", () => {
    test("creates a new task with required fields and preserves the provided name", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Build something",
          name: "Test Task",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.config.name).toBe("Test Task");
      expect(body.config.directory).toBe(testWorkDir);
      expect(body.config.prompt).toBe("Build something");
      expect(body.config.id).toBeDefined();
      // Tasks are auto-started on creation, so status should not be idle
      expect(["starting", "running", "completed"]).toContain(body.state.status);
    });

    test("creates a task with optional fields", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Custom task",
          name: "Test Task",
          maxIterations: 10,
          stopPattern: "<done>FINISHED</done>$",
          git: { branchPrefix: "custom", commitScope: "" },
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.config.maxIterations).toBe(10);
      expect(body.config.stopPattern).toBe("<done>FINISHED</done>$");
      expect(body.config.git.branchPrefix).toBe("custom/");
    });

    test("defaults activity timeout to unlimited when omitted", async () => {
      const { activityTimeoutSeconds: _activityTimeoutSeconds, ...payloadWithoutTimeout } = baseCreateTaskPayload;
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payloadWithoutTimeout,
          workspaceId: testWorkspaceId,
          prompt: "Use the default timeout",
          name: "Unlimited Timeout Task",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.config.activityTimeoutSeconds).toBeNull();
    });

    test("creates a fully autonomous plan task and forces auto-accept", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Plan it and take it all the way through PR automation",
          name: "Fully Autonomous Task",
          planMode: true,
          autoAcceptPlan: false,
          fullyAutonomous: true,
          model: testModel,
          useWorktree: true,
          draft: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.config.planMode).toBe(true);
      expect(body.config.fullyAutonomous).toBe(true);
      expect(body.config.autoAcceptPlan).toBe(true);
    });

    test("returns 400 for invalid JSON", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_json");
    });

    test("returns 400 for missing required fields", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          prompt: "Missing workspaceId",
          planMode: false,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("validation_error");
    });

    test("returns 400 for empty prompt", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "",
          name: "Test Task",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("validation_error");
      expect(body.message).toContain("prompt");
    });

    test("returns 400 for empty name", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          name: "   ",
          prompt: "Build something",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("validation_error");
      expect(body.message).toContain("name");
    });

    test("returns 400 for name longer than 100 characters", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          name: "a".repeat(101),
          prompt: "Build something",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("validation_error");
      expect(body.message).toContain("100");
    });
  });

  describe("GET /api/tasks", () => {
    test("lists tasks without hydrating transcript payloads", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Persist large task content",
          name: "Task List Summary Test",
          planMode: true,
          model: testModel,
          useWorktree: true,
          draft: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();
      const timestamp = new Date().toISOString();
      const messages: PersistedMessage[] = [{
        id: "message-1",
        role: "assistant",
        content: "Large task transcript content that should not be returned by the list endpoint",
        timestamp,
      }];
      const logs: TaskLogEntry[] = [{
        id: "log-1",
        level: "agent",
        message: "Large task log content that should not be returned by the list endpoint",
        timestamp,
      }];
      const toolCalls: PersistedToolCall[] = [{
        id: "tool-1",
        name: "Read",
        input: { filePath: "src/index.ts" },
        output: { content: "Large task tool output that should not be returned by the list endpoint" },
        status: "completed",
        timestamp,
      }];

      const updated = await updateTaskState(created.config.id as string, {
        ...created.state,
        status: "planning",
        currentIteration: 1,
        messages,
        logs,
        toolCalls,
        lastActivityAt: timestamp,
        planMode: {
          active: true,
          feedbackRounds: 1,
          planContent: "Large plan content that should not be returned by the list endpoint",
          planningFolderCleared: true,
          isPlanReady: true,
        },
      });
      expect(updated).not.toBeNull();

      const listResponse = await fetch(`${baseUrl}/api/tasks`);
      expect(listResponse.status).toBe(200);
      const listedTasks = await listResponse.json();
      const listed = listedTasks.find((task: { config: { id: string } }) => task.config.id === created.config.id);
      expect(listed).toBeDefined();
      expect(listed.state.messages).toEqual([]);
      expect(listed.state.logs).toEqual([]);
      expect(listed.state.toolCalls).toEqual([]);
      expect(listed.state.planMode.isPlanReady).toBe(true);
      expect(listed.state.planMode.planContent).toBeUndefined();

      const detailResponse = await fetch(`${baseUrl}/api/tasks/${created.config.id}`);
      expect(detailResponse.status).toBe(200);
      const detail = await detailResponse.json();
      expect(detail.state.messages).toEqual(messages);
      expect(detail.state.logs).toEqual(logs);
      expect(detail.state.toolCalls).toEqual(toolCalls);
      expect(detail.state.planMode.planContent).toBe("Large plan content that should not be returned by the list endpoint");
    });

    test("lists active-engine tasks without hydrating transcript payloads", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Keep active engine payload lightweight",
          name: "Active Engine Summary Test",
          planMode: true,
          model: testModel,
          useWorktree: true,
          draft: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();
      const timestamp = new Date().toISOString();
      const activeState = {
        ...created.state,
        status: "running" as const,
        currentIteration: 1,
        messages: [{
          id: "active-message-1",
          role: "assistant" as const,
          content: "Active engine transcript content that should not be returned by the list endpoint",
          timestamp,
        }],
        logs: [{
          id: "active-log-1",
          level: "agent" as const,
          message: "Active engine log content that should not be returned by the list endpoint",
          timestamp,
        }],
        toolCalls: [{
          id: "active-tool-1",
          name: "Read",
          input: { filePath: "src/index.ts" },
          output: { content: "Active engine tool output that should not be returned by the list endpoint" },
          status: "completed" as const,
          timestamp,
        }],
        planMode: {
          active: true,
          feedbackRounds: 1,
          planContent: "Active engine plan content that should not be returned by the list endpoint",
          planningFolderCleared: true,
          isPlanReady: true,
        },
      };

      const engineMap = (taskManager as unknown as {
        engines: Map<string, { config: typeof created.config; state: typeof activeState }>;
      }).engines;
      engineMap.set(created.config.id as string, {
        config: created.config,
        state: activeState,
      });

      const listResponse = await fetch(`${baseUrl}/api/tasks`);
      expect(listResponse.status).toBe(200);
      const listedTasks = await listResponse.json();
      const listed = listedTasks.find((task: { config: { id: string } }) => task.config.id === created.config.id);
      expect(listed).toBeDefined();
      expect(listed.state.messages).toEqual([]);
      expect(listed.state.logs).toEqual([]);
      expect(listed.state.toolCalls).toEqual([]);
      expect(listed.state.planMode.isPlanReady).toBe(true);
      expect(listed.state.planMode.planContent).toBeUndefined();

      const detailResponse = await fetch(`${baseUrl}/api/tasks/${created.config.id}`);
      expect(detailResponse.status).toBe(200);
      const detail = await detailResponse.json();
      expect(detail.state.messages).toEqual(activeState.messages);
      expect(detail.state.logs).toEqual(activeState.logs);
      expect(detail.state.toolCalls).toEqual(activeState.toolCalls);
      expect(detail.state.planMode.planContent).toBe("Active engine plan content that should not be returned by the list endpoint");
    });
  });

  describe("POST /api/tasks/title", () => {
    test("generates a title explicitly from prompt and workspace", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Build something",
          model: testModel,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe("crud-test-task-1");
    });

    test("connects the backend before explicit title generation", async () => {
      const strictBackend = createMockBackend(["connected-title"]);
      const originalConnect = strictBackend.connect.bind(strictBackend);
      strictBackend.connect = mock(async (config, signal) => originalConnect(config, signal));
      const originalCreateSession = strictBackend.createSession.bind(strictBackend);
      strictBackend.createSession = mock(async (options) => {
        if (!strictBackend.isConnected()) {
          throw new Error("Not connected. Call connect() first.");
        }
        return originalCreateSession(options);
      });
      backendManager.resetForTesting();
      backendManager.setBackendForTesting(strictBackend);
      backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

      const response = await fetch(`${baseUrl}/api/tasks/title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Build something",
          model: testModel,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe("connected-title");
      expect(strictBackend.connect).toHaveBeenCalledTimes(1);

      backendManager.resetForTesting();
      backendManager.setBackendForTesting(mockBackend);
      backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
    });

    test("surfaces backend failures without fallback titles", async () => {
      const failingBackend = createMockBackend();
      failingBackend.sendPrompt = async () => {
        throw new Error("backend unavailable");
      };
      backendManager.setBackendForTesting(failingBackend);

      const response = await fetch(`${baseUrl}/api/tasks/title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Build something",
          model: testModel,
        }),
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("title_generation_failed");
      expect(body.message).toContain("Failed to generate task title");

      backendManager.setBackendForTesting(mockBackend);
    });
  });

  describe("GET /api/tasks", () => {
    test("returns array of tasks", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
      // Should have tasks from previous tests
      expect(body.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/tasks/:id", () => {
    test("returns a specific task", async () => {
      // First create a draft task (to avoid active task conflicts)
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test prompt",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Then get it
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.config.id).toBe(taskId);
    });

    test("returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent-id`);
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe("not_found");
    });
  });

  describe("PATCH /api/tasks/:id", () => {
    test("updates a task", async () => {
      // First create a draft task (to avoid active task conflicts)
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Original prompt",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Update the task
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Updated prompt",
          git: {
            branchPrefix: "team platform",
            commitScope: "",
          },
        }),
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.config.prompt).toBe("Updated prompt");
      expect(body.config.git.branchPrefix).toBe("team-platform/");
    });

    test("clears fully autonomous settings when plan mode is disabled", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Original prompt",
          name: "Autonomous Draft",
          draft: true,
          planMode: true,
          autoAcceptPlan: true,
          fullyAutonomous: true,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planMode: false,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.config.planMode).toBe(false);
      expect(body.config.autoAcceptPlan).toBe(false);
      expect(body.config.fullyAutonomous).toBe(false);
    });

    test("allows updating planning automation flags while plan mode is actively running", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Plan something carefully",
          name: "Planning Task",
          draft: false,
          planMode: true,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;
      expect(createBody.state.status).toBe("planning");

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullyAutonomous: true,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.config.fullyAutonomous).toBe(true);
      expect(body.config.autoAcceptPlan).toBe(true);

      const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      expect(getResponse.status).toBe(200);
      const updatedTask = await getResponse.json();
      expect(updatedTask.config.fullyAutonomous).toBe(true);
      expect(updatedTask.config.autoAcceptPlan).toBe(true);
    });

    test("rejects task config updates while a live engine is resolving conflicts", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Plan something carefully",
          name: "Conflict Task",
          draft: false,
          planMode: true,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      const { taskManager } = await import("../../src/core/task-manager");
      const liveTask = await taskManager.getTask(taskId);
      expect(liveTask).not.toBeNull();
      liveTask!.state.status = "resolving_conflicts";

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Updated conflict prompt",
        }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("active_task_update_restricted");
      expect(body.message).toContain("Cannot update an active task. Stop it first.");
    });

    test("preserves live engine config when updating planning automation flags", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Plan something carefully",
          name: "Runtime Config Task",
          draft: false,
          planMode: true,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      const { taskManager } = await import("../../src/core/task-manager");
      const liveTask = await taskManager.getTask(taskId);
      expect(liveTask).not.toBeNull();
      liveTask!.config.cheapModel = {
        mode: "custom",
        model: {
          providerID: "runtime-provider",
          modelID: "runtime-cheap-model",
          variant: "",
        },
      };

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullyAutonomous: true,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.config.fullyAutonomous).toBe(true);
      expect(body.config.autoAcceptPlan).toBe(true);
      expect(body.config.cheapModel).toEqual({
        mode: "custom",
        model: {
          providerID: "runtime-provider",
          modelID: "runtime-cheap-model",
          variant: "",
        },
      });

      const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      expect(getResponse.status).toBe(200);
      const updatedTask = await getResponse.json();
      expect(updatedTask.config.cheapModel).toEqual({
        mode: "custom",
        model: {
          providerID: "runtime-provider",
          modelID: "runtime-cheap-model",
          variant: "",
        },
      });
    });

    test("allows fully autonomous updates after plan approval while execution is in progress", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Plan something carefully",
          name: "Approved Plan Task",
          draft: false,
          planMode: true,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      const { taskManager } = await import("../../src/core/task-manager");
      const liveTask = await taskManager.getTask(taskId);
      expect(liveTask).not.toBeNull();
      liveTask!.state.status = "running";
      liveTask!.state.planMode = {
        ...(liveTask!.state.planMode ?? {
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: true,
        }),
        active: false,
        isPlanReady: true,
      };

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullyAutonomous: true,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.config.fullyAutonomous).toBe(true);
      expect(body.config.autoAcceptPlan).toBe(true);
      expect(body.state.fullyAutonomousPending).toBe(true);
    });

    test("rejects unrelated updates after plan approval while execution is in progress", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Plan something carefully",
          name: "Approved Plan Restrictions Task",
          draft: false,
          planMode: true,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      const { taskManager } = await import("../../src/core/task-manager");
      const liveTask = await taskManager.getTask(taskId);
      expect(liveTask).not.toBeNull();
      liveTask!.state.status = "running";
      liveTask!.state.planMode = {
        ...(liveTask!.state.planMode ?? {
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: true,
        }),
        active: false,
        isPlanReady: true,
      };

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Updated execution prompt",
        }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("plan_execution_update_restricted");
      expect(body.message).toContain("After plan approval, only the fully autonomous setting can be changed");
    });

    test("rejects unrelated updates while plan mode is actively running", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Plan something carefully",
          name: "Planning Task",
          draft: false,
          planMode: true,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;
      expect(createBody.state.status).toBe("planning");

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Updated planning prompt",
        }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe("planning_update_restricted");
      expect(body.message).toContain("Only auto-accept plan and fully autonomous task can be changed");
    });

    test("updates a task to use an unlimited activity timeout", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Original prompt",
          name: "Unlimited Timeout Draft",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          activityTimeoutSeconds: null,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.config.activityTimeoutSeconds).toBeNull();
    });

    test("returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent-id`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name" }),
      });
      expect(response.status).toBe(404);
    });

    test("returns 400 for invalid JSON", async () => {
      // First create a draft task (to avoid active task conflicts)
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Try to update with invalid JSON
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "invalid json",
      });
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("invalid_json");
    });

    test("returns 409 when useWorktree is changed after git setup", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Immutable worktree mode",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      const { updateTaskState, loadTask } = await import("../../src/persistence/tasks");
      const task = await loadTask(taskId);
      expect(task).not.toBeNull();

      await updateTaskState(taskId, {
        ...task!.state,
        status: "completed",
        git: {
          originalBranch: "master",
          workingBranch: `${taskId}-a1b2c3d`,
          worktreePath: `${testWorkDir}/.clanky-worktrees/${taskId}`,
          commits: [],
        },
      });

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          useWorktree: false,
        }),
      });
      expect(response.status).toBe(409);

      const body = await response.json();
      expect(body.error).toBe("use_worktree_immutable");
    });
  });

  describe("DELETE /api/tasks/:id", () => {
    test("deletes a task", async () => {
      // First create a draft task (to avoid active task conflicts)
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test prompt",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Delete it
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);

      // Verify it's soft-deleted (still exists but with status "deleted")
      const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.state.status).toBe("deleted");
    });

    test("purges a deleted task", async () => {
      // Create a draft task first (to avoid active task conflicts)
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Purge me",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Soft delete it
      await fetch(`${baseUrl}/api/tasks/${taskId}`, { method: "DELETE" });

      // Purge it
      const purgeResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/purge`, {
        method: "POST",
      });
      expect(purgeResponse.status).toBe(200);

      // Verify it's actually deleted
      const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      expect(getResponse.status).toBe(404);
    });

    test("returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent-id`, {
        method: "DELETE",
      });
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe("not_found");
    });
  });

  describe("clearPlanningFolder option", () => {
    test("creates a task with clearPlanningFolder = true", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Task with clearing",
          name: "Test Task",
          clearPlanningFolder: true,
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.config.clearPlanningFolder).toBe(true);
    });

    test("creates a task with clearPlanningFolder = false", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Task without clearing",
          name: "Test Task",
          clearPlanningFolder: false,
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.config.clearPlanningFolder).toBe(false);
    });

    test("creates a task with clearPlanningFolder defaulting to false", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Task with default",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      // Default value is false (not clearing the planning folder)
      expect(body.config.clearPlanningFolder).toBe(false);
    });

    test("GET returns clearPlanningFolder value correctly", async () => {
      // Create a draft task with clearPlanningFolder = true
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test",
          name: "Test Task",
          clearPlanningFolder: true,
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Get the task and verify clearPlanningFolder is set
      const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      expect(getResponse.status).toBe(200);

      const getBody = await getResponse.json();
      expect(getBody.config.clearPlanningFolder).toBe(true);
    });
  });

  describe("Draft tasks", () => {
    test("creates a draft task without starting", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Draft task",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.state.status).toBe("draft");
      expect(body.state.session).toBeUndefined();
      expect(body.state.git).toBeUndefined();
    });

    test("non-draft tasks still auto-start", async () => {
      // Create a unique directory for this test to avoid conflicts with other tests
      const uniqueWorkDir = await mkdtemp(join(tmpdir(), "clanky-non-draft-test-"));
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        const response = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Normal task",
            name: "Test Task",
            draft: false,
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });

        expect(response.status).toBe(201);
        const body = await response.json();
        expect(body.state.status).not.toBe("draft");
        expect(body.state.status).not.toBe("idle");
        
        // Wait for completion so it doesn't interfere with other tests
        await waitForTaskCompletion(body.config.id);
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("can update a draft task via PUT", async () => {
      // Create draft
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Original prompt",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Update draft
      const updateResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Updated prompt",
        }),
      });

      expect(updateResponse.status).toBe(200);
      const updateBody = await updateResponse.json();
      expect(updateBody.config.prompt).toBe("Updated prompt");
      expect(updateBody.state.status).toBe("draft");
    });

    test("can clear a draft task max-iteration limit via PUT", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Original prompt",
          name: "Finite Draft Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
          maxIterations: 5,
        }),
      });

      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;
      expect(createBody.config.maxIterations).toBe(5);

      const updateResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxIterations: null,
        }),
      });

      expect(updateResponse.status).toBe(200);
      const updateBody = await updateResponse.json();
      expect(updateBody.config.maxIterations).toBeNull();
      expect(updateBody.state.status).toBe("draft");

      const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.config.maxIterations).toBeNull();
    });

    test("cannot update non-draft task via PUT", async () => {
      // Create a unique directory for this test to avoid conflicts
      const uniqueWorkDir = await mkdtemp(join(tmpdir(), "clanky-put-test-"));
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create regular task
        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Task",
            name: "Test Task",
            planMode: false,
          model: testModel,
          useWorktree: true,
          }),
        });
        expect(createResponse.status).toBe(201);
        const createBody = await createResponse.json();
        const taskId = createBody.config.id;

        // Wait for completion
        await waitForTaskCompletion(taskId);

        // Try to update
        const updateResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          }),
        });

        expect(updateResponse.status).toBe(400);
        const body = await updateResponse.json();
        expect(body.error).toBe("not_draft");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("can start draft as immediate execution", async () => {
      // Create draft
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Task",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Start draft
      const startResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/draft/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planMode: false,
          attachments: [],
        }),
      });

      expect(startResponse.status).toBe(200);
      const startBody = await startResponse.json();
      expect(startBody.state.status).not.toBe("draft");
      
      // Wait for completion
      await waitForTaskCompletion(taskId);
      
      // Verify final state
      const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      const getBody = await getResponse.json();
      expect(getBody.state.status).toBe("completed");
      expect(getBody.state.git).toBeDefined();
    });

    test("can start draft as plan mode", async () => {
      // Use a unique directory to avoid branch collision with previous test
      const uniqueWorkDir = await mkdtemp(join(tmpdir(), "clanky-draft-plan-test-"));
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();

      try {
        // Create workspace for this directory
        const uniqueWorkspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create draft
        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...baseCreateTaskPayload,
            workspaceId: uniqueWorkspaceId,
            prompt: "Plan mode draft task",
            name: "Test Task",
            draft: true,
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const taskId = createBody.config.id;

        // Start draft in plan mode
        const startResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/draft/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planMode: true,
          attachments: [],
        }),
        });

        expect(startResponse.status).toBe(200);
        const startBody = await startResponse.json();
        expect(startBody.state.status).toBe("planning");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("cannot start non-draft task via draft/start", async () => {
      // Create a unique directory for this test to avoid conflicts
      const uniqueWorkDir = await mkdtemp(join(tmpdir(), "clanky-start-test-"));
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a draft task
        const draftResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Task",
            name: "Test Task",
            draft: true,
            planMode: false,
          model: testModel,
          useWorktree: true,
          }),
        });
        const draftBody = await draftResponse.json();
        const draftTaskId = draftBody.config.id;
        
        // Start it immediately to make it a non-draft task
        const startDraftResponse = await fetch(`${baseUrl}/api/tasks/${draftTaskId}/draft/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planMode: false, attachments: [] }),
        });
        
        expect(startDraftResponse.status).toBe(200);
        await waitForTaskCompletion(draftTaskId);

        // Now the task should be completed (non-draft)
        // Try to start via draft endpoint - should fail with not_draft (not 409)
        const startResponse = await fetch(`${baseUrl}/api/tasks/${draftTaskId}/draft/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            planMode: false,
            attachments: [],
          }),
        });

        expect(startResponse.status).toBe(400);
        const body = await startResponse.json();
        expect(body.error).toBe("not_draft");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("can delete a draft task", async () => {
      // Create draft
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Task",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Delete draft
      const deleteResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "DELETE",
      });

      expect(deleteResponse.status).toBe(200);

      // Verify it's soft-deleted (still exists but with status "deleted")
      const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.state.status).toBe("deleted");
    });

    test("draft prompt is preserved exactly as entered", async () => {
      const testPrompt = "This is a test prompt with special characters: @#$%^&*()";
      
      // Create draft
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: testPrompt,
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      expect(createBody.config.prompt).toBe(testPrompt);

      // Fetch the draft and verify prompt is preserved
      const getResponse = await fetch(`${baseUrl}/api/tasks/${createBody.config.id}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.config.prompt).toBe(testPrompt);
    });

    test("multi-line draft prompt is preserved", async () => {
      const multiLinePrompt = `Line 1: Introduction
Line 2: Main content with details
Line 3: Conclusion

This is a paragraph with
multiple lines.

- Bullet point 1
- Bullet point 2
- Bullet point 3`;
      
      // Create draft
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: multiLinePrompt,
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      expect(createBody.config.prompt).toBe(multiLinePrompt);
      
      const taskId = createBody.config.id;

      // Fetch the draft and verify multi-line prompt is preserved
      const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.config.prompt).toBe(multiLinePrompt);

      // Update with a different multi-line prompt
      const updatedPrompt = `Updated line 1
Updated line 2
Updated line 3`;

      const updateResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: updatedPrompt,
        }),
      });

      expect(updateResponse.status).toBe(200);
      const updateBody = await updateResponse.json();
      expect(updateBody.config.prompt).toBe(updatedPrompt);
    });

    test("updating draft prompt multiple times preserves each change", async () => {
      // Create draft
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Initial prompt v1",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;
      expect(createBody.config.prompt).toBe("Initial prompt v1");

      // First update
      const update1Response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Updated prompt v2",
        }),
      });

      expect(update1Response.status).toBe(200);
      const update1Body = await update1Response.json();
      expect(update1Body.config.prompt).toBe("Updated prompt v2");

      // Second update
      const update2Response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Final prompt v3",
        }),
      });

      expect(update2Response.status).toBe(200);
      const update2Body = await update2Response.json();
      expect(update2Body.config.prompt).toBe("Final prompt v3");

      // Fetch and verify final state
      const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.config.prompt).toBe("Final prompt v3");
    });
  });

  describe("POST /api/tasks/:id/mark-merged", () => {
    test("returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent-id/mark-merged`, {
        method: "POST",
      });
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe("not_found");
    });

    test("returns 400 for task not in final state", async () => {
      // Create a draft task (not in final state)
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test mark merged",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Try to mark as merged
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/mark-merged`, {
        method: "POST",
      });
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("mark_merged_failed");
      expect(body.message).toContain("Cannot mark task as merged");
    });

    test("returns 400 for task without git state", async () => {
      // Create a task, complete it, but ensure it has no git state
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test no git",
          name: "Test Task",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Wait for completion
      await waitForTaskCompletion(taskId);

      // Manually update task to completed without git state
      // This simulates a task that was completed without git integration
      const { updateTaskState, loadTask } = await import("../../src/persistence/tasks");
      const task = await loadTask(taskId);
      if (task) {
        await updateTaskState(taskId, {
          ...task.state,
          status: "pushed",
          git: undefined, // Remove git state
        });
        const { taskManager } = await import("../../src/core/task-manager");
        taskManager.resetForTesting();
      }

      // Try to mark as merged
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/mark-merged`, {
        method: "POST",
      });
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("mark_merged_failed");
      expect(body.message).toContain("No git branch");
    });

    test("marks a pushed task as merged and preserves merged status", async () => {
      // Create and complete a task
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test mark merged",
          name: "Test Task",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Wait for completion
      await waitForTaskCompletion(taskId);

      const { updateTaskState, loadTask } = await import("../../src/persistence/tasks");
      const completedTask = await loadTask(taskId);
      if (completedTask) {
        await updateTaskState(taskId, {
          ...completedTask.state,
          status: "pushed",
        });
        const { taskManager } = await import("../../src/core/task-manager");
        taskManager.resetForTesting();
      }

      // Mark as merged
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/mark-merged`, {
        method: "POST",
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);

      // Verify task status is now merged
      const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.state.status).toBe("merged");
    });
  });

  describe("POST /api/tasks/:id/manual-complete", () => {
    test("returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent-id/manual-complete`, {
        method: "POST",
      });
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe("not_found");
    });

    test("returns 400 for task that is not halted", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test manual complete",
          name: "Manual Complete Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/manual-complete`, {
        method: "POST",
      });
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("manual_complete_failed");
      expect(body.message).toContain("Cannot manually complete task");
    });

    test("returns 400 when the halted task has no git state", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test manual complete without git",
          name: "Manual Complete Without Git",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      const { updateTaskState, loadTask } = await import("../../src/persistence/tasks");
      const task = await loadTask(taskId);
      expect(task).toBeTruthy();

      await updateTaskState(taskId, {
        ...task!.state,
        status: "failed",
        error: {
          message: "Failed before git setup",
          iteration: 0,
          timestamp: new Date().toISOString(),
        },
      });

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/manual-complete`, {
        method: "POST",
      });
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("manual_complete_failed");
      expect(body.message).toContain("No git branch was created for this task");
    });

    test("promotes a failed task to completed and clears the persisted error", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test manual complete",
          name: "Manual Complete Task",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      await waitForTaskCompletion(taskId);

      const { updateTaskState, loadTask } = await import("../../src/persistence/tasks");
      const task = await loadTask(taskId);
      expect(task).toBeTruthy();

      await updateTaskState(taskId, {
        ...task!.state,
        status: "failed",
        error: {
          message: "Manual completion regression",
          iteration: task!.state.currentIteration,
          timestamp: new Date().toISOString(),
        },
      });
      const { taskManager } = await import("../../src/core/task-manager");
      taskManager.resetForTesting();

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/manual-complete`, {
        method: "POST",
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);

      const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.state.status).toBe("completed");
      expect(getBody.state.error).toBeUndefined();
    });
  });

  describe("Rename tasks via PATCH", () => {
    test("renames a draft task", async () => {
      // Create a draft task
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test rename task",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;
      // Name is auto-generated from prompt, so we just verify it exists
      expect(createBody.config.name).toBeDefined();

      // Rename the task
      const renameResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed Task" }),
      });
      expect(renameResponse.status).toBe(200);
      const renameBody = await renameResponse.json();
      expect(renameBody.config.name).toBe("Renamed Task");

      // Verify the name persists
      const getResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.config.name).toBe("Renamed Task");
    });

    test("rejects renaming a completed task while allowing other updates", async () => {
      // Create a unique directory for this test
      const uniqueWorkDir = await mkdtemp(join(tmpdir(), "clanky-rename-test-"));
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();

      try {
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create and complete a task
        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Complete me",
            name: "Before Completion",
            planMode: false,
          model: testModel,
          useWorktree: true,
          }),
        });
        expect(createResponse.status).toBe(201);
        const createBody = await createResponse.json();
        const taskId = createBody.config.id;

        // Wait for completion
        await waitForTaskCompletion(taskId);

        // Rename after completion
        const renameResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "After Completion" }),
        });
        expect(renameResponse.status).toBe(409);
        const renameBody = await renameResponse.json();
        expect(renameBody.error).toBe("task_rename_restricted");
        expect(renameBody.message).toContain("draft");

        const updateResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stopPattern: "DONE" }),
        });
        expect(updateResponse.status).toBe(200);
        const updateBody = await updateResponse.json();
        expect(updateBody.config.name).toBe("Before Completion");
        expect(updateBody.config.stopPattern).toBe("DONE");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("trims whitespace from name", async () => {
      // Create a draft task
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test trim",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Rename with whitespace
      const renameResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  Trimmed Name  " }),
      });
      expect(renameResponse.status).toBe(200);
      const renameBody = await renameResponse.json();
      expect(renameBody.config.name).toBe("Trimmed Name");
    });

    test("returns 404 for renaming non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent-id`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name" }),
      });
      expect(response.status).toBe(404);
    });

    test("returns 400 for empty name", async () => {
      // Create a draft task
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test empty name",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Try to rename with empty string
      const renameResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }),
      });
      expect(renameResponse.status).toBe(400);
      const renameBody = await renameResponse.json();
      expect(renameBody.error).toBe("validation_error");
      expect(renameBody.message).toContain("name is required");
    });

    test("returns 400 for whitespace-only name", async () => {
      // Create a draft task
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test whitespace name",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Try to rename with whitespace-only string
      const renameResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "   " }),
      });
      expect(renameResponse.status).toBe(400);
      const renameBody = await renameResponse.json();
      expect(renameBody.error).toBe("validation_error");
      expect(renameBody.message).toContain("name is required");
    });

    test("returns 400 for name longer than 100 characters", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test long rename",
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      const renameResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "a".repeat(101) }),
      });
      expect(renameResponse.status).toBe(400);
      const renameBody = await renameResponse.json();
      expect(renameBody.error).toBe("validation_error");
      expect(renameBody.message).toContain("100");
    });
  });
});
