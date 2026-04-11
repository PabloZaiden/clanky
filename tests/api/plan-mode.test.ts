/**
 * API integration tests for Plan Mode endpoints.
 * Tests HTTP requests to plan mode API endpoints.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serve, type Server } from "bun";
import { apiRoutes } from "../../src/api";
import { ensureDataDirectories } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { closeDatabase } from "../../src/persistence/database";
import { PlanModeMockBackend } from "../mocks/mock-backend";

// Default test model for loop creation (model is now required)
const testModel = { providerID: "test-provider", modelID: "test-model" };

describe("Plan Mode API Integration", () => {
  let testDataDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let mockBackend: PlanModeMockBackend;
  
  // Per-test work directory to avoid conflicts between tests
  let currentTestWorkDir: string;
  let currentWorkspaceId: string;
  let currentRemoteDir: string;

  // Helper to get or create a workspace for a directory
  async function getOrCreateWorkspace(
    directory: string,
    name?: string,
    serverSettings?: Record<string, unknown>,
  ): Promise<string> {
    const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name || directory.split("/").pop() || "Test",
        directory,
        serverSettings,
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

  // Helper to check if file exists
  async function exists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
  }

  // Poll until loop reaches expected status
  async function waitForStatus(
    loopId: string,
    expectedStatuses: string[],
    timeoutMs = 10000
  ): Promise<Record<string, unknown>> {
    const startTime = Date.now();
    let lastStatus = "unknown";
    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/loops/${loopId}`);
      if (response.ok) {
        const loop = await response.json();
        lastStatus = loop.state?.status ?? "unknown";
        if (expectedStatuses.includes(lastStatus)) {
          return loop;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Loop ${loopId} did not reach status [${expectedStatuses.join(", ")}] within ${timeoutMs}ms. Last: ${lastStatus}`
    );
  }

  // Poll until isPlanReady becomes true
  async function waitForPlanReady(loopId: string, timeoutMs = 10000): Promise<Record<string, unknown>> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/loops/${loopId}`);
      if (response.ok) {
        const loop = await response.json();
        if (loop.state?.planMode?.isPlanReady === true) {
          return loop;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Plan for loop ${loopId} did not become ready within ${timeoutMs}ms`);
  }

  // Poll until file no longer exists
  async function waitForFileDeleted(filePath: string, timeoutMs = 5000): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (!(await exists(filePath))) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`File ${filePath} was not deleted within ${timeoutMs}ms`);
  }

  beforeAll(async () => {
    // Create temp data directory
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-api-plan-test-data-"));

    // Set env var for persistence
    process.env["RALPHER_DATA_DIR"] = testDataDir;
    await ensureDataDirectories();

    // Set up backend manager with class-based mock
    mockBackend = new PlanModeMockBackend();
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    // Start test server
    server = serve({
      port: 0,
      routes: {
        ...apiRoutes,
      },
    });

    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    // Stop server
    server.stop(true);

    // Clean up
    backendManager.resetForTesting();
    closeDatabase();
    delete process.env["RALPHER_DATA_DIR"];

    // Remove temp data directory
    await rm(testDataDir, { recursive: true });
  });

  // Helper to create a unique work directory with git initialized
  async function createTestWorkDir(): Promise<string> {
    const workDir = await mkdtemp(join(tmpdir(), "ralpher-api-plan-test-work-"));
    await Bun.$`git init ${workDir}`.quiet();
    await Bun.$`git -C ${workDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${workDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${workDir}/README.md`.quiet();
    await Bun.$`git -C ${workDir} add .`.quiet();
    await Bun.$`git -C ${workDir} commit -m "Initial commit"`.quiet();
    currentRemoteDir = await mkdtemp(join(tmpdir(), "ralpher-api-plan-test-remote-"));
    await Bun.$`git init --bare ${currentRemoteDir}`.quiet();
    await Bun.$`git -C ${workDir} remote add origin ${currentRemoteDir}`.quiet();
    const currentBranch = (await Bun.$`git -C ${workDir} branch --show-current`.text()).trim();
    await Bun.$`git -C ${workDir} push -u origin ${currentBranch}`.quiet();
    await Bun.$`git -C ${currentRemoteDir} symbolic-ref HEAD refs/heads/${currentBranch}`.quiet();
    return workDir;
  }

  // Helper to create a unique work directory with git initialized AND workspace
  async function createTestWorkDirWithWorkspace(): Promise<{ workDir: string; workspaceId: string }> {
    const workDir = await createTestWorkDir();
    const workspaceId = await getOrCreateWorkspace(workDir, "Test Workspace");
    return { workDir, workspaceId };
  }

  // Clean up any active loops and reset state before/after each test
  const setupAndCleanup = async () => {
    const { listLoops, updateLoopState, loadLoop } = await import("../../src/persistence/loops");
    const { loopManager } = await import("../../src/core/loop-manager");
    
    // Clear all running engines first
    loopManager.resetForTesting();
    
    // Reset the mock backend state
    mockBackend.reset();
    
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
    
    // Create a fresh work directory and workspace for this test
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    currentTestWorkDir = workDir;
    currentWorkspaceId = workspaceId;
  };
  
  const teardownTest = async () => {
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
    
    // Clean up the test work directory
    if (currentTestWorkDir) {
      await rm(currentTestWorkDir, { recursive: true, force: true });
    }
    if (currentRemoteDir) {
      await rm(currentRemoteDir, { recursive: true, force: true });
    }
  };

  beforeEach(setupAndCleanup);
  afterEach(teardownTest);

  describe("GET /api/check-planning-dir", () => {
    test("treats a .ralph-planning directory with only .gitkeep as empty", async () => {
      const planningDir = join(currentTestWorkDir, ".ralph-planning");
      await mkdir(planningDir, { recursive: true });
      await writeFile(join(planningDir, ".gitkeep"), "");

      const response = await fetch(
        `${baseUrl}/api/check-planning-dir?directory=${encodeURIComponent(currentTestWorkDir)}&workspaceId=${encodeURIComponent(currentWorkspaceId)}`,
      );

      expect(response.ok).toBe(true);
      const data = await response.json() as {
        exists: boolean;
        hasFiles: boolean;
        files: string[];
        warning?: string;
      };
      expect(data.exists).toBe(true);
      expect(data.hasFiles).toBe(false);
      expect(data.files).toEqual([]);
      expect(data.warning).toBeUndefined();
    });
  });

  describe("POST /api/loops (plan mode)", () => {
    test("creates loop in planning status when planMode is true", async () => {
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Create a plan",
          name: "Test Loop",
          workspaceId: currentWorkspaceId,
          maxIterations: 1,
          planMode: true,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.config?.id).toBeDefined();

      // Get the loop and verify status
      const getResponse = await fetch(`${baseUrl}/api/loops/${data.config.id}`);
      expect(getResponse.ok).toBe(true);
      const loop = await getResponse.json();
      expect(loop.state.status).toBe("planning");
      expect(loop.state.planMode?.active).toBe(true);
    });

    test("clears planning folder before plan creation when clearPlanningFolder is true", async () => {
      // Setup: Create existing files in .ralph-planning folder and commit them
      // (files must be committed so they appear in the worktree)
      const planningDir = join(currentTestWorkDir, ".ralph-planning");
      await mkdir(planningDir, { recursive: true });
      await writeFile(join(planningDir, "old-plan.md"), "Old content");
      await Bun.$`git -C ${currentTestWorkDir} add .`.quiet();
      await Bun.$`git -C ${currentTestWorkDir} commit -m "Add old plan file"`.quiet();

      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Create a plan",
          name: "Test Loop",
          workspaceId: currentWorkspaceId,
          maxIterations: 1,
          clearPlanningFolder: true,
          planMode: true,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();

      // Wait for planning status to get the worktree path
      const planLoop = await waitForStatus(data.config.id, ["planning"]);
      const worktreePath = (planLoop as { state: { git?: { worktreePath?: string } } }).state.git?.worktreePath;
      expect(worktreePath).toBeDefined();

      // The planning folder is cleared in the worktree, not the main checkout
      const wtPlanningDir = join(worktreePath!, ".ralph-planning");
      await waitForFileDeleted(join(wtPlanningDir, "old-plan.md"));

      // Verify file was cleared in worktree
      expect(await exists(join(wtPlanningDir, "old-plan.md"))).toBe(false);

      // Verify state tracks clearing
      const getResponse2 = await fetch(`${baseUrl}/api/loops/${data.config.id}`);
      const loop = await getResponse2.json();
      expect(loop.state.planMode?.planningFolderCleared).toBe(true);
    });

    test("returns 400 if required fields missing", async () => {
      const response = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Missing name, prompt, directory
          planMode: true,
        }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe("POST /api/loops/:id/plan/feedback", () => {
    test("sends feedback to AI and increments round counter", async () => {
      // Create a loop in plan mode
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Create a plan",
          name: "Test Loop",
          workspaceId: currentWorkspaceId,
          maxIterations: 1,
          planMode: true,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const response = await createResponse.json();
      expect(response.config).toBeDefined();
      const id = response.config.id;
      await waitForPlanReady(id);

      // Get initial feedback rounds
      let getResponse = await fetch(`${baseUrl}/api/loops/${id}`);
      let loop = await getResponse.json();
      expect(loop.state.planMode.feedbackRounds).toBe(0);

      // Send feedback
      const feedbackResponse = await fetch(`${baseUrl}/api/loops/${id}/plan/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback: "Please add more details",
        }),
      });

      expect(feedbackResponse.status).toBe(200);
      await waitForPlanReady(id);

      // Verify feedback rounds incremented
      getResponse = await fetch(`${baseUrl}/api/loops/${id}`);
      loop = await getResponse.json();
      expect(loop.state.planMode.feedbackRounds).toBe(1);
    });

    test("returns 400 if loop is not in planning status", async () => {
      // Create a normal loop (not plan mode)
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Do something",
          name: "Test Loop",
          workspaceId: currentWorkspaceId,
          maxIterations: 1,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const response = await createResponse.json();
      expect(response.config).toBeDefined();
      const id = response.config.id;

      // Try to send feedback (should fail)
      const feedbackResponse = await fetch(`${baseUrl}/api/loops/${id}/plan/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback: "This should fail",
        }),
      });

      expect(feedbackResponse.status).toBe(400);
    });

    test("returns 409 if loop not found", async () => {
      const response = await fetch(`${baseUrl}/api/loops/nonexistent/plan/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback: "Test",
        }),
      });

      expect(response.status).toBe(409);
    });
  });

  describe("POST /api/loops/:id/plan/accept", () => {
    test("transitions loop from planning to running", async () => {
      // Create loop in plan mode
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Create a plan",
          name: "Test Loop",
          workspaceId: currentWorkspaceId,
          maxIterations: 1,
          planMode: true,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const response = await createResponse.json();
      expect(response.config).toBeDefined();
      const id = response.config.id;
      await waitForPlanReady(id);

      // Verify in planning status
      let getResponse = await fetch(`${baseUrl}/api/loops/${id}`);
      let loop = await getResponse.json();
      expect(loop.state.status).toBe("planning");

      // Accept the plan
      const acceptResponse = await fetch(`${baseUrl}/api/loops/${id}/plan/accept`, {
        method: "POST",
      });

      expect(acceptResponse.status).toBe(200);
      
      // Wait for status transition from planning
      loop = await waitForStatus(id, ["running", "completed", "max_iterations", "stopped"]);
      expect(["running", "completed", "max_iterations", "stopped"]).toContain(loop.state.status);
    });

    test("accepts the plan in open_ssh mode and returns the linked ssh session", async () => {
      const sshWorkDir = await createTestWorkDir();
      try {
        const sshWorkspaceId = await getOrCreateWorkspace(sshWorkDir, "SSH Test Workspace", {
          agent: {
            provider: "opencode",
            transport: "ssh",
            hostname: "localhost",
            username: "tester",
          },
        });

        const createResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "Create a plan",
            name: "Test Loop",
            workspaceId: sshWorkspaceId,
            maxIterations: 1,
            planMode: true,
            autoAcceptPlan: false,
            model: testModel,
            useWorktree: true,
          }),
        });

        expect(createResponse.status).toBe(201);
        const response = await createResponse.json();
        const id = response.config.id;
        await waitForPlanReady(id);

        const acceptResponse = await fetch(`${baseUrl}/api/loops/${id}/plan/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "open_ssh" }),
        });

        expect(acceptResponse.status).toBe(200);
        const data = await acceptResponse.json();
        expect(data.success).toBe(true);
        expect(data.mode).toBe("open_ssh");
        expect(data.sshSession?.config?.loopId).toBe(id);

        const loop = await waitForStatus(id, ["completed"]);
        expect((loop["state"] as { status: string }).status).toBe("completed");
      } finally {
        await rm(sshWorkDir, { recursive: true, force: true });
      }
    });

    test("does not clear planning folder on accept", async () => {
      // IMPORTANT: Previous tests may leave us on a working branch, so we need to
      // checkout the base branch before creating the loop to ensure proper test isolation.
      // Get the default branch by checking if 'main' or 'master' exists (same logic as GitService.getDefaultBranch)
      const mainExists = await Bun.$`git -C ${currentTestWorkDir} rev-parse --verify main`.quiet().then(() => true).catch(() => false);
      const baseBranch = mainExists ? "main" : "master";
      
      // Checkout the base branch to ensure we're not on a working branch from previous tests
      await Bun.$`git -C ${currentTestWorkDir} checkout ${baseBranch}`.quiet();
      
      // Create loop with clear folder enabled
      const planningDir = join(currentTestWorkDir, ".ralph-planning-test2");
      await mkdir(planningDir, { recursive: true });

      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Create a plan",
          name: "Test Loop",
          workspaceId: currentWorkspaceId,
          planningFolderPath: ".ralph-planning-test2",
          maxIterations: 1,
          clearPlanningFolder: true,
          planMode: true,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const response = await createResponse.json();
      expect(response.config).toBeDefined();
      const id = response.config.id;
      await waitForPlanReady(id);

      // Create a plan file and commit it to the base branch.
      // When accept is called, the loop engine will switch to the base branch and
      // create a new working branch from it. The plan.md must exist on the base branch
      // so it will also exist on the new working branch.
      await writeFile(join(planningDir, "plan.md"), "# My Plan");
      await Bun.$`git -C ${currentTestWorkDir} add .`.quiet();
      await Bun.$`git -C ${currentTestWorkDir} commit -m "Add plan file"`.quiet();

      // Accept the plan
      const acceptResponse = await fetch(`${baseUrl}/api/loops/${id}/plan/accept`, { method: "POST" });
      if (acceptResponse.status !== 200) {
        const body = await acceptResponse.json();
        throw new Error(`Accept failed with ${acceptResponse.status}: ${JSON.stringify(body)}`);
      }
      
      await waitForStatus(id, ["running", "completed", "max_iterations", "stopped"]);

      // Verify plan still exists
      expect(await exists(join(planningDir, "plan.md"))).toBe(true);
    });

    test("returns 400 if loop is not in planning status", async () => {
      // Commit any previous changes first
      try {
        await Bun.$`git -C ${currentTestWorkDir} add -A`.quiet();
        await Bun.$`git -C ${currentTestWorkDir} commit -m "Test changes" --allow-empty`.quiet();
      } catch {
        // Ignore if nothing to commit
      }

      // Create normal loop
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Do something",
          name: "Test Loop",
          workspaceId: currentWorkspaceId,
          maxIterations: 1,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const response = await createResponse.json();
      expect(response.config).toBeDefined();
      const id = response.config.id;

      // Try to accept (should fail)
      const acceptResponse = await fetch(`${baseUrl}/api/loops/${id}/plan/accept`, {
        method: "POST",
      });

      expect(acceptResponse.status).toBe(400);
    });
  });

  describe("POST /api/loops/:id/plan/discard", () => {
    test("deletes the loop", async () => {
      // Commit any previous changes first
      try {
        await Bun.$`git -C ${currentTestWorkDir} add -A`.quiet();
        await Bun.$`git -C ${currentTestWorkDir} commit -m "Test changes" --allow-empty`.quiet();
      } catch {
        // Ignore if nothing to commit
      }

      // Create loop in plan mode
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Create a plan",
          name: "Test Loop",
          workspaceId: currentWorkspaceId,
          maxIterations: 1,
          planMode: true,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const response = await createResponse.json();
      expect(response.config).toBeDefined();
      const id = response.config.id;
      await waitForPlanReady(id);

      // Verify loop exists
      let getResponse = await fetch(`${baseUrl}/api/loops/${id}`);
      expect(getResponse.ok).toBe(true);

      // Discard the plan
      const discardResponse = await fetch(`${baseUrl}/api/loops/${id}/plan/discard`, {
        method: "POST",
      });

      expect(discardResponse.status).toBe(200);
      await waitForStatus(id, ["deleted"]);

      // Verify loop is marked as deleted (soft delete)
      getResponse = await fetch(`${baseUrl}/api/loops/${id}`);
      expect(getResponse.ok).toBe(true);
      const deletedLoop = await getResponse.json();
      expect(deletedLoop.state.status).toBe("deleted");
    });

    test("returns 404 if loop not found", async () => {
      const response = await fetch(`${baseUrl}/api/loops/nonexistent/plan/discard`, {
        method: "POST",
      });

      expect(response.status).toBe(404);
    });
  });
});
