/**
 * API tests for /api/loops/:id/pending endpoint.
 * Tests setting and clearing pending message and model for mid-loop steering.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serve, type Server } from "bun";
import { apiRoutes } from "../../src/api";
import { ensureDataDirectories } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { loopManager } from "../../src/core/loop-manager";
import { closeDatabase } from "../../src/persistence/database";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { NeverCompletingMockBackend } from "../mocks/mock-backend";

// Default test model for loop creation (model is now required)
const testModel = { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" };

describe("POST /api/loops/:id/pending", () => {
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
    const workDir = await mkdtemp(join(tmpdir(), "ralpher-pending-test-work-"));
    await Bun.$`git init ${workDir}`.quiet();
    await Bun.$`git -C ${workDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${workDir} config user.name "Test User"`.quiet();
    await writeFile(join(workDir, "README.md"), "# Test");
    await Bun.$`git -C ${workDir} add .`.quiet();
    await Bun.$`git -C ${workDir} commit -m "Initial commit"`.quiet();
    await mkdir(join(workDir, ".planning"), { recursive: true });
    const workspaceId = await getOrCreateWorkspace(workDir, "Test Workspace");
    return { workDir, workspaceId };
  }

  // Helper to wait for loop to reach a specific status
  async function waitForLoopStatus(loopId: string, targetStatus: string[], timeoutMs = 5000): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/loops/${loopId}`);
      if (response.ok) {
        const data = await response.json();
        if (targetStatus.includes(data.state?.status)) {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Loop ${loopId} did not reach status ${targetStatus.join("/")} within ${timeoutMs}ms`);
  }

  beforeAll(async () => {
    // Create temp data directory
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-api-pending-test-data-"));

    // Set env var for persistence before importing modules
    process.env["RALPHER_DATA_DIR"] = testDataDir;

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
    loopManager.resetForTesting();
    backendManager.resetForTesting();
    closeDatabase();
    await rm(testDataDir, { recursive: true, force: true });
    delete process.env["RALPHER_DATA_DIR"];
  });

  // Clean up any active loops before and after each test
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
    await cleanupActiveLoops();
  });

  afterEach(async () => {
    await cleanupActiveLoops();
  });

  test("POST with message succeeds for running loop", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      // Create a loop - it auto-starts when created without draft: true
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      // Wait for it to be running
      await waitForLoopStatus(loopId, ["running"]);

      // Set pending message
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Please focus on the login feature",
        }),
      });
      expect(pendingRes.status).toBe(200);
      const pendingData = await pendingRes.json();
      expect(pendingData.success).toBe(true);

      // Verify the pending message was stored
      const loopRes = await fetch(`${baseUrl}/api/loops/${loopId}`);
      const loopData = await loopRes.json();
      expect(loopData.state.pendingPrompt).toBe("Please focus on the login feature");

      // Stop the loop to clean up
      await fetch(`${baseUrl}/api/loops/${loopId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with model succeeds for running loop", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      await waitForLoopStatus(loopId, ["running"]);

      // Set pending model
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: { providerID: "openai", modelID: "gpt-4o" },
        }),
      });
      expect(pendingRes.status).toBe(200);

      // Verify the pending model was stored
      const loopRes = await fetch(`${baseUrl}/api/loops/${loopId}`);
      const loopData = await loopRes.json();
      expect(loopData.state.pendingModel).toEqual({
        providerID: "openai",
        modelID: "gpt-4o",
      });

      await fetch(`${baseUrl}/api/loops/${loopId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with both message and model succeeds", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      await waitForLoopStatus(loopId, ["running"]);

      // Set both pending message and model
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Use the new API",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
        }),
      });
      expect(pendingRes.status).toBe(200);

      // Verify both were stored
      const loopRes = await fetch(`${baseUrl}/api/loops/${loopId}`);
      const loopData = await loopRes.json();
      expect(loopData.state.pendingPrompt).toBe("Use the new API");
      expect(loopData.state.pendingModel).toEqual({
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
      });

      await fetch(`${baseUrl}/api/loops/${loopId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("DELETE clears pending values", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      await waitForLoopStatus(loopId, ["running"]);

      // Set pending values
      await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "To be cleared",
          model: { providerID: "openai", modelID: "gpt-4o" },
        }),
      });

      // Clear pending values
      const deleteRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(200);

      // Verify both were cleared
      const loopRes = await fetch(`${baseUrl}/api/loops/${loopId}`);
      const loopData = await loopRes.json();
      expect(loopData.state.pendingPrompt).toBeUndefined();
      expect(loopData.state.pendingModel).toBeUndefined();

      await fetch(`${baseUrl}/api/loops/${loopId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST returns 409 for idle loop", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      // Create a draft loop (doesn't auto-start)
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          workspaceId,
          prompt: "Test prompt",
          draft: true,  // Create as draft - stays in idle status
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      // Try to set pending message on idle/draft loop
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "This should fail",
        }),
      });
      expect(pendingRes.status).toBe(409);
      const data = await pendingRes.json();
      expect(data.error).toBe("not_running");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("DELETE returns 409 for idle loop", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      // Create a draft loop
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          workspaceId,
          prompt: "Test prompt",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      // Try to clear pending on idle loop
      const deleteRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(409);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST returns 404 for non-existent loop", async () => {
    const pendingRes = await fetch(`${baseUrl}/api/loops/non-existent-id/pending`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Test",
      }),
    });
    expect(pendingRes.status).toBe(404);
  });

  test("DELETE returns 404 for non-existent loop", async () => {
    const deleteRes = await fetch(`${baseUrl}/api/loops/non-existent-id/pending`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(404);
  });

  test("POST requires at least message or model", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      await waitForLoopStatus(loopId, ["running"]);

      // Try to set with empty body
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(pendingRes.status).toBe(400);
      const data = await pendingRes.json();
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("message");
      expect(data.message).toContain("model");

      await fetch(`${baseUrl}/api/loops/${loopId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST validates model format", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      await waitForLoopStatus(loopId, ["running"]);

      // Try with invalid model (missing modelID)
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: { providerID: "openai" },  // Missing modelID
        }),
      });
      expect(pendingRes.status).toBe(400);
      const data = await pendingRes.json();
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("modelID");

      await fetch(`${baseUrl}/api/loops/${loopId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST validates message type", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      await waitForLoopStatus(loopId, ["running"]);

      // Try with invalid message type
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: 12345,  // Should be string
        }),
      });
      expect(pendingRes.status).toBe(400);
      const data = await pendingRes.json();
      expect(data.error).toBe("validation_error");
      expect(data.message).toContain("message");
      expect(data.message).toContain("string");

      await fetch(`${baseUrl}/api/loops/${loopId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with immediate: true (default) calls injectPending", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      await waitForLoopStatus(loopId, ["running"]);

      // Set pending message with default immediate (true)
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Immediate injection",
        }),
      });
      expect(pendingRes.status).toBe(200);

      // Verify the pending message was stored
      const loopRes = await fetch(`${baseUrl}/api/loops/${loopId}`);
      const loopData = await loopRes.json();
      expect(loopData.state.pendingPrompt).toBe("Immediate injection");

      await fetch(`${baseUrl}/api/loops/${loopId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with immediate: false queues for next iteration", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      await waitForLoopStatus(loopId, ["running"]);

      // Set pending message with immediate: false
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Queued for later",
          immediate: false,
        }),
      });
      expect(pendingRes.status).toBe(200);

      // Verify the pending message was stored
      const loopRes = await fetch(`${baseUrl}/api/loops/${loopId}`);
      const loopData = await loopRes.json();
      expect(loopData.state.pendingPrompt).toBe("Queued for later");

      await fetch(`${baseUrl}/api/loops/${loopId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with immediate: true and model works correctly", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      await waitForLoopStatus(loopId, ["running"]);

      // Set both message and model with immediate: true
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Immediate with model",
          model: { providerID: "openai", modelID: "gpt-4o" },
          immediate: true,
        }),
      });
      expect(pendingRes.status).toBe(200);

      // Verify both were stored
      const loopRes = await fetch(`${baseUrl}/api/loops/${loopId}`);
      const loopData = await loopRes.json();
      expect(loopData.state.pendingPrompt).toBe("Immediate with model");
      expect(loopData.state.pendingModel).toEqual({
        providerID: "openai",
        modelID: "gpt-4o",
      });

      await fetch(`${baseUrl}/api/loops/${loopId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST validates immediate must be boolean", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      await waitForLoopStatus(loopId, ["running"]);

      // Try with invalid immediate type
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
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

      await fetch(`${baseUrl}/api/loops/${loopId}/stop`, { method: "POST" });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with message jumpstarts a stopped loop", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      // Create a loop and let it start
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Jumpstart Test Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      // Wait for it to be running
      await waitForLoopStatus(loopId, ["running"]);

      // Stop the loop using the manager (no HTTP API for this)
      await loopManager.stopLoop(loopId);

      // Wait for it to be stopped
      await waitForLoopStatus(loopId, ["stopped"]);

      // Now send a message to jumpstart it
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Please continue working on the feature",
        }),
      });
      expect(pendingRes.status).toBe(200);
      const pendingData = await pendingRes.json();
      expect(pendingData.success).toBe(true);

      // Loop should be running again after jumpstart
      await waitForLoopStatus(loopId, ["starting", "running"]);

      // Stop the loop to clean up
      await loopManager.stopLoop(loopId);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with message reconciles a stale running loop after engine reset", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const { loadLoop, updateLoopState } = await import("../../src/persistence/loops");

      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Stale Running Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      await waitForLoopStatus(loopId, ["running"]);

      await loopManager.stopLoop(loopId);
      await waitForLoopStatus(loopId, ["stopped"]);

      const stoppedLoop = await loadLoop(loopId);
      expect(stoppedLoop).not.toBeNull();

      await updateLoopState(loopId, {
        ...stoppedLoop!.state,
        status: "running",
        completedAt: undefined,
        error: undefined,
      });

      const staleLoop = await loadLoop(loopId);
      expect(staleLoop?.state.status).toBe("running");

      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Please continue after restart",
        }),
      });
      expect(pendingRes.status).toBe(200);
      const pendingData = await pendingRes.json();
      expect(pendingData.success).toBe(true);

      await waitForLoopStatus(loopId, ["starting", "running"]);

      await loopManager.stopLoop(loopId);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST with model jumpstarts a stopped loop and updates config model", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Jumpstart Model Test Loop",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      await waitForLoopStatus(loopId, ["running"]);

      // Stop the loop using the manager (no HTTP API for this)
      await loopManager.stopLoop(loopId);
      await waitForLoopStatus(loopId, ["stopped"]);

      // Jumpstart with a new model
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Continue with new model",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
        }),
      });
      expect(pendingRes.status).toBe(200);

      // Wait for it to restart
      await waitForLoopStatus(loopId, ["starting", "running"]);

      // Verify the config model was updated
      const loopRes = await fetch(`${baseUrl}/api/loops/${loopId}`);
      const loopData = await loopRes.json();
      expect(loopData.config.model).toEqual({
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
      });

      await loopManager.stopLoop(loopId);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("POST jumpstart continues on existing branch instead of creating new one", async () => {
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    try {
      // Create and start a loop
      const createRes = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Branch Continuation Test",
          workspaceId,
          prompt: "Test prompt",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const loopId = created.config.id;

      // Wait for it to be running
      await waitForLoopStatus(loopId, ["running"]);

      // Get the working branch that was created
      const loopBeforeStop = await fetch(`${baseUrl}/api/loops/${loopId}`);
      const loopDataBeforeStop = await loopBeforeStop.json();
      const originalWorkingBranch = loopDataBeforeStop.state.git?.workingBranch;
      expect(originalWorkingBranch).toBeDefined();
      expect(originalWorkingBranch).not.toContain("ralph/");
      expect(originalWorkingBranch).toMatch(/-[0-9a-f]{7}$/);

      // Stop the loop
      await loopManager.stopLoop(loopId);
      await waitForLoopStatus(loopId, ["stopped"]);

      // Jumpstart the loop with a message
      const pendingRes = await fetch(`${baseUrl}/api/loops/${loopId}/pending`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Continue on the same branch",
        }),
      });
      expect(pendingRes.status).toBe(200);

      // Wait for it to be running again
      await waitForLoopStatus(loopId, ["starting", "running"]);

      // Verify it's still on the same working branch
      const loopAfterJumpstart = await fetch(`${baseUrl}/api/loops/${loopId}`);
      const loopDataAfterJumpstart = await loopAfterJumpstart.json();
      const currentWorkingBranch = loopDataAfterJumpstart.state.git?.workingBranch;

      // The working branch should be the same as before the stop
      expect(currentWorkingBranch).toBe(originalWorkingBranch);

      // Clean up
      await loopManager.stopLoop(loopId);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
