/**
 * API integration tests for loops control endpoints.
 * Tests use actual HTTP requests to a test server.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
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
import { createMockBackend } from "../mocks/mock-backend";

// Default test model for loop creation (model is now required)
const testModel = { providerID: "test-provider", modelID: "test-model" };

describe("Loops Control API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let testBareRepoDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let testWorkspaceId: string;
  const tempDirsToCleanup = new Set<string>();

  // Helper function to poll for loop completion
  async function waitForLoopCompletion(loopId: string, timeoutMs = 10000): Promise<void> {
    const startTime = Date.now();
    let lastStatus = "";
    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/loops/${loopId}`);
      if (response.ok) {
        const data = await response.json();
        lastStatus = data.state?.status ?? "no state";
        if (lastStatus === "completed" || lastStatus === "failed") {
          return;
        }
      } else {
        lastStatus = `HTTP ${response.status}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Loop ${loopId} did not complete within ${timeoutMs}ms. Last status: ${lastStatus}`);
  }

  // Helper to create or get a workspace for a directory
  async function getOrCreateWorkspace(directory: string, name?: string): Promise<string> {
    // Try to create a workspace for this directory
    const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name || directory.split("/").pop() || "Test",
        directory,
      }),
    });
    const data = await createResponse.json();
    
    // If conflict (workspace exists), return the existing workspace ID
    if (createResponse.status === 409 && data.existingWorkspace) {
      return data.existingWorkspace.id;
    }
    
    // If created successfully, return the new workspace ID
    if (createResponse.ok && data.id) {
      return data.id;
    }
    
    throw new Error(`Failed to create workspace: ${JSON.stringify(data)}`);
  }

  async function createTrackedTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempDirsToCleanup.add(directory);
    return directory;
  }

  async function cleanupTrackedTempDirs(): Promise<void> {
    const directories = Array.from(tempDirsToCleanup);
    tempDirsToCleanup.clear();
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }

  beforeAll(async () => {
    // Create temp directories
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-api-control-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "ralpher-api-control-test-work-"));

    // Set env var for persistence before importing modules
    process.env["RALPHER_DATA_DIR"] = testDataDir;

    // Ensure directories exist
    await ensureDataDirectories();

    // Initialize git repo
    await Bun.$`git init ${testWorkDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
    
    // Add a fake remote for push tests (using local file path as a valid remote)
    testBareRepoDir = await mkdtemp(join(tmpdir(), "ralpher-api-control-test-bare-"));
    await Bun.$`git init --bare ${testBareRepoDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} remote add origin ${testBareRepoDir}`.quiet();
    
    await Bun.$`touch ${testWorkDir}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Initial commit"`.quiet();

    // Create .ralph-planning directory and commit it
    await mkdir(join(testWorkDir, ".ralph-planning"), { recursive: true });
    await writeFile(join(testWorkDir, ".ralph-planning/plan.md"), "# Test Plan\n\nThis is a test plan.");
    await writeFile(join(testWorkDir, ".ralph-planning/status.md"), "# Status\n\nIn progress.");
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Add planning files"`.quiet();

    // Set up backend manager with test executor factory
    backendManager.setBackendForTesting(createMockBackend());
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

    // Reset loop manager (stop any running loops)
    loopManager.resetForTesting();

    // Reset backend manager
    backendManager.resetForTesting();

    // Close database before deleting files
    closeDatabase();

    // Cleanup temp directories
    await rm(testDataDir, { recursive: true, force: true });
    await rm(testWorkDir, { recursive: true, force: true });
    await rm(testBareRepoDir, { recursive: true, force: true });

    // Clear env
    delete process.env["RALPHER_DATA_DIR"];
  });

  // Clean up any active loops before and after each test to prevent blocking
  const cleanupActiveLoops = async () => {
    const { listLoops, updateLoopState, loadLoop } = await import("../../src/persistence/loops");
    
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

  beforeEach(cleanupActiveLoops);
  afterEach(async () => {
    await cleanupActiveLoops();
    await cleanupTrackedTempDirs();
  });

  describe("POST /api/loops/:id/accept", () => {
    // Note: Loops are auto-started on creation by default, but they can still
    // remain in "idle" status if auto-start fails (e.g., git issues/uncommitted changes).
    
    test("returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent/accept`, {
        method: "POST",
      });

      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/loops/:id/discard", () => {
    test("succeeds for plan mode loop (git branch created at plan start)", async () => {
      // Create a loop in plan mode - git branch+worktree is now created at plan mode start
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: testWorkspaceId,
          prompt: "Test prompt",
          name: "Test Loop",
          planMode: true,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Plan mode loops now have git branches from the start, so discard should succeed
      const response = await fetch(`${baseUrl}/api/loops/${loopId}/discard`, {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
    });

    test("returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent/discard`, {
        method: "POST",
      });

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/loops/:id/diff", () => {
    test("returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent/diff`);
      expect(response.status).toBe(404);
    });

    test("returns 400 for loop without git branch (draft mode)", async () => {
      // Create a draft loop - no git branch is created until the loop is started
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
      expect(createResponse.status).toBe(201);
      expect(createBody.config).toBeDefined();
      const loopId = createBody.config.id;

      const response = await fetch(`${baseUrl}/api/loops/${loopId}/diff`);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("no_git_branch");
    });

    test("returns diff data for branch-only loops without a worktree", async () => {
      const diffTestDir = await createTrackedTempDir("ralpher-branch-only-diff-");
      await Bun.$`git init ${diffTestDir}`.quiet();
      await Bun.$`git -C ${diffTestDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${diffTestDir} config user.name "Test User"`.quiet();
      await writeFile(join(diffTestDir, "README.md"), "# Branch-only diff");
      await Bun.$`git -C ${diffTestDir} add .`.quiet();
      await Bun.$`git -C ${diffTestDir} commit -m "Initial commit"`.quiet();

      const workspaceId = await getOrCreateWorkspace(diffTestDir);
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          prompt: "Test branch-only diff",
          name: "Test Loop",
          planMode: false,
          model: testModel,
          useWorktree: false,
        }),
      });
      const createBody = await createResponse.json();
      expect(createResponse.status).toBe(201);
      const loopId = createBody.config.id;

      await waitForLoopCompletion(loopId);
      const loopResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
      const loopBody = await loopResponse.json();
      expect(loopBody.state.status).toBe("completed");
      expect(loopBody.state.git).toBeDefined();

      const response = await fetch(`${baseUrl}/api/loops/${loopId}/diff`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);

      await rm(diffTestDir, { recursive: true, force: true });
    });
  });

  describe("GET /api/loops/:id/plan", () => {
    test("returns plan.md content", async () => {
      // Create a fresh workdir with .ralph-planning to avoid pollution from other tests
      const planTestDir = await createTrackedTempDir("ralpher-plan-test-");
      await Bun.$`git init ${planTestDir}`.quiet();
      await Bun.$`git -C ${planTestDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${planTestDir} config user.name "Test User"`.quiet();
      await writeFile(join(planTestDir, "README.md"), "# Test");
      await mkdir(join(planTestDir, ".ralph-planning"), { recursive: true });
      await writeFile(join(planTestDir, ".ralph-planning/plan.md"), "# Test Plan\n\nThis is a test plan.");
      await Bun.$`git -C ${planTestDir} add .`.quiet();
      await Bun.$`git -C ${planTestDir} commit -m "Initial commit"`.quiet();

      // Create workspace for this directory
      const workspaceId = await getOrCreateWorkspace(planTestDir);

      // Start the loop (non-draft) so a worktree is created.
      // The mock backend completes immediately, and the worktree inherits
      // the .ralph-planning/plan.md file from the main repo's branch.
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          prompt: "Test",
          name: "Test Loop",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      expect(createBody.config).toBeDefined();
      const loopId = createBody.config.id;

      // Wait for the loop to complete so the worktree is fully set up
      await waitForLoopCompletion(loopId);

      const response = await fetch(`${baseUrl}/api/loops/${loopId}/plan`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.exists).toBe(true);
      expect(body.content).toContain("# Test Plan");

      await rm(planTestDir, { recursive: true, force: true });
    });

    test("returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent/plan`);
      expect(response.status).toBe(404);
    });

    test("returns plan.md content for branch-only loops without a worktree", async () => {
      const branchOnlyPlanDir = await createTrackedTempDir("ralpher-branch-only-plan-");
      await Bun.$`git init ${branchOnlyPlanDir}`.quiet();
      await Bun.$`git -C ${branchOnlyPlanDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${branchOnlyPlanDir} config user.name "Test User"`.quiet();
      await writeFile(join(branchOnlyPlanDir, "README.md"), "# Branch-only plan");
      await mkdir(join(branchOnlyPlanDir, ".ralph-planning"), { recursive: true });
      await writeFile(join(branchOnlyPlanDir, ".ralph-planning/plan.md"), "# Branch-only Plan\n\nPlan content.");
      await Bun.$`git -C ${branchOnlyPlanDir} add .`.quiet();
      await Bun.$`git -C ${branchOnlyPlanDir} commit -m "Initial commit"`.quiet();

      const workspaceId = await getOrCreateWorkspace(branchOnlyPlanDir);
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          prompt: "Read branch-only plan",
          name: "Test Loop",
          planMode: false,
          model: testModel,
          useWorktree: false,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      await waitForLoopCompletion(loopId);

      const response = await fetch(`${baseUrl}/api/loops/${loopId}/plan`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.exists).toBe(true);
      expect(body.content).toContain("# Branch-only Plan");

      await rm(branchOnlyPlanDir, { recursive: true, force: true });
    });

    test("returns 400 for draft loop without worktree", async () => {
      // Create a new workdir (with git but without .ralph-planning)
      const emptyWorkDir = await createTrackedTempDir("ralpher-empty-work-");
      await Bun.$`git init ${emptyWorkDir}`.quiet();
      await Bun.$`git -C ${emptyWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${emptyWorkDir} config user.name "Test User"`.quiet();
      await writeFile(join(emptyWorkDir, "README.md"), "# Empty");
      await Bun.$`git -C ${emptyWorkDir} add .`.quiet();
      await Bun.$`git -C ${emptyWorkDir} commit -m "Initial commit"`.quiet();

      // Create workspace for this directory
      const workspaceId = await getOrCreateWorkspace(emptyWorkDir);

      // Use draft mode -- no worktree is created
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          prompt: "Test",
          name: "Test Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      expect(createBody.config).toBeDefined();
      const loopId = createBody.config.id;

      const response = await fetch(`${baseUrl}/api/loops/${loopId}/plan`);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("no_worktree");

      await rm(emptyWorkDir, { recursive: true, force: true });
    });
  });

  describe("GET /api/loops/:id/pull-request", () => {
    test("returns PR navigation metadata from the loop manager", async () => {
      const destinationSpy = spyOn(loopManager, "getPullRequestDestination").mockResolvedValue({
        enabled: true,
        destinationType: "existing_pr",
        url: "https://github.com/example/repo/pull/12",
      });

      try {
        const response = await fetch(`${baseUrl}/api/loops/test-loop-id/pull-request`);

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({
          enabled: true,
          destinationType: "existing_pr",
          url: "https://github.com/example/repo/pull/12",
        });
      } finally {
        destinationSpy.mockRestore();
      }
    });

    test("returns 404 when the loop manager cannot resolve the loop", async () => {
      const destinationSpy = spyOn(loopManager, "getPullRequestDestination").mockResolvedValue(null);

      try {
        const response = await fetch(`${baseUrl}/api/loops/non-existent/pull-request`);

        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body.error).toBe("not_found");
      } finally {
        destinationSpy.mockRestore();
      }
    });
  });

  describe("GET /api/loops/:id/status-file", () => {
    test("returns status.md content", async () => {
      // Create a fresh workdir with .ralph-planning to avoid pollution from other tests
      const statusTestDir = await createTrackedTempDir("ralpher-status-test-");
      await Bun.$`git init ${statusTestDir}`.quiet();
      await Bun.$`git -C ${statusTestDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${statusTestDir} config user.name "Test User"`.quiet();
      await writeFile(join(statusTestDir, "README.md"), "# Test");
      await mkdir(join(statusTestDir, ".ralph-planning"), { recursive: true });
      await writeFile(join(statusTestDir, ".ralph-planning/status.md"), "# Status\n\nIn progress.");
      await Bun.$`git -C ${statusTestDir} add .`.quiet();
      await Bun.$`git -C ${statusTestDir} commit -m "Initial commit"`.quiet();

      // Create workspace for this directory
      const workspaceId = await getOrCreateWorkspace(statusTestDir);

      // Start the loop (non-draft) so a worktree is created.
      // The mock backend completes immediately, and the worktree inherits
      // the .ralph-planning/status.md file from the main repo's branch.
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          prompt: "Test",
          name: "Test Loop",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      expect(createBody.config).toBeDefined();
      const loopId = createBody.config.id;

      // Wait for the loop to complete so the worktree is fully set up
      await waitForLoopCompletion(loopId);

      const response = await fetch(`${baseUrl}/api/loops/${loopId}/status-file`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.exists).toBe(true);
      expect(body.content).toContain("# Status");

      await rm(statusTestDir, { recursive: true, force: true });
    });

    test("returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent/status-file`);
      expect(response.status).toBe(404);
    });

    test("returns status.md content for branch-only loops without a worktree", async () => {
      const branchOnlyStatusDir = await createTrackedTempDir("ralpher-branch-only-status-");
      await Bun.$`git init ${branchOnlyStatusDir}`.quiet();
      await Bun.$`git -C ${branchOnlyStatusDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${branchOnlyStatusDir} config user.name "Test User"`.quiet();
      await writeFile(join(branchOnlyStatusDir, "README.md"), "# Branch-only status");
      await mkdir(join(branchOnlyStatusDir, ".ralph-planning"), { recursive: true });
      await writeFile(join(branchOnlyStatusDir, ".ralph-planning/status.md"), "# Branch-only Status\n\nStatus content.");
      await Bun.$`git -C ${branchOnlyStatusDir} add .`.quiet();
      await Bun.$`git -C ${branchOnlyStatusDir} commit -m "Initial commit"`.quiet();

      const workspaceId = await getOrCreateWorkspace(branchOnlyStatusDir);
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          prompt: "Read branch-only status",
          name: "Test Loop",
          planMode: false,
          model: testModel,
          useWorktree: false,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      await waitForLoopCompletion(loopId);

      const response = await fetch(`${baseUrl}/api/loops/${loopId}/status-file`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.exists).toBe(true);
      expect(body.content).toContain("# Branch-only Status");

      await rm(branchOnlyStatusDir, { recursive: true, force: true });
    });
  });

  describe("Pending Prompt API", () => {
    test("PUT /api/loops/:id/pending-prompt returns 409 when loop is not running", async () => {
      // Use unique directory to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("ralpher-pending-prompt-test-");
      await Bun.$`git init ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a loop - it will auto-start and complete immediately with mock backend
        const createResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const loopId = createBody.config.id;

        // Wait for the loop to complete
        await waitForLoopCompletion(loopId);

        // Try to set pending prompt on completed loop
        const response = await fetch(`${baseUrl}/api/loops/${loopId}/pending-prompt`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "New prompt" }),
        });

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body.error).toBe("not_running");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("PUT /api/loops/:id/pending-prompt requires prompt in body", async () => {
      // Use unique directory to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("ralpher-pending-body-test-");
      await Bun.$`git init ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        const createResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const loopId = createBody.config.id;

        // Try without prompt
        const response = await fetch(`${baseUrl}/api/loops/${loopId}/pending-prompt`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toBe("validation_error");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("PUT /api/loops/:id/pending-prompt rejects empty prompt", async () => {
      // Use unique directory to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("ralpher-pending-empty-test-");
      await Bun.$`git init ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        const createResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const loopId = createBody.config.id;

        // Try with empty prompt
        const response = await fetch(`${baseUrl}/api/loops/${loopId}/pending-prompt`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "   " }),
        });

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toBe("validation_error");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("DELETE /api/loops/:id/pending-prompt returns 409 when loop is not running", async () => {
      // Use unique directory to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("ralpher-pending-del-test-");
      await Bun.$`git init ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a loop - it will auto-start and complete immediately with mock backend
        const createResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const loopId = createBody.config.id;

        // Wait for the loop to complete
        await waitForLoopCompletion(loopId);

        const response = await fetch(`${baseUrl}/api/loops/${loopId}/pending-prompt`, {
          method: "DELETE",
        });

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body.error).toBe("not_running");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("PUT /api/loops/:id/pending-prompt returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent/pending-prompt`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Test" }),
      });
      expect(response.status).toBe(404);
    });

    test("DELETE /api/loops/:id/pending-prompt returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent/pending-prompt`, {
        method: "DELETE",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("Review Comments API", () => {
    test("GET /api/loops/:id/comments returns empty array for new loop", async () => {
      // Use unique directory to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("ralpher-comments-empty-test-");
      await Bun.$`git init ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        const createResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const loopId = createBody.config.id;

        const response = await fetch(`${baseUrl}/api/loops/${loopId}/comments`);

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.success).toBe(true);
        expect(body.comments).toEqual([]);
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("GET /api/loops/:id/comments returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent/comments`);
      expect(response.status).toBe(404);
    });

    test("POST /api/loops/:id/address-comments stores and returns comment IDs", async () => {
      // Use unique directory with bare repo to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("ralpher-comments-store-test-");
      const uniqueBareRepo = await createTrackedTempDir("ralpher-comments-store-bare-");
      await Bun.$`git init --bare ${uniqueBareRepo}`.quiet();
      await Bun.$`git init ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} remote add origin ${uniqueBareRepo}`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a loop
        const createResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const loopId = createBody.config.id;

        // Wait for loop to complete
        await waitForLoopCompletion(loopId);

        // Push the loop to enable review mode
        const pushResponse = await fetch(`${baseUrl}/api/loops/${loopId}/push`, { method: "POST" });
        if (pushResponse.status !== 200) {
          const pushBody = await pushResponse.json();
          const loopResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
          const loopData = await loopResponse.json();
          throw new Error(`Push failed with status ${pushResponse.status}: ${JSON.stringify(pushBody)}. Loop state: ${JSON.stringify(loopData.state)}`);
        }
        expect(pushResponse.status).toBe(200);

        // Submit comments
        const commentsText = "Please add error handling\nImprove test coverage";
        const addressResponse = await fetch(`${baseUrl}/api/loops/${loopId}/address-comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comments: commentsText }),
        });

        if (addressResponse.status !== 200) {
          const errorBody = await addressResponse.json();
          throw new Error(`Address comments failed: ${JSON.stringify(errorBody)}`);
        }
        expect(addressResponse.status).toBe(200);
        const addressBody = await addressResponse.json();
        expect(addressBody.success).toBe(true);
        expect(addressBody.commentIds).toBeInstanceOf(Array);
        expect(addressBody.commentIds.length).toBeGreaterThan(0);

        // Verify comments are stored
        const commentsResponse = await fetch(`${baseUrl}/api/loops/${loopId}/comments`);
        expect(commentsResponse.status).toBe(200);
        const commentsBody = await commentsResponse.json();
        expect(commentsBody.success).toBe(true);
        expect(commentsBody.comments).toBeInstanceOf(Array);
        expect(commentsBody.comments.length).toBeGreaterThan(0);
        expect(commentsBody.comments[0].commentText).toBe(commentsText);
        expect(commentsBody.comments[0].reviewCycle).toBe(1);
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
        await rm(uniqueBareRepo, { recursive: true, force: true });
      }
    });

    test("POST /api/loops/:id/address-comments returns 400 for loop not in review mode", async () => {
      // Use unique directory to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("ralpher-comments-notreview-test-");
      await Bun.$`git init ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a loop without review mode
        const createResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const loopId = createBody.config.id;

        // Wait for loop to complete
        await waitForLoopCompletion(loopId);

        // Try to address comments without enabling review mode (no push)
        const response = await fetch(`${baseUrl}/api/loops/${loopId}/address-comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comments: "Some comment" }),
        });

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain("not addressable");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("POST /api/loops/:id/address-comments returns 404 for non-existent loop", async () => {
      const response = await fetch(`${baseUrl}/api/loops/non-existent/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: "Some comment" }),
      });
      expect(response.status).toBe(404);
    });

    test("GET /api/loops/:id/comments returns comments in correct order", async () => {
      // Use unique directory with bare repo to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("ralpher-comments-order-test-");
      const uniqueBareRepo = await createTrackedTempDir("ralpher-comments-order-bare-");
      await Bun.$`git init --bare ${uniqueBareRepo}`.quiet();
      await Bun.$`git init ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} remote add origin ${uniqueBareRepo}`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a loop
        const createResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const loopId = createBody.config.id;

        // Wait for completion and push
        await waitForLoopCompletion(loopId);
        const pushResponse = await fetch(`${baseUrl}/api/loops/${loopId}/push`, { method: "POST" });
        expect(pushResponse.status).toBe(200);

        // Add comments
        const addressResponse = await fetch(`${baseUrl}/api/loops/${loopId}/address-comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comments: "First comment" }),
        });
        expect(addressResponse.status).toBe(200);

        // Get comments - should be ordered correctly
        const response = await fetch(`${baseUrl}/api/loops/${loopId}/comments`);
        expect(response.status).toBe(200);
        const body = await response.json();

        // Should have at least one comment
        expect(body.comments.length).toBeGreaterThan(0);
        
        // First comment should be from cycle 1
        expect(body.comments[0].reviewCycle).toBe(1);
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
        await rm(uniqueBareRepo, { recursive: true, force: true });
      }
    });

    test("Comments can be queried via GET endpoint", async () => {
      // Use unique directory with bare repo to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("ralpher-comments-get-test-");
      const uniqueBareRepo = await createTrackedTempDir("ralpher-comments-get-bare-");
      await Bun.$`git init --bare ${uniqueBareRepo}`.quiet();
      await Bun.$`git init ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} remote add origin ${uniqueBareRepo}`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a loop
        const createResponse = await fetch(`${baseUrl}/api/loops`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            prompt: "Test prompt",
            name: "Test Loop",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const loopId = createBody.config.id;

        // Wait for first completion
        await waitForLoopCompletion(loopId);

        // Push the loop
        const pushResponse = await fetch(`${baseUrl}/api/loops/${loopId}/push`, { method: "POST" });
        expect(pushResponse.status).toBe(200);

        // Add comments
        const addressResponse = await fetch(`${baseUrl}/api/loops/${loopId}/address-comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comments: "Test comment" }),
        });
        expect(addressResponse.status).toBe(200);

        // Get comments - verify they exist and contain the correct data
        const commentsResponse = await fetch(`${baseUrl}/api/loops/${loopId}/comments`);
        const commentsBody = await commentsResponse.json();
        expect(commentsBody.success).toBe(true);
        expect(commentsBody.comments.length).toBeGreaterThan(0);
        expect(commentsBody.comments[0].commentText).toBe("Test comment");
        expect(commentsBody.comments[0].reviewCycle).toBe(1);
        expect(commentsBody.comments[0].loopId).toBe(loopId);
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
        await rm(uniqueBareRepo, { recursive: true, force: true });
      }
    });
  });
});
