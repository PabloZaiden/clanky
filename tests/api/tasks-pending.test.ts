/**
 * API tests for /api/tasks/:id/pending endpoint.
 * Tests setting and clearing pending message and model for mid-task steering.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serve, type Server } from "bun";
import { apiRoutes } from "../../src/api";
import { ensureDataDirectories } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { taskManager } from "../../src/core/task-manager";
import { closeDatabase } from "../../src/persistence/database";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { NeverCompletingMockBackend } from "../mocks/mock-backend";

// Default test model for task creation (model is now required)
const testModel = { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", variant: "" };

describe("POST /api/tasks/:id/pending", () => {
  let testDataDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  // Helper to get or create a workspace for a directory
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

  // Helper to create a unique work directory with git AND workspace
  async function createTestWorkDirWithWorkspace(): Promise<{ workDir: string; workspaceId: string }> {
    const workDir = await mkdtemp(join(tmpdir(), "clanky-pending-test-work-"));
    await Bun.$`git init -b main ${workDir}`.quiet();
    await Bun.$`git -C ${workDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${workDir} config user.name "Test User"`.quiet();
    await writeFile(join(workDir, "README.md"), "# Test");
    await Bun.$`git -C ${workDir} add .`.quiet();
    await Bun.$`git -C ${workDir} commit -m "Initial commit"`.quiet();
    await mkdir(join(workDir, ".clanky-planning"), { recursive: true });
    const workspaceId = await getOrCreateWorkspace(workDir, "Test Workspace");
    return { workDir, workspaceId };
  }

  // Helper to wait for task to reach a specific status
  async function waitForTaskStatus(taskId: string, targetStatus: string[], timeoutMs = 5000): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      if (response.ok) {
        const data = await response.json();
        if (targetStatus.includes(data.state?.status)) {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Task ${taskId} did not reach status ${targetStatus.join("/")} within ${timeoutMs}ms`);
  }

  beforeAll(async () => {
    // Create temp data directory
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-api-pending-test-data-"));

    // Set env var for persistence before importing modules
    process.env["CLANKY_DATA_DIR"] = testDataDir;

    // Ensure directories exist
    await ensureDataDirectories();

    // Set up backend manager before starting server
    // Configure models that tests will use
    backendManager.setBackendForTesting(new NeverCompletingMockBackend({
      models: [
        {
          providerID: "anthropic",
          providerName: "Anthropic",
          modelID: "claude-sonnet-4-20250514",
          modelName: "Claude Sonnet 4",
          connected: true,
        },
        {
          providerID: "openai",
          providerName: "OpenAI",
          modelID: "gpt-4o",
          modelName: "GPT-4o",
          connected: true, // Mark as connected for these tests
        },
      ],
    }));
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    // Start test server on random port
    server = serve({
      port: 0,
      routes: {
        ...apiRoutes,
      },
    });
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop();
    taskManager.resetForTesting();
    backendManager.resetForTesting();
    closeDatabase();
    await rm(testDataDir, { recursive: true, force: true });
    delete process.env["CLANKY_DATA_DIR"];
  });

  // Clean up any active tasks before and after each test
  const cleanupActiveTasks = async () => {
    const { listTasks, updateTaskState, loadTask } = await import("../../src/persistence/tasks");
    
    // Clear all running engines first
    taskManager.resetForTesting();
    
    const tasks = await listTasks();
    const activeStatuses = ["idle", "planning", "starting", "running", "waiting"];
    
    for (const task of tasks) {
      if (activeStatuses.includes(task.state.status)) {
        const fullTask = await loadTask(task.config.id);
        if (fullTask) {
          await updateTaskState(task.config.id, {
            ...fullTask.state,
            status: "deleted",
          });
        }
      }
    }
    
    // Re-setup backend after reset with models configured
    backendManager.setBackendForTesting(new NeverCompletingMockBackend({
      models: [
        {
          providerID: "anthropic",
          providerName: "Anthropic",
          modelID: "claude-sonnet-4-20250514",
          modelName: "Claude Sonnet 4",
          connected: true,
        },
        {
          providerID: "openai",
          providerName: "OpenAI",
          modelID: "gpt-4o",
          modelName: "GPT-4o",
          connected: true,
        },
      ],
    }));
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
  };

  beforeEach(async () => {
    await cleanupActiveTasks();
  });

  afterEach(async () => {
    await cleanupActiveTasks();
  });

  test("POST with message succeeds for running task", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      // Create a task - it auto-starts when created without draft: true
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      // Wait for it to be running
      await waitForTaskStatus(taskId, ["running"]);

      // Set pending message
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Please focus on the login feature",
          model: null,
          immediate: true,
          attachments: [],
        }),
      });
      expect(pendingRes.status).toBe(200);
      const pendingData = await pendingRes.json();
      expect(pendingData.success).toBe(true);

      // Verify the pending message was stored
      const taskRes = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      const taskData = await taskRes.json();
      expect(taskData.state.pendingPrompt).toBe("Please focus on the login feature");

      // Stop the task to clean up
      await fetch(`${baseUrl}/api/tasks/${taskId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with model succeeds for running task", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      await waitForTaskStatus(taskId, ["running"]);

      // Set pending model
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: null,
          model: { providerID: "openai", modelID: "gpt-4o", variant: "" },
          immediate: true,
          attachments: [],
        }),
      });
      expect(pendingRes.status).toBe(200);

      // Verify the pending model was stored
      const taskRes = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      const taskData = await taskRes.json();
      expect(taskData.state.pendingModel).toEqual({
        providerID: "openai",
        modelID: "gpt-4o",
        variant: "",
      });

      await fetch(`${baseUrl}/api/tasks/${taskId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with both message and model succeeds", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      await waitForTaskStatus(taskId, ["running"]);

      // Set both pending message and model
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Use the new API",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", variant: "" },
          immediate: true,
          attachments: [],
        }),
      });
      expect(pendingRes.status).toBe(200);

      // Verify both were stored
      const taskRes = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      const taskData = await taskRes.json();
      expect(taskData.state.pendingPrompt).toBe("Use the new API");
      expect(taskData.state.pendingModel).toEqual({
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
        variant: "",
      });

      await fetch(`${baseUrl}/api/tasks/${taskId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("DELETE clears pending values", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      await waitForTaskStatus(taskId, ["running"]);

      // Set pending values
      await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "To be cleared",
          model: { providerID: "openai", modelID: "gpt-4o", variant: "" },
          immediate: true,
          attachments: [],
        }),
      });

      // Clear pending values
      const deleteRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(200);

      // Verify both were cleared
      const taskRes = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      const taskData = await taskRes.json();
      expect(taskData.state.pendingPrompt).toBeUndefined();
      expect(taskData.state.pendingModel).toBeUndefined();

      await fetch(`${baseUrl}/api/tasks/${taskId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST returns 409 for idle task", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      // Create a draft task (doesn't auto-start)
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          model: testModel,
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          useWorktree: false,
          clearPlanningFolder: false,
          planMode: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      // Try to set pending message on idle/draft task
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "This should fail",
          model: null,
          immediate: true,
          attachments: [],
        }),
      });
      expect(pendingRes.status).toBe(409);
      const data = await pendingRes.json();
      expect(data.error).toBe("not_running");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("DELETE returns 409 for idle task", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      // Create a draft task
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          model: testModel,
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          useWorktree: false,
          clearPlanningFolder: false,
          planMode: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      // Try to clear pending on idle task
      const deleteRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(409);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST returns 404 for non-existent task", async () => {
    const pendingRes = await fetch(`${baseUrl}/api/tasks/non-existent-id/pending`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Test",
        model: null,
        immediate: true,
        attachments: [],
      }),
    });
    expect(pendingRes.status).toBe(404);
  });

  test("DELETE returns 404 for non-existent task", async () => {
    const deleteRes = await fetch(`${baseUrl}/api/tasks/non-existent-id/pending`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(404);
  });

  test("POST requires at least message or model", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      await waitForTaskStatus(taskId, ["running"]);

      // Try to set with empty body
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(pendingRes.status).toBe(400);
      const data = await pendingRes.json();
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("message");
      expect(data.message).toContain("model");

      await fetch(`${baseUrl}/api/tasks/${taskId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST validates model format", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      await waitForTaskStatus(taskId, ["running"]);

      // Try with invalid model (missing modelID)
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: null,
          model: { providerID: "openai" },  // Missing modelID
          immediate: true,
          attachments: [],
        }),
      });
      expect(pendingRes.status).toBe(400);
      const data = await pendingRes.json();
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("modelID");

      await fetch(`${baseUrl}/api/tasks/${taskId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST validates message type", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      await waitForTaskStatus(taskId, ["running"]);

      // Try with invalid message type
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: 12345,  // Should be string
          model: null,
          immediate: true,
          attachments: [],
        }),
      });
      expect(pendingRes.status).toBe(400);
      const data = await pendingRes.json();
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("message");
      expect(data.message).toContain("string");

      await fetch(`${baseUrl}/api/tasks/${taskId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with immediate: true (default) calls injectPending", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      await waitForTaskStatus(taskId, ["running"]);

      // Set pending message with default immediate (true)
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Immediate injection",
          model: null,
          immediate: true,
          attachments: [],
        }),
      });
      expect(pendingRes.status).toBe(200);

      // Verify the pending message was stored
      const taskRes = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      const taskData = await taskRes.json();
      expect(taskData.state.pendingPrompt).toBe("Immediate injection");

      await fetch(`${baseUrl}/api/tasks/${taskId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with immediate: false rejects backend queueing", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      await waitForTaskStatus(taskId, ["running"]);

      // Set pending message with immediate: false
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Queued for later",
          model: null,
          immediate: false,
          attachments: [],
        }),
      });
      expect(pendingRes.status).toBe(409);
      const body = await pendingRes.json();
      expect(body.error).toBe("queue_not_supported");
      expect(body.message).toContain("Stop the task first");

      await fetch(`${baseUrl}/api/tasks/${taskId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with immediate: true and model works correctly", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      await waitForTaskStatus(taskId, ["running"]);

      // Set both message and model with immediate: true
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Immediate with model",
          model: { providerID: "openai", modelID: "gpt-4o", variant: "" },
          immediate: true,
          attachments: [],
        }),
      });
      expect(pendingRes.status).toBe(200);

      // Verify both were stored
      const taskRes = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      const taskData = await taskRes.json();
      expect(taskData.state.pendingPrompt).toBe("Immediate with model");
      expect(taskData.state.pendingModel).toEqual({
        providerID: "openai",
        modelID: "gpt-4o",
        variant: "",
      });

      await fetch(`${baseUrl}/api/tasks/${taskId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST validates immediate must be boolean", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      await waitForTaskStatus(taskId, ["running"]);

      // Try with invalid immediate type
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Test",
          immediate: "yes",  // Should be boolean
        }),
      });
      expect(pendingRes.status).toBe(400);
      const data = await pendingRes.json();
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("immediate");
      expect(data.message).toContain("boolean");

      await fetch(`${baseUrl}/api/tasks/${taskId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with message jumpstarts a stopped task", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      // Create a task and let it start
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Jumpstart Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      // Wait for it to be running
      await waitForTaskStatus(taskId, ["running"]);

      // Stop the task using the manager (no HTTP API for this)
      await taskManager.stopTask(taskId);

      // Wait for it to be stopped
      await waitForTaskStatus(taskId, ["stopped"]);

      // Now send a message to jumpstart it
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Please continue working on the feature",
          model: null,
          immediate: true,
          attachments: [],
        }),
      });
      expect(pendingRes.status).toBe(200);
      const pendingData = await pendingRes.json();
      expect(pendingData.success).toBe(true);

      // Task should be running again after jumpstart
      await waitForTaskStatus(taskId, ["starting", "running"]);

      // Stop the task to clean up
      await taskManager.stopTask(taskId);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with message reconciles a stale running task after engine reset", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const { loadTask, updateTaskState } = await import("../../src/persistence/tasks");

      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Stale Running Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      await waitForTaskStatus(taskId, ["running"]);

      await taskManager.stopTask(taskId);
      await waitForTaskStatus(taskId, ["stopped"]);

      const stoppedTask = await loadTask(taskId);
      expect(stoppedTask).not.toBeNull();

      await updateTaskState(taskId, {
        ...stoppedTask!.state,
        status: "running",
        completedAt: undefined,
        error: undefined,
      });

      const staleTask = await loadTask(taskId);
      expect(staleTask?.state.status).toBe("running");

      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Please continue after restart",
          model: null,
          immediate: true,
          attachments: [],
        }),
      });
      expect(pendingRes.status).toBe(200);
      const pendingData = await pendingRes.json();
      expect(pendingData.success).toBe(true);

      await waitForTaskStatus(taskId, ["starting", "running"]);

      await taskManager.stopTask(taskId);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with model jumpstarts a stopped task and updates config model", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Jumpstart Model Test Task",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      await waitForTaskStatus(taskId, ["running"]);

      // Stop the task using the manager (no HTTP API for this)
      await taskManager.stopTask(taskId);
      await waitForTaskStatus(taskId, ["stopped"]);

      // Jumpstart with a new model
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Continue with new model",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", variant: "" },
          immediate: true,
          attachments: [],
        }),
      });
      expect(pendingRes.status).toBe(200);

      // Wait for it to restart
      await waitForTaskStatus(taskId, ["starting", "running"]);

      // Verify the config model was updated
      const taskRes = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      const taskData = await taskRes.json();
      expect(taskData.config.model).toEqual({
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
        variant: "",
      });

      await taskManager.stopTask(taskId);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST jumpstart continues on existing branch instead of creating new one", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      // Create and start a task
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Branch Continuation Test",
          workspaceId,
          prompt: "Test prompt",
          attachments: [],
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch: "main",
          clearPlanningFolder: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: false,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const taskId = created.config.id;

      // Wait for it to be running
      await waitForTaskStatus(taskId, ["running"]);

      // Get the working branch that was created
      const taskBeforeStop = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      const taskDataBeforeStop = await taskBeforeStop.json();
      const originalWorkingBranch = taskDataBeforeStop.state.git?.workingBranch;
      expect(originalWorkingBranch).toBeDefined();
      expect(originalWorkingBranch).not.toContain("clanky/");
      expect(originalWorkingBranch).toMatch(/-[0-9a-f]{7}$/);

      // Stop the task
      await taskManager.stopTask(taskId);
      await waitForTaskStatus(taskId, ["stopped"]);

      // Jumpstart the task with a message
      const pendingRes = await fetch(`${baseUrl}/api/tasks/${taskId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Continue on the same branch",
          model: null,
          immediate: true,
          attachments: [],
        }),
      });
      expect(pendingRes.status).toBe(200);

      // Wait for it to be running again
      await waitForTaskStatus(taskId, ["starting", "running"]);

      // Verify it's still on the same working branch
      const taskAfterJumpstart = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      const taskDataAfterJumpstart = await taskAfterJumpstart.json();
      const currentWorkingBranch = taskDataAfterJumpstart.state.git?.workingBranch;

      // The working branch should be the same as before the stop
      expect(currentWorkingBranch).toBe(originalWorkingBranch);

      // Clean up
      await taskManager.stopTask(taskId);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
