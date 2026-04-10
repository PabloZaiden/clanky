/**
 * API integration tests for model variant functionality.
 *
 * Tests verify that:
 * - getModels() returns variants correctly
 * - Last model preference includes variant
 * - Loop creation works with variant specified
 */

import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
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
import {
  MockAcpBackend,
  type MockModelInfo,
} from "../mocks/mock-backend";

describe("Model Variants API", () => {
  let testDataDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  // Models with variants for testing
  const modelsWithVariants: MockModelInfo[] = [
    {
      providerID: "anthropic",
      providerName: "Anthropic",
      modelID: "claude-sonnet-4-20250514",
      modelName: "Claude Sonnet 4",
      connected: true,
      variants: ["", "thinking"], // Empty string = default, "thinking" = extended thinking
    },
    {
      providerID: "anthropic",
      providerName: "Anthropic",
      modelID: "claude-opus-4",
      modelName: "Claude Opus 4",
      connected: true,
      variants: ["thinking"], // Only thinking variant, no default
    },
    {
      providerID: "openai",
      providerName: "OpenAI",
      modelID: "gpt-4o",
      modelName: "GPT-4o",
      connected: true,
      // No variants
    },
  ];

  // Helper to get or create a workspace for a directory
  async function getOrCreateWorkspace(
    directory: string,
    name?: string
  ): Promise<string> {
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
  async function createTestWorkDirWithWorkspace(): Promise<{
    workDir: string;
    workspaceId: string;
  }> {
    const workDir = await mkdtemp(
      join(tmpdir(), "ralpher-model-variants-test-work-")
    );
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
    testDataDir = await mkdtemp(
      join(tmpdir(), "ralpher-model-variants-test-data-")
    );

    // Set env var for persistence before importing modules
    process.env["RALPHER_DATA_DIR"] = testDataDir;

    // Ensure directories exist
    await ensureDataDirectories();

    // Set up backend manager with mock that returns models with variants
    const mockBackend = new MockAcpBackend({
      responses: ["<promise>COMPLETE</promise>"],
      models: modelsWithVariants,
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
    const { listLoops, updateLoopState, loadLoop } = await import(
      "../../src/persistence/loops"
    );

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
      models: modelsWithVariants,
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

  // NOTE: GET /api/models endpoint creates its own backend instance,
  // so it cannot be tested with mocks. The variant functionality is 
  // tested through unit tests for the backend and integration tests
  // for loop creation with variants.

  describe("PUT /api/preferences/last-model - Last Model with Variant", () => {
    test("saves and retrieves last model with variant", async () => {
      // Set last model with a variant
      const putResponse = await fetch(`${baseUrl}/api/preferences/last-model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
          variant: "thinking",
        }),
      });
      expect(putResponse.status).toBe(200);

      // Get it back
      const getResponse = await fetch(`${baseUrl}/api/preferences/last-model`);
      expect(getResponse.status).toBe(200);

      const lastModel = await getResponse.json();
      expect(lastModel.providerID).toBe("anthropic");
      expect(lastModel.modelID).toBe("claude-sonnet-4-20250514");
      expect(lastModel.variant).toBe("thinking");
    });

    test("saves and retrieves last model with empty variant", async () => {
      // Set last model with empty variant (default)
      const putResponse = await fetch(`${baseUrl}/api/preferences/last-model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
          variant: "",
        }),
      });
      expect(putResponse.status).toBe(200);

      // Get it back
      const getResponse = await fetch(`${baseUrl}/api/preferences/last-model`);
      expect(getResponse.status).toBe(200);

      const lastModel = await getResponse.json();
      expect(lastModel.providerID).toBe("anthropic");
      expect(lastModel.modelID).toBe("claude-sonnet-4-20250514");
      expect(lastModel.variant).toBe("");
    });

    test("saves and retrieves last model without variant", async () => {
      // Set last model without variant field
      const putResponse = await fetch(`${baseUrl}/api/preferences/last-model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerID: "openai",
          modelID: "gpt-4o",
        }),
      });
      expect(putResponse.status).toBe(200);

      // Get it back
      const getResponse = await fetch(`${baseUrl}/api/preferences/last-model`);
      expect(getResponse.status).toBe(200);

      const lastModel = await getResponse.json();
      expect(lastModel.providerID).toBe("openai");
      expect(lastModel.modelID).toBe("gpt-4o");
      expect(lastModel.variant).toBeUndefined();
    });
  });

  describe("POST /api/loops - Create Loop with Variant", () => {
    test("creates draft loop with model variant", async () => {
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
            draft: true, // Use draft mode to avoid starting the loop
            model: {
              providerID: "anthropic",
              modelID: "claude-sonnet-4-20250514",
              variant: "thinking",
            },
          }),
        });

        expect(response.status).toBe(201);
        const data = await response.json();
        expect(data.config.model.providerID).toBe("anthropic");
        expect(data.config.model.modelID).toBe("claude-sonnet-4-20250514");
        expect(data.config.model.variant).toBe("thinking");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    test("creates draft loop with empty variant (default)", async () => {
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
            draft: true, // Use draft mode to avoid starting the loop
            model: {
              providerID: "anthropic",
              modelID: "claude-sonnet-4-20250514",
              variant: "",
            },
          }),
        });

        expect(response.status).toBe(201);
        const data = await response.json();
        expect(data.config.model.providerID).toBe("anthropic");
        expect(data.config.model.modelID).toBe("claude-sonnet-4-20250514");
        expect(data.config.model.variant).toBe("");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    test("creates draft loop without variant specified", async () => {
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
            draft: true, // Use draft mode to avoid starting the loop
            model: {
              providerID: "openai",
              modelID: "gpt-4o",
            },
          }),
        });

        expect(response.status).toBe(201);
        const data = await response.json();
        expect(data.config.model.providerID).toBe("openai");
        expect(data.config.model.modelID).toBe("gpt-4o");
        expect(data.config.model.variant).toBeUndefined();
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  describe("POST /api/loops - Saves Last Model with Variant", () => {
    test("saves model with variant as last model when creating a loop", async () => {
      const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
      try {
        // Create a loop with a specific model and variant
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
              providerID: "anthropic",
              modelID: "claude-sonnet-4-20250514",
              variant: "thinking",
            },
          }),
        });

        expect(response.status).toBe(201);
        // Consume response body to avoid leaving the stream open
        await response.arrayBuffer();

        // Verify that the last model preference was saved with the variant
        const getResponse = await fetch(`${baseUrl}/api/preferences/last-model`);
        expect(getResponse.status).toBe(200);

        const lastModel = await getResponse.json();
        expect(lastModel.providerID).toBe("anthropic");
        expect(lastModel.modelID).toBe("claude-sonnet-4-20250514");
        expect(lastModel.variant).toBe("thinking");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    test("saves model with empty variant as last model when creating a loop", async () => {
      const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
      try {
        // Create a loop with an empty variant (default)
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
              providerID: "anthropic",
              modelID: "claude-sonnet-4-20250514",
              variant: "",
            },
          }),
        });

        expect(response.status).toBe(201);
        // Consume response body to avoid leaving the stream open
        await response.arrayBuffer();

        // Verify that the last model preference was saved with the empty variant
        const getResponse = await fetch(`${baseUrl}/api/preferences/last-model`);
        expect(getResponse.status).toBe(200);

        const lastModel = await getResponse.json();
        expect(lastModel.providerID).toBe("anthropic");
        expect(lastModel.modelID).toBe("claude-sonnet-4-20250514");
        expect(lastModel.variant).toBe("");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    test("saves model without variant field as last model when creating a loop", async () => {
      const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
      try {
        // Create a loop without a variant (for models that don't support variants)
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

        expect(response.status).toBe(201);
        // Consume response body to avoid leaving the stream open
        await response.arrayBuffer();

        // Verify that the last model preference was saved without variant
        const getResponse = await fetch(`${baseUrl}/api/preferences/last-model`);
        expect(getResponse.status).toBe(200);

        const lastModel = await getResponse.json();
        expect(lastModel.providerID).toBe("openai");
        expect(lastModel.modelID).toBe("gpt-4o");
        expect(lastModel.variant).toBeUndefined();
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });
});
