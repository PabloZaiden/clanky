/**
 * API integration tests for loops CRUD endpoints.
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
import { TestCommandExecutor } from "../mocks/mock-executor";
import packageJson from "../../package.json";
import { createMockBackend } from "../mocks/mock-backend";

// Default test model for loop creation (model is now required)
const testModel = { providerID: "test-provider", modelID: "test-model", variant: "" };
const baseCreateLoopPayload = {
  attachments: [],
  cheapModel: { mode: "same-as-loop" as const },
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

describe("Loops CRUD API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let testWorkspaceId: string;
  let mockBackend: ReturnType<typeof createMockBackend>;

  // Helper function to poll for loop completion
  async function waitForLoopCompletion(loopId: string, timeoutMs = 10000): Promise<void> {
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
    throw new Error(`Loop ${loopId} did not complete within ${timeoutMs}ms. Last status: ${lastStatus}`);
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
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-api-crud-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "ralpher-api-crud-test-work-"));

    // Set env var for persistence before importing modules
    process.env["RALPHER_DATA_DIR"] = testDataDir;

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
          content: `crud-test-loop-${nameCounter}`,
          parts: [{ type: "text" as const, text: `crud-test-loop-${nameCounter}` }],
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
    delete process.env["RALPHER_DATA_DIR"];
  });

  // Clean up any active loops BEFORE each test to prevent blocking
  const cleanupActiveLoops = async () => {
    const { listLoops, updateLoopState, loadLoop } = await import("../../src/persistence/loops");
    const { loopManager } = await import("../../src/core/loop-manager");
    
    // Clear all running engines first
    loopManager.resetForTesting();
    
    const loops = await listLoops();
    const activeStatuses = ["idle", "planning", "starting", "running", "waiting"];
    
    for (const loop of loops) {
      if (activeStatuses.includes(loop.state.status)) {
        // Load full loop to get current state
        const fullLoop = await loadLoop(loop.config.id);
        if (fullLoop) {
          // Mark as deleted to make it a terminal state
          await updateLoopState(loop.config.id, {
            ...fullLoop.state,
            status: "deleted",
          });
        }
      }
    }
  };

  // Clean up before and after each test
  beforeEach(cleanupActiveLoops);
  afterEach(cleanupActiveLoops);

  describe("GET /api/health", () => {
    test("returns healthy status", async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.healthy).toBe(true);
      expect(body.version).toBe(packageJson.version);
    });
  });

  describe("POST /api/loops", () => {
    test("creates a new loop with required fields and preserves the provided name", async () => {
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Build something",
          name: "Test Loop",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.config.name).toBe("Test Loop");
      expect(body.config.directory).toBe(testWorkDir);
      expect(body.config.prompt).toBe("Build something");
      expect(body.config.id).toBeDefined();
      // Loops are auto-started on creation, so status should not be idle
      expect(["starting", "running", "completed"]).toContain(body.state.status);
    });

    test("creates a loop with optional fields", async () => {
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Custom task",
          name: "Test Loop",
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
      const { activityTimeoutSeconds: _activityTimeoutSeconds, ...payloadWithoutTimeout } = baseCreateLoopPayload;
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payloadWithoutTimeout,
          workspaceId: testWorkspaceId,
          prompt: "Use the default timeout",
          name: "Unlimited Timeout Loop",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.config.activityTimeoutSeconds).toBeNull();
    });

    test("creates a fully autonomous plan loop and forces auto-accept", async () => {
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Plan it and take it all the way through PR automation",
          name: "Fully Autonomous Loop",
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
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_json");
    });

    test("returns 400 for missing required fields", async () => {
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Loop",
          prompt: "Missing workspaceId",
          planMode: false,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("validation_error");
    });

    test("returns 400 for empty prompt", async () => {
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "",
          name: "Test Loop",
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
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
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
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
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

  describe("POST /api/loops/title", () => {
    test("generates a title explicitly from prompt and workspace", async () => {
      const response = await fetch(`${baseUrl}/api/loops/title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Build something",
          model: testModel,
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe("crud-test-loop-1");
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

      const response = await fetch(`${baseUrl}/api/loops/title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
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

      const response = await fetch(`${baseUrl}/api/loops/title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Build something",
          model: testModel,
        }),
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("title_generation_failed");
      expect(body.message).toContain("Failed to generate loop title");

      backendManager.setBackendForTesting(mockBackend);
    });
  });

  describe("GET /api/loops", () => {
    test("returns array of loops", async () => {
      const response = await fetch(`${baseUrl}/api/loops`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
      // Should have loops from previous tests
      expect(body.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/loops/:id", () => {
    test("returns a specific loop", async () => {
      // First create a draft loop (to avoid active loop conflicts)
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test prompt",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Then get it
      const response = await fetch(`${baseUrl}/api/loops/${loopId}`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.config.id).toBe(loopId);
    });

    test("returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent-id`);
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe("not_found");
    });
  });

  describe("PATCH /api/loops/:id", () => {
    test("updates a loop", async () => {
      // First create a draft loop (to avoid active loop conflicts)
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Original prompt",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Update the loop
      const response = await fetch(`${baseUrl}/api/loops/${loopId}`, {
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
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
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
      const loopId = createBody.config.id;

      const response = await fetch(`${baseUrl}/api/loops/${loopId}`, {
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

    test("updates a loop to use an unlimited activity timeout", async () => {
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
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
      const loopId = createBody.config.id;

      const response = await fetch(`${baseUrl}/api/loops/${loopId}`, {
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

    test("returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent-id`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name" }),
      });
      expect(response.status).toBe(404);
    });

    test("returns 400 for invalid JSON", async () => {
      // First create a draft loop (to avoid active loop conflicts)
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Try to update with invalid JSON
      const response = await fetch(`${baseUrl}/api/loops/${loopId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "invalid json",
      });
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("invalid_json");
    });

    test("returns 409 when useWorktree is changed after git setup", async () => {
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Immutable worktree mode",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      const { updateLoopState, loadLoop } = await import("../../src/persistence/loops");
      const loop = await loadLoop(loopId);
      expect(loop).not.toBeNull();

      await updateLoopState(loopId, {
        ...loop!.state,
        status: "completed",
        git: {
          originalBranch: "master",
          workingBranch: `${loopId}-a1b2c3d`,
          worktreePath: `${testWorkDir}/.ralph-worktrees/${loopId}`,
          commits: [],
        },
      });

      const response = await fetch(`${baseUrl}/api/loops/${loopId}`, {
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

  describe("DELETE /api/loops/:id", () => {
    test("deletes a loop", async () => {
      // First create a draft loop (to avoid active loop conflicts)
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test prompt",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Delete it
      const response = await fetch(`${baseUrl}/api/loops/${loopId}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);

      // Verify it's soft-deleted (still exists but with status "deleted")
      const getResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.state.status).toBe("deleted");
    });

    test("purges a deleted loop", async () => {
      // Create a draft loop first (to avoid active loop conflicts)
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Purge me",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Soft delete it
      await fetch(`${baseUrl}/api/loops/${loopId}`, { method: "DELETE" });

      // Purge it
      const purgeResponse = await fetch(`${baseUrl}/api/loops/${loopId}/purge`, {
        method: "POST",
      });
      expect(purgeResponse.status).toBe(200);

      // Verify it's actually deleted
      const getResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
      expect(getResponse.status).toBe(404);
    });

    test("returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent-id`, {
        method: "DELETE",
      });
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe("not_found");
    });
  });

  describe("clearPlanningFolder option", () => {
    test("creates a loop with clearPlanningFolder = true", async () => {
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Task with clearing",
          name: "Test Loop",
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

    test("creates a loop with clearPlanningFolder = false", async () => {
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Task without clearing",
          name: "Test Loop",
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

    test("creates a loop with clearPlanningFolder defaulting to false", async () => {
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Task with default",
          name: "Test Loop",
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
      // Create a draft loop with clearPlanningFolder = true
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test",
          name: "Test Loop",
          clearPlanningFolder: true,
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Get the loop and verify clearPlanningFolder is set
      const getResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
      expect(getResponse.status).toBe(200);

      const getBody = await getResponse.json();
      expect(getBody.config.clearPlanningFolder).toBe(true);
    });
  });

  describe("Draft loops", () => {
    test("creates a draft loop without starting", async () => {
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Draft task",
          name: "Test Loop",
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

    test("non-draft loops still auto-start", async () => {
      // Create a unique directory for this test to avoid conflicts with other tests
      const uniqueWorkDir = await mkdtemp(join(tmpdir(), "ralpher-non-draft-test-"));
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        const response = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...baseCreateLoopPayload,
            workspaceId,
            prompt: "Normal task",
            name: "Test Loop",
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
        await waitForLoopCompletion(body.config.id);
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("can update a draft loop via PUT", async () => {
      // Create draft
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Original prompt",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Update draft
      const updateResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
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

    test("cannot update non-draft loop via PUT", async () => {
      // Create a unique directory for this test to avoid conflicts
      const uniqueWorkDir = await mkdtemp(join(tmpdir(), "ralpher-put-test-"));
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create regular loop
        const createResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...baseCreateLoopPayload,
            workspaceId,
            prompt: "Task",
            name: "Test Loop",
            planMode: false,
          model: testModel,
          useWorktree: true,
          }),
        });
        expect(createResponse.status).toBe(201);
        const createBody = await createResponse.json();
        const loopId = createBody.config.id;

        // Wait for completion
        await waitForLoopCompletion(loopId);

        // Try to update
        const updateResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
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
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Task",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Start draft
      const startResponse = await fetch(`${baseUrl}/api/loops/${loopId}/draft/start`, {
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
      await waitForLoopCompletion(loopId);
      
      // Verify final state
      const getResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
      const getBody = await getResponse.json();
      expect(getBody.state.status).toBe("completed");
      expect(getBody.state.git).toBeDefined();
    });

    test("can start draft as plan mode", async () => {
      // Use a unique directory to avoid branch collision with previous test
      const uniqueWorkDir = await mkdtemp(join(tmpdir(), "ralpher-draft-plan-test-"));
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
        const createResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...baseCreateLoopPayload,
            workspaceId: uniqueWorkspaceId,
            prompt: "Plan mode draft task",
            name: "Test Loop",
            draft: true,
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const loopId = createBody.config.id;

        // Start draft in plan mode
        const startResponse = await fetch(`${baseUrl}/api/loops/${loopId}/draft/start`, {
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

    test("cannot start non-draft loop via draft/start", async () => {
      // Create a unique directory for this test to avoid conflicts
      const uniqueWorkDir = await mkdtemp(join(tmpdir(), "ralpher-start-test-"));
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a draft loop
        const draftResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...baseCreateLoopPayload,
            workspaceId,
            prompt: "Task",
            name: "Test Loop",
            draft: true,
            planMode: false,
          model: testModel,
          useWorktree: true,
          }),
        });
        const draftBody = await draftResponse.json();
        const draftLoopId = draftBody.config.id;
        
        // Start it immediately to make it a non-draft loop
        const startDraftResponse = await fetch(`${baseUrl}/api/loops/${draftLoopId}/draft/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planMode: false, attachments: [] }),
        });
        
        expect(startDraftResponse.status).toBe(200);
        await waitForLoopCompletion(draftLoopId);

        // Now the loop should be completed (non-draft)
        // Try to start via draft endpoint - should fail with not_draft (not 409)
        const startResponse = await fetch(`${baseUrl}/api/loops/${draftLoopId}/draft/start`, {
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

    test("can delete a draft loop", async () => {
      // Create draft
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Task",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Delete draft
      const deleteResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
        method: "DELETE",
      });

      expect(deleteResponse.status).toBe(200);

      // Verify it's soft-deleted (still exists but with status "deleted")
      const getResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.state.status).toBe("deleted");
    });

    test("draft prompt is preserved exactly as entered", async () => {
      const testPrompt = "This is a test prompt with special characters: @#$%^&*()";
      
      // Create draft
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: testPrompt,
          name: "Test Loop",
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
      const getResponse = await fetch(`${baseUrl}/api/loops/${createBody.config.id}`);
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
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: multiLinePrompt,
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      expect(createBody.config.prompt).toBe(multiLinePrompt);
      
      const loopId = createBody.config.id;

      // Fetch the draft and verify multi-line prompt is preserved
      const getResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.config.prompt).toBe(multiLinePrompt);

      // Update with a different multi-line prompt
      const updatedPrompt = `Updated line 1
Updated line 2
Updated line 3`;

      const updateResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
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
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Initial prompt v1",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;
      expect(createBody.config.prompt).toBe("Initial prompt v1");

      // First update
      const update1Response = await fetch(`${baseUrl}/api/loops/${loopId}`, {
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
      const update2Response = await fetch(`${baseUrl}/api/loops/${loopId}`, {
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
      const getResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.config.prompt).toBe("Final prompt v3");
    });
  });

  describe("POST /api/loops/:id/mark-merged", () => {
    test("returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent-id/mark-merged`, {
        method: "POST",
      });
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe("not_found");
    });

    test("returns 400 for loop not in final state", async () => {
      // Create a draft loop (not in final state)
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test mark merged",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Try to mark as merged
      const response = await fetch(`${baseUrl}/api/loops/${loopId}/mark-merged`, {
        method: "POST",
      });
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("mark_merged_failed");
      expect(body.message).toContain("Cannot mark loop as merged");
    });

    test("returns 400 for loop without git state", async () => {
      // Create a loop, complete it, but ensure it has no git state
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test no git",
          name: "Test Loop",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Wait for completion
      await waitForLoopCompletion(loopId);

      // Manually update loop to completed without git state
      // This simulates a loop that was completed without git integration
      const { updateLoopState, loadLoop } = await import("../../src/persistence/loops");
      const loop = await loadLoop(loopId);
      if (loop) {
        await updateLoopState(loopId, {
          ...loop.state,
          git: undefined, // Remove git state
        });
      }

      // Try to mark as merged
      const response = await fetch(`${baseUrl}/api/loops/${loopId}/mark-merged`, {
        method: "POST",
      });
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("mark_merged_failed");
      expect(body.message).toContain("No git branch");
    });

    test("marks a completed loop as merged and preserves merged status", async () => {
      // Create and complete a loop
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test mark merged",
          name: "Test Loop",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Wait for completion
      await waitForLoopCompletion(loopId);

      // Mark as merged
      const response = await fetch(`${baseUrl}/api/loops/${loopId}/mark-merged`, {
        method: "POST",
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);

      // Verify loop status is now merged
      const getResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.state.status).toBe("merged");
    });
  });

  describe("POST /api/loops/:id/manual-complete", () => {
    test("returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent-id/manual-complete`, {
        method: "POST",
      });
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe("not_found");
    });

    test("returns 400 for loop that is not halted", async () => {
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test manual complete",
          name: "Manual Complete Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      const response = await fetch(`${baseUrl}/api/loops/${loopId}/manual-complete`, {
        method: "POST",
      });
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("manual_complete_failed");
      expect(body.message).toContain("Cannot manually complete loop");
    });

    test("promotes a failed loop to completed and clears the persisted error", async () => {
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test manual complete",
          name: "Manual Complete Loop",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      await waitForLoopCompletion(loopId);

      const { updateLoopState, loadLoop } = await import("../../src/persistence/loops");
      const loop = await loadLoop(loopId);
      expect(loop).toBeTruthy();

      await updateLoopState(loopId, {
        ...loop!.state,
        status: "failed",
        error: {
          message: "Manual completion regression",
          iteration: loop!.state.currentIteration,
          timestamp: new Date().toISOString(),
        },
      });
      const { loopManager } = await import("../../src/core/loop-manager");
      loopManager.resetForTesting();

      const response = await fetch(`${baseUrl}/api/loops/${loopId}/manual-complete`, {
        method: "POST",
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);

      const getResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.state.status).toBe("completed");
      expect(getBody.state.error).toBeUndefined();
    });
  });

  describe("Rename loops via PATCH", () => {
    test("renames a draft loop", async () => {
      // Create a draft loop
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test rename task",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;
      // Name is auto-generated from prompt, so we just verify it exists
      expect(createBody.config.name).toBeDefined();

      // Rename the loop
      const renameResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed Loop" }),
      });
      expect(renameResponse.status).toBe(200);
      const renameBody = await renameResponse.json();
      expect(renameBody.config.name).toBe("Renamed Loop");

      // Verify the name persists
      const getResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.config.name).toBe("Renamed Loop");
    });

    test("renames a completed loop", async () => {
      // Create a unique directory for this test
      const uniqueWorkDir = await mkdtemp(join(tmpdir(), "ralpher-rename-test-"));
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();

      try {
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create and complete a loop
        const createResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...baseCreateLoopPayload,
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
        const loopId = createBody.config.id;

        // Wait for completion
        await waitForLoopCompletion(loopId);

        // Rename after completion
        const renameResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "After Completion" }),
        });
        expect(renameResponse.status).toBe(200);
        const renameBody = await renameResponse.json();
        expect(renameBody.config.name).toBe("After Completion");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("trims whitespace from name", async () => {
      // Create a draft loop
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test trim",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Rename with whitespace
      const renameResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  Trimmed Name  " }),
      });
      expect(renameResponse.status).toBe(200);
      const renameBody = await renameResponse.json();
      expect(renameBody.config.name).toBe("Trimmed Name");
    });

    test("returns 404 for renaming non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent-id`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name" }),
      });
      expect(response.status).toBe(404);
    });

    test("returns 400 for empty name", async () => {
      // Create a draft loop
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test empty name",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Try to rename with empty string
      const renameResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
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
      // Create a draft loop
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test whitespace name",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Try to rename with whitespace-only string
      const renameResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
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
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateLoopPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test long rename",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      const renameResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
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
