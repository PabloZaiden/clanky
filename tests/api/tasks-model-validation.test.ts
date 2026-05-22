/**
 * API integration tests for model validation in tasks endpoints.
 * 
 * Tests verify that the API correctly rejects requests when:
 * - Model provider is not connected
 * - Model does not exist
 * - Provider does not exist
 * 
 * Note: Full model validation tests require a real backend connection.
 * These tests verify the validation flow using workspace/validation errors.
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
import { MockAcpBackend, type MockModelInfo } from "../mocks/mock-backend";

describe("Model Validation in API Endpoints", () => {
  let testDataDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  // Default models for tests
  const defaultTestModels: MockModelInfo[] = [
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
      connected: false, // Disconnected!
    },
  ];

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
    const workDir = await mkdtemp(join(tmpdir(), "clanky-model-validation-test-work-"));
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

  function createTaskRequestPayload(workspaceId: string, overrides: {
    [key: string]: unknown;
    model?: Record<string, unknown>;
    git?: Record<string, unknown>;
  } = {}): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      name: "Test Task",
      workspaceId,
      prompt: "Test prompt",
      attachments: [],
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
        variant: "",
        ...(overrides.model ?? {}),
      },
      cheapModel: { mode: "same-as-task" },
      maxIterations: null,
      maxConsecutiveErrors: 10,
      activityTimeoutSeconds: 300,
      stopPattern: "<promise>COMPLETE</promise>$",
      git: {
        branchPrefix: "",
        commitScope: "",
        ...(overrides.git ?? {}),
      },
      baseBranch: "main",
      useWorktree: true,
      clearPlanningFolder: false,
      planMode: false,
      autoAcceptPlan: false,
      fullyAutonomous: false,
      draft: false,
      ...overrides,
    };

    if ("model" in overrides) {
      payload["model"] = overrides.model;
    }

    if ("git" in overrides) {
      payload["git"] = {
        branchPrefix: "",
        commitScope: "",
        ...(overrides.git ?? {}),
      };
    }

    return payload;
  }

  beforeAll(async () => {
    // Create temp data directory
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-model-validation-test-data-"));

    // Set env var for persistence before importing modules
    process.env["CLANKY_DATA_DIR"] = testDataDir;

    // Ensure directories exist
    await ensureDataDirectories();

    // Set up backend manager with mock that returns models (including disconnected ones)
    const mockBackend = new MockAcpBackend({
      responses: ["<promise>COMPLETE</promise>"],
      models: defaultTestModels,
    });
    backendManager.setBackendForTesting(mockBackend);
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

    // Re-setup backend after reset
    const mockBackend = new MockAcpBackend({
      responses: ["<promise>COMPLETE</promise>"],
      models: defaultTestModels,
    });
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
  };

  beforeEach(async () => {
    await cleanupActiveTasks();
  });

  afterEach(async () => {
    await cleanupActiveTasks();
  });

  describe("POST /api/tasks - Create Task", () => {
    test("succeeds with connected model", async () => {
      const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
      try {
        const response = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createTaskRequestPayload(workspaceId)),
        });

        // Should succeed because anthropic is connected
        expect(response.status).toBe(201);
        const data = await response.json();
        expect(data.config.model.providerID).toBe("anthropic");
        expect(data.config.model.modelID).toBe("claude-sonnet-4-20250514");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    test("rejects request without model (model is now required)", async () => {
      const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
      try {
        const response = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify((() => {
            const payload = createTaskRequestPayload(workspaceId);
            delete payload["model"];
            return payload;
          })()),
        });

        // Should fail with 400 since model is required
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toBe("validation_error");
        expect(data.message).toContain("model");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    test("rejects draft with disconnected model", async () => {
      const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
      try {
        // Drafts should also require a connected model
        // This ensures consistent behavior and prevents saving invalid configurations
        const response = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createTaskRequestPayload(workspaceId, {
            draft: true,
            model: {
              providerID: "openai",
              modelID: "gpt-4o",
              variant: "",
            },
          })),
        });

        // Drafts also require connected models now
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.message).toContain("not connected");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  describe("POST /api/tasks/:id/pending - Model Change", () => {
    test("validates model is enabled (rejects disconnected model)", async () => {
      const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
      try {
        // Create and start a task (it will complete quickly with mock backend)
        const createRes = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createTaskRequestPayload(workspaceId)),
        });
        expect(createRes.status).toBe(201);
        const task = await createRes.json();

        // Wait for it to complete (mock backend completes quickly)
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Try to change to a disconnected model - should fail with model_not_enabled
        const pendingRes = await fetch(`${baseUrl}/api/tasks/${task.config.id}/pending`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: null,
            model: {
              providerID: "openai",
              modelID: "gpt-4o",
              variant: "",
            },
            immediate: true,
            attachments: [],
          }),
        });

        // Model validation runs BEFORE task status check
        // So we should get a model_not_enabled error, not a not_running error
        expect(pendingRes.ok).toBe(false);
        const errorBody = await pendingRes.json();
        expect(errorBody.error).toBe("model_not_enabled");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    test("validates model is enabled (accepts connected model) before status check", async () => {
      const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
      try {
        // Create and start a task
        const createRes = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createTaskRequestPayload(workspaceId)),
        });
        expect(createRes.status).toBe(201);
        const task = await createRes.json();

        // Try to change to a connected model immediately
        // The key test is that model validation runs and PASSES
        // (regardless of what happens with the task status check afterwards)
        const pendingRes = await fetch(`${baseUrl}/api/tasks/${task.config.id}/pending`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: null,
            model: {
              providerID: "anthropic",
              modelID: "claude-sonnet-4-20250514",
              variant: "",
            },
            immediate: true,
            attachments: [],
          }),
        });

        // If we get a model validation error, the test fails
        // Any other error (like task status) is acceptable for this test
        const body = await pendingRes.json();
        if (!pendingRes.ok) {
          // Verify the error is NOT about model validation
          expect(body.error).not.toBe("model_not_enabled");
          expect(body.error).not.toBe("model_not_found");
          expect(body.error).not.toBe("provider_not_found");
          expect(body.error).not.toBe("validation_failed");
        }
        // If it succeeded, that's also fine - it means model validation passed
        // and the task was in a suitable state
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  describe("Input validation", () => {
    test("rejects partial model object (missing providerID)", async () => {
      const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
      try {
        const response = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createTaskRequestPayload(workspaceId, {
            model: {
              // Missing providerID - should be rejected
              modelID: "gpt-4o",
              variant: "",
            },
          })),
        });

        // Model with missing providerID should be rejected
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toBe("validation_error");
        expect(data.message).toContain("model");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });
});
