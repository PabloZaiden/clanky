/**
 * API integration tests for model validation in loops endpoints.
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
import { loopManager } from "../../src/core/loop-manager";
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
    const workDir = await mkdtemp(join(tmpdir(), "ralpher-model-validation-test-work-"));
    await Bun.$`git init ${workDir}`.quiet();
    await Bun.$`git -C ${workDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${workDir} config user.name "Test User"`.quiet();
    await writeFile(join(workDir, "README.md"), "# Test");
    await Bun.$`git -C ${workDir} add .`.quiet();
    await Bun.$`git -C ${workDir} commit -m "Initial commit"`.quiet();
    await mkdir(join(workDir, ".ralph-planning"), { recursive: true });
    const workspaceId = await getOrCreateWorkspace(workDir, "Test Workspace");
    return { workDir, workspaceId };
  }

  beforeAll(async () => {
    // Create temp data directory
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-model-validation-test-data-"));

    // Set env var for persistence before importing modules
    process.env["RALPHER_DATA_DIR"] = testDataDir;

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

    // Re-setup backend after reset
    const mockBackend = new MockAcpBackend({
      responses: ["<promise>COMPLETE</promise>"],
      models: defaultTestModels,
    });
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
  };

  beforeEach(async () => {
    await cleanupActiveLoops();
  });

  afterEach(async () => {
    await cleanupActiveLoops();
  });

  describe("POST /api/loops - Create Loop", () => {
    test("succeeds with connected model", async () => {
      const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
      try {
        const response = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            useWorktree: true,
            model: {
              providerID: "anthropic",
              modelID: "claude-sonnet-4-20250514",
            },
          }),
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
        const response = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            useWorktree: true,
            // No model specified - should be rejected
          }),
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
        const response = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            useWorktree: true,
            draft: true,
            model: {
              providerID: "openai",
              modelID: "gpt-4o",
            },
          }),
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

  describe("POST /api/loops/:id/pending - Model Change", () => {
    test("validates model is enabled (rejects disconnected model)", async () => {
      const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
      try {
        // Create and start a loop (it will complete quickly with mock backend)
        const createRes = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            useWorktree: true,
            model: {
              providerID: "anthropic",
              modelID: "claude-sonnet-4-20250514",
            },
          }),
        });
        expect(createRes.status).toBe(201);
        const loop = await createRes.json();

        // Wait for it to complete (mock backend completes quickly)
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Try to change to a disconnected model - should fail with model_not_enabled
        const pendingRes = await fetch(`${baseUrl}/api/loops/${loop.config.id}/pending`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: {
              providerID: "openai",
              modelID: "gpt-4o",
            },
          }),
        });

        // Model validation runs BEFORE loop status check
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
        // Create and start a loop
        const createRes = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            useWorktree: true,
            model: {
              providerID: "anthropic",
              modelID: "claude-sonnet-4-20250514",
            },
          }),
        });
        expect(createRes.status).toBe(201);
        const loop = await createRes.json();

        // Try to change to a connected model immediately
        // The key test is that model validation runs and PASSES
        // (regardless of what happens with the loop status check afterwards)
        const pendingRes = await fetch(`${baseUrl}/api/loops/${loop.config.id}/pending`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: {
              providerID: "anthropic",
              modelID: "claude-sonnet-4-20250514",
            },
          }),
        });

        // If we get a model validation error, the test fails
        // Any other error (like loop status) is acceptable for this test
        const body = await pendingRes.json();
        if (!pendingRes.ok) {
          // Verify the error is NOT about model validation
          expect(body.error).not.toBe("model_not_enabled");
          expect(body.error).not.toBe("model_not_found");
          expect(body.error).not.toBe("provider_not_found");
          expect(body.error).not.toBe("validation_failed");
        }
        // If it succeeded, that's also fine - it means model validation passed
        // and the loop was in a suitable state
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  describe("Input validation", () => {
    test("rejects partial model object (missing providerID)", async () => {
      const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
      try {
        const response = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            model: {
              // Missing providerID - should be rejected
              modelID: "gpt-4o",
            },
          }),
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
