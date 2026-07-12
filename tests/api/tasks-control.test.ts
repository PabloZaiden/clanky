/**
 * API integration tests for tasks control endpoints.
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
import { taskManager } from "../../src/core/task-manager";
import { saveTask } from "../../src/persistence/tasks";
import { closeDatabase } from "../../src/persistence/database";
import { AUTOMATIC_PR_WORKFLOW_FAILURE_MESSAGE } from "../../src/core/automatic-pr-flow-github";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { createMockBackend } from "../mocks/mock-backend";

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

describe("Tasks Control API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let testBareRepoDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let testWorkspaceId: string;
  let mockBackend: ReturnType<typeof createMockBackend>;
  const tempDirsToCleanup = new Set<string>();

  // Helper function to poll for task completion
  async function waitForTaskCompletion(taskId: string, timeoutMs = 15000): Promise<void> {
    const startTime = Date.now();
    let lastStatus = "";
    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
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
    throw new Error(`Task ${taskId} did not complete within ${timeoutMs}ms. Last status: ${lastStatus}`);
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
        serverSettings: { agent: { provider: "opencode", transport: "stdio" } },
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
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-api-control-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "clanky-api-control-test-work-"));

    // Set env var for persistence before importing modules
    process.env["CLANKY_DATA_DIR"] = testDataDir;

    // Ensure directories exist
    await ensureDataDirectories();

    // Initialize git repo
    await Bun.$`git init -b main ${testWorkDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
    
    // Add a fake remote for push tests (using local file path as a valid remote)
    testBareRepoDir = await mkdtemp(join(tmpdir(), "clanky-api-control-test-bare-"));
    await Bun.$`git init --bare ${testBareRepoDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} remote add origin ${testBareRepoDir}`.quiet();
    
    await Bun.$`touch ${testWorkDir}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Initial commit"`.quiet();

    // Create .clanky-planning directory and commit it
    await mkdir(join(testWorkDir, ".clanky-planning"), { recursive: true });
    await writeFile(join(testWorkDir, ".clanky-planning/plan.md"), "# Test Plan\n\nThis is a test plan.");
    await writeFile(join(testWorkDir, ".clanky-planning/status.md"), "# Status\n\nIn progress.");
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Add planning files"`.quiet();

    // Set up backend manager with test executor factory
    mockBackend = createMockBackend();
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

    // Reset task manager (stop any running tasks)
    taskManager.resetForTesting();

    // Reset backend manager
    backendManager.resetForTesting();

    // Close database before deleting files
    closeDatabase();

    // Cleanup temp directories
    await rm(testDataDir, { recursive: true, force: true });
    await rm(testWorkDir, { recursive: true, force: true });
    await rm(testBareRepoDir, { recursive: true, force: true });

    // Clear env
    delete process.env["CLANKY_DATA_DIR"];
  });

  // Clean up any active tasks before and after each test to prevent blocking
  const cleanupActiveTasks = async () => {
    const { listTasks, updateTaskState, loadTask } = await import("../../src/persistence/tasks");
    
    // Clear all running engines first
    taskManager.resetForTesting();
    mockBackend = createMockBackend();
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
    
    const tasks = await listTasks();
    const activeStatuses = ["idle", "planning", "starting", "running", "waiting"];
    
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

  beforeEach(cleanupActiveTasks);
  afterEach(async () => {
    await cleanupActiveTasks();
    await cleanupTrackedTempDirs();
  });

  describe("POST /api/tasks/:id/accept", () => {
    // Note: Tasks are auto-started on creation by default, but they can still
    // remain in "idle" status if auto-start fails (e.g., git issues/uncommitted changes).
    
    test("returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent/accept`, {
        method: "POST",
      });

      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/tasks/:id/discard", () => {
    test("succeeds for plan mode task (git branch created at plan start)", async () => {
      // Create a task in plan mode - git branch+worktree is now created at plan mode start
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test prompt",
          attachments: [],
          name: "Test Task",
          planMode: true,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      // Plan mode tasks now have git branches from the start, so discard should succeed
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/discard`, {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
    });

    test("returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent/discard`, {
        method: "POST",
      });

      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/tasks/:id/diff", () => {
    test("returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent/diff`);
      expect(response.status).toBe(404);
    });

    test("returns 400 for task without git branch (draft mode)", async () => {
      // Create a draft task - no git branch is created until the task is started
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test prompt",
          attachments: [],
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      const createBody = await createResponse.json();
      expect(createResponse.status).toBe(201);
      expect(createBody.config).toBeDefined();
      const taskId = createBody.config.id;

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/diff`);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("no_git_branch");
    });

    test("returns diff data for branch-only tasks without a worktree", async () => {
      const diffTestDir = await createTrackedTempDir("clanky-branch-only-diff-");
      await Bun.$`git init -b main ${diffTestDir}`.quiet();
      await Bun.$`git -C ${diffTestDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${diffTestDir} config user.name "Test User"`.quiet();
      await writeFile(join(diffTestDir, "README.md"), "# Branch-only diff");
      await Bun.$`git -C ${diffTestDir} add .`.quiet();
      await Bun.$`git -C ${diffTestDir} commit -m "Initial commit"`.quiet();
      await Bun.$`git -C ${diffTestDir} remote add origin ${testBareRepoDir}`.quiet();
      await Bun.$`git -C ${diffTestDir} push -u -f origin main`.quiet();

      const workspaceId = await getOrCreateWorkspace(diffTestDir);
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId,
          prompt: "Test branch-only diff",
          attachments: [],
          name: "Test Task",
          planMode: false,
          model: testModel,
          useWorktree: false,
        }),
      });
      const createBody = await createResponse.json();
      expect(createResponse.status).toBe(201);
      const taskId = createBody.config.id;

      await waitForTaskCompletion(taskId);
      const taskResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      const taskBody = await taskResponse.json();
      expect(taskBody.state.status).toBe("completed");
      expect(taskBody.state.git).toBeDefined();

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/diff`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);

      await rm(diffTestDir, { recursive: true, force: true });
    });
  });

  describe("GET /api/tasks/:id/plan", () => {
    test("returns plan.md content", async () => {
      // Create a fresh workdir with .clanky-planning to avoid pollution from other tests
      const planTestDir = await createTrackedTempDir("clanky-plan-test-");
      await Bun.$`git init -b main ${planTestDir}`.quiet();
      await Bun.$`git -C ${planTestDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${planTestDir} config user.name "Test User"`.quiet();
      await writeFile(join(planTestDir, "README.md"), "# Test");
      await mkdir(join(planTestDir, ".clanky-planning"), { recursive: true });
      await writeFile(join(planTestDir, ".clanky-planning/plan.md"), "# Test Plan\n\nThis is a test plan.");
      await Bun.$`git -C ${planTestDir} add .`.quiet();
      await Bun.$`git -C ${planTestDir} commit -m "Initial commit"`.quiet();

      // Create workspace for this directory
      const workspaceId = await getOrCreateWorkspace(planTestDir);

      // Start the task (non-draft) so a worktree is created.
      // The mock backend completes immediately, and the worktree inherits
      // the .clanky-planning/plan.md file from the main repo's branch.
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId,
          prompt: "Test",
          attachments: [],
          name: "Test Task",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      expect(createBody.config).toBeDefined();
      const taskId = createBody.config.id;

      // Wait for the task to complete so the worktree is fully set up
      await waitForTaskCompletion(taskId);

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/plan`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.exists).toBe(true);
      expect(body.content).toContain("# Test Plan");

      await rm(planTestDir, { recursive: true, force: true });
    });

    test("returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent/plan`);
      expect(response.status).toBe(404);
    });

    test("returns plan.md content for branch-only tasks without a worktree", async () => {
      const branchOnlyPlanDir = await createTrackedTempDir("clanky-branch-only-plan-");
      await Bun.$`git init -b main ${branchOnlyPlanDir}`.quiet();
      await Bun.$`git -C ${branchOnlyPlanDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${branchOnlyPlanDir} config user.name "Test User"`.quiet();
      await writeFile(join(branchOnlyPlanDir, "README.md"), "# Branch-only plan");
      await mkdir(join(branchOnlyPlanDir, ".clanky-planning"), { recursive: true });
      await writeFile(join(branchOnlyPlanDir, ".clanky-planning/plan.md"), "# Branch-only Plan\n\nPlan content.");
      await Bun.$`git -C ${branchOnlyPlanDir} add .`.quiet();
      await Bun.$`git -C ${branchOnlyPlanDir} commit -m "Initial commit"`.quiet();
      await Bun.$`git -C ${branchOnlyPlanDir} remote add origin ${testBareRepoDir}`.quiet();
      await Bun.$`git -C ${branchOnlyPlanDir} push -u -f origin main`.quiet();

      const workspaceId = await getOrCreateWorkspace(branchOnlyPlanDir);
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId,
          prompt: "Read branch-only plan",
          attachments: [],
          name: "Test Task",
          planMode: false,
          model: testModel,
          useWorktree: false,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      await waitForTaskCompletion(taskId);

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/plan`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.exists).toBe(true);
      expect(body.content).toContain("# Branch-only Plan");

      await rm(branchOnlyPlanDir, { recursive: true, force: true });
    });

    test("returns 400 for draft task without worktree", async () => {
      // Create a new workdir (with git but without .clanky-planning)
      const emptyWorkDir = await createTrackedTempDir("clanky-empty-work-");
      await Bun.$`git init -b main ${emptyWorkDir}`.quiet();
      await Bun.$`git -C ${emptyWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${emptyWorkDir} config user.name "Test User"`.quiet();
      await writeFile(join(emptyWorkDir, "README.md"), "# Empty");
      await Bun.$`git -C ${emptyWorkDir} add .`.quiet();
      await Bun.$`git -C ${emptyWorkDir} commit -m "Initial commit"`.quiet();

      // Create workspace for this directory
      const workspaceId = await getOrCreateWorkspace(emptyWorkDir);

      // Use draft mode -- no worktree is created
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId,
          prompt: "Test",
          attachments: [],
          name: "Test Task",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      expect(createBody.config).toBeDefined();
      const taskId = createBody.config.id;

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/plan`);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("no_worktree");

      await rm(emptyWorkDir, { recursive: true, force: true });
    });
  });

  describe("GET /api/tasks/:id/pull-request", () => {
    test("returns PR navigation metadata from the task manager", async () => {
      const destinationSpy = spyOn(taskManager, "getPullRequestDestination").mockResolvedValue({
        enabled: true,
        destinationType: "existing_pr",
        url: "https://github.com/example/repo/pull/12",
      });

      try {
        const response = await fetch(`${baseUrl}/api/tasks/test-task-id/pull-request`);

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

    test("returns 404 when the task manager cannot resolve the task", async () => {
      const destinationSpy = spyOn(taskManager, "getPullRequestDestination").mockResolvedValue(null);

      try {
        const response = await fetch(`${baseUrl}/api/tasks/non-existent/pull-request`);

        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body.error).toBe("not_found");
      } finally {
        destinationSpy.mockRestore();
      }
    });
  });

  describe("GET /api/tasks/:id/status-file", () => {
    test("returns status.md content", async () => {
      // Create a fresh workdir with .clanky-planning to avoid pollution from other tests
      const statusTestDir = await createTrackedTempDir("clanky-status-test-");
      await Bun.$`git init -b main ${statusTestDir}`.quiet();
      await Bun.$`git -C ${statusTestDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${statusTestDir} config user.name "Test User"`.quiet();
      await writeFile(join(statusTestDir, "README.md"), "# Test");
      await mkdir(join(statusTestDir, ".clanky-planning"), { recursive: true });
      await writeFile(join(statusTestDir, ".clanky-planning/status.md"), "# Status\n\nIn progress.");
      await Bun.$`git -C ${statusTestDir} add .`.quiet();
      await Bun.$`git -C ${statusTestDir} commit -m "Initial commit"`.quiet();

      // Create workspace for this directory
      const workspaceId = await getOrCreateWorkspace(statusTestDir);

      // Start the task (non-draft) so a worktree is created.
      // The mock backend completes immediately, and the worktree inherits
      // the .clanky-planning/status.md file from the main repo's branch.
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId,
          prompt: "Test",
          attachments: [],
          name: "Test Task",
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      expect(createBody.config).toBeDefined();
      const taskId = createBody.config.id;

      // Wait for the task to complete so the worktree is fully set up
      await waitForTaskCompletion(taskId);

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/status-file`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.exists).toBe(true);
      expect(body.content).toContain("# Status");

      await rm(statusTestDir, { recursive: true, force: true });
    });

    test("returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent/status-file`);
      expect(response.status).toBe(404);
    });

    test("returns status.md content for branch-only tasks without a worktree", async () => {
      const branchOnlyStatusDir = await createTrackedTempDir("clanky-branch-only-status-");
      await Bun.$`git init -b main ${branchOnlyStatusDir}`.quiet();
      await Bun.$`git -C ${branchOnlyStatusDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${branchOnlyStatusDir} config user.name "Test User"`.quiet();
      await writeFile(join(branchOnlyStatusDir, "README.md"), "# Branch-only status");
      await mkdir(join(branchOnlyStatusDir, ".clanky-planning"), { recursive: true });
      await writeFile(join(branchOnlyStatusDir, ".clanky-planning/status.md"), "# Branch-only Status\n\nStatus content.");
      await Bun.$`git -C ${branchOnlyStatusDir} add .`.quiet();
      await Bun.$`git -C ${branchOnlyStatusDir} commit -m "Initial commit"`.quiet();
      await Bun.$`git -C ${branchOnlyStatusDir} remote add origin ${testBareRepoDir}`.quiet();
      await Bun.$`git -C ${branchOnlyStatusDir} push -u -f origin main`.quiet();

      const workspaceId = await getOrCreateWorkspace(branchOnlyStatusDir);
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId,
          prompt: "Read branch-only status",
          attachments: [],
          name: "Test Task",
          planMode: false,
          model: testModel,
          useWorktree: false,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const taskId = createBody.config.id;

      await waitForTaskCompletion(taskId);

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/status-file`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.exists).toBe(true);
      expect(body.content).toContain("# Branch-only Status");

      await rm(branchOnlyStatusDir, { recursive: true, force: true });
    });
  });

  describe("Pending Prompt API", () => {
    test("PUT /api/tasks/:id/pending-prompt returns 409 when task is not running", async () => {
      // Use unique directory to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("clanky-pending-prompt-test-");
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a task - it will auto-start and complete immediately with mock backend
        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Test prompt",
          attachments: [],
            name: "Test Task",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const taskId = createBody.config.id;

        // Wait for the task to complete
        await waitForTaskCompletion(taskId);

        // Try to set pending prompt on completed task
        const response = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-prompt`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "New prompt", attachments: [] }),
        });

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body.error).toBe("not_running");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("PUT /api/tasks/:id/pending-prompt requires prompt in body", async () => {
      // Use unique directory to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("clanky-pending-body-test-");
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Test prompt",
          attachments: [],
            name: "Test Task",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const taskId = createBody.config.id;

        // Try without prompt
        const response = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-prompt`, {
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

    test("PUT /api/tasks/:id/pending-prompt rejects empty prompt", async () => {
      // Use unique directory to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("clanky-pending-empty-test-");
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Test prompt",
          attachments: [],
            name: "Test Task",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const taskId = createBody.config.id;

        // Try with empty prompt
        const response = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-prompt`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "   ", attachments: [] }),
        });

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toBe("validation_error");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("DELETE /api/tasks/:id/pending-prompt returns 409 when task is not running", async () => {
      // Use unique directory to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("clanky-pending-del-test-");
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a task - it will auto-start and complete immediately with mock backend
        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Test prompt",
          attachments: [],
            name: "Test Task",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const taskId = createBody.config.id;

        // Wait for the task to complete
        await waitForTaskCompletion(taskId);

        const response = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-prompt`, {
          method: "DELETE",
        });

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body.error).toBe("not_running");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("PUT /api/tasks/:id/pending-prompt returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent/pending-prompt`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Test", attachments: [] }),
      });
      expect(response.status).toBe(404);
    });

    test("DELETE /api/tasks/:id/pending-prompt returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent/pending-prompt`, {
        method: "DELETE",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("Review Comments API", () => {
    test("GET /api/tasks/:id/comments returns empty array for new task", async () => {
      // Use unique directory to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("clanky-comments-empty-test-");
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Test prompt",
          attachments: [],
            name: "Test Task",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const taskId = createBody.config.id;

        const response = await fetch(`${baseUrl}/api/tasks/${taskId}/comments`);

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.success).toBe(true);
        expect(body.comments).toEqual([]);
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("GET /api/tasks/:id/comments returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent/comments`);
      expect(response.status).toBe(404);
    });

    test("POST /api/tasks/:id/address-comments stores and returns comment IDs", async () => {
      // Use unique directory with bare repo to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("clanky-comments-store-test-");
      const uniqueBareRepo = await createTrackedTempDir("clanky-comments-store-bare-");
      await Bun.$`git init --bare ${uniqueBareRepo}`.quiet();
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} remote add origin ${uniqueBareRepo}`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a task
        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Test prompt",
          attachments: [],
            name: "Test Task",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const taskId = createBody.config.id;

        // Wait for task to complete
        await waitForTaskCompletion(taskId);

        // Push the task to enable review mode
        const pushResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/push`, { method: "POST" });
        if (pushResponse.status !== 200) {
          const pushBody = await pushResponse.json();
          const taskResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`);
          const taskData = await taskResponse.json();
          throw new Error(`Push failed with status ${pushResponse.status}: ${JSON.stringify(pushBody)}. Task state: ${JSON.stringify(taskData.state)}`);
        }
        expect(pushResponse.status).toBe(200);

        // Submit comments
        const commentsText = "Please add error handling\nImprove test coverage";
        const addressResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/address-comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comments: commentsText, attachments: [] }),
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
        const commentsResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/comments`);
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

    test("GET /api/tasks/:id/comments includes the deterministic workflow failure comment", async () => {
      const uniqueWorkDir = await createTrackedTempDir("clanky-auto-pr-comments-test-");
      const uniqueBareRepo = await createTrackedTempDir("clanky-auto-pr-comments-bare-");
      await Bun.$`git init --bare ${uniqueBareRepo}`.quiet();
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} remote add origin ${uniqueBareRepo}`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();

      try {
        const currentBranch = (await Bun.$`git -C ${uniqueWorkDir} branch --show-current`.text()).trim();
        await Bun.$`git -C ${uniqueWorkDir} push origin ${currentBranch}`.quiet();

        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);
        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Test prompt",
          attachments: [],
            name: "Automatic PR comments task",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const taskId = createBody.config.id;

        await waitForTaskCompletion(taskId);

        const pushResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/push`, { method: "POST" });
        expect(pushResponse.status).toBe(200);

        const task = await taskManager.getTask(taskId);
        expect(task).not.toBeNull();
        task!.state.automaticPrFlow = {
          enabled: true,
          status: "monitoring",
          startedAt: "2026-04-13T22:45:39.694Z",
          updatedAt: "2026-04-13T22:45:39.694Z",
          lastCheckedAt: "2026-04-13T22:45:39.694Z",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.com/owner/repo/pull/42",
          handledItems: [],
          activeBatch: undefined,
          stoppedAt: undefined,
        };
        await saveTask(task!);

        const reviewCycleResult = await taskManager.startAutomaticPrReviewCycle(taskId, {
          batchId: "batch-1",
          sourceItems: [
            {
              id: "workflow:check-failed:head-sha-1:FAILURE:2026-07-12T17:01:00Z",
              source: "workflow",
              body: "Untrusted workflow output must not become the task comment.",
            },
          ],
          feedbackItems: [
            {
              text: "Another untrusted model-shaped value.",
              sourceItemIds: ["workflow:check-failed:head-sha-1:FAILURE:2026-07-12T17:01:00Z"],
            },
          ],
        });

        expect(reviewCycleResult.success).toBe(true);
        expect(reviewCycleResult.reviewCycle).toBe(1);

        const commentsResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/comments`);
        expect(commentsResponse.status).toBe(200);
        const commentsBody = await commentsResponse.json();
        expect(commentsBody.success).toBe(true);
        expect(commentsBody.comments).toBeInstanceOf(Array);
        expect(commentsBody.comments.length).toBeGreaterThan(0);
        expect(commentsBody.comments[0].reviewCycle).toBe(1);
        expect(commentsBody.comments[0].status).toBe("pending");
        expect(commentsBody.comments[0].commentText).toBe(AUTOMATIC_PR_WORKFLOW_FAILURE_MESSAGE);
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
        await rm(uniqueBareRepo, { recursive: true, force: true });
      }
    });

    test("POST /api/tasks/:id/address-comments returns 400 for task not in review mode", async () => {
      // Use unique directory to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("clanky-comments-notreview-test-");
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a task without review mode
        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Test prompt",
          attachments: [],
            name: "Test Task",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const taskId = createBody.config.id;

        // Wait for task to complete
        await waitForTaskCompletion(taskId);

        // Try to address comments without enabling review mode (no push)
        const response = await fetch(`${baseUrl}/api/tasks/${taskId}/address-comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comments: "Some comment", attachments: [] }),
        });

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain("not addressable");
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
      }
    });

    test("POST /api/tasks/:id/address-comments returns 404 for non-existent task", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/non-existent/address-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comments: "Some comment", attachments: [] }),
      });
      expect(response.status).toBe(404);
    });

    test("POST /api/tasks/:id/automatic-pr-flow/start enables automatic PR flow", async () => {
      const startSpy = spyOn(taskManager, "startAutomaticPrFlow").mockResolvedValue({
        success: true,
        automaticPrFlow: {
          enabled: true,
          status: "monitoring",
          startedAt: "2026-04-11T04:00:00.000Z",
          updatedAt: "2026-04-11T04:00:00.000Z",
          lastCheckedAt: "2026-04-11T04:00:00.000Z",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.com/owner/repo/pull/42",
          handledItems: [],
        },
      });

      try {
        const response = await fetch(`${baseUrl}/api/tasks/test-task-id/automatic-pr-flow/start`, {
          method: "POST",
        });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.success).toBe(true);
        expect(body.automaticPrFlow.enabled).toBe(true);
        expect(body.automaticPrFlow.pullRequestNumber).toBe(42);
      } finally {
        startSpy.mockRestore();
      }
    });

    test("POST /api/tasks/:id/automatic-pr-flow/stop disables automatic PR flow", async () => {
      const stopSpy = spyOn(taskManager, "stopAutomaticPrFlow").mockResolvedValue({
        success: true,
        automaticPrFlow: {
          enabled: false,
          status: "stopped",
          startedAt: "2026-04-11T04:00:00.000Z",
          updatedAt: "2026-04-11T04:10:00.000Z",
          lastCheckedAt: "2026-04-11T04:10:00.000Z",
          handledItems: [],
          stoppedAt: "2026-04-11T04:10:00.000Z",
        },
      });

      try {
        const response = await fetch(`${baseUrl}/api/tasks/test-task-id/automatic-pr-flow/stop`, {
          method: "POST",
        });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.success).toBe(true);
        expect(body.automaticPrFlow.enabled).toBe(false);
        expect(body.automaticPrFlow.status).toBe("stopped");
      } finally {
        stopSpy.mockRestore();
      }
    });

    test("POST /api/tasks/:id/pull-request/auto-merge enables GitHub auto-merge for an existing PR", async () => {
      const autoMergeSpy = spyOn(taskManager, "enablePullRequestAutoMerge").mockResolvedValue({
        success: true,
        pullRequest: {
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
        },
      });

      try {
        const response = await fetch(`${baseUrl}/api/tasks/test-task-id/pull-request/auto-merge`, {
          method: "POST",
        });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.success).toBe(true);
        expect(body.pullRequest.number).toBe(42);
        expect(body.pullRequest.url).toBe("https://github.com/owner/repo/pull/42");
      } finally {
        autoMergeSpy.mockRestore();
      }
    });

    test("GET /api/tasks/:id/comments returns comments in correct order", async () => {
      // Use unique directory with bare repo to avoid conflicts
      const uniqueWorkDir = await createTrackedTempDir("clanky-comments-order-test-");
      const uniqueBareRepo = await createTrackedTempDir("clanky-comments-order-bare-");
      await Bun.$`git init --bare ${uniqueBareRepo}`.quiet();
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} remote add origin ${uniqueBareRepo}`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a task
        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Test prompt",
          attachments: [],
            name: "Test Task",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const taskId = createBody.config.id;

        // Wait for completion and push
        await waitForTaskCompletion(taskId);
        const pushResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/push`, { method: "POST" });
        expect(pushResponse.status).toBe(200);

        // Add comments
        const addressResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/address-comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comments: "First comment", attachments: [] }),
        });
        expect(addressResponse.status).toBe(200);

        // Get comments - should be ordered correctly
        const response = await fetch(`${baseUrl}/api/tasks/${taskId}/comments`);
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
      const uniqueWorkDir = await createTrackedTempDir("clanky-comments-get-test-");
      const uniqueBareRepo = await createTrackedTempDir("clanky-comments-get-bare-");
      await Bun.$`git init --bare ${uniqueBareRepo}`.quiet();
      await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} remote add origin ${uniqueBareRepo}`.quiet();
      await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
      await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
      
      try {
        // Create workspace for this directory
        const workspaceId = await getOrCreateWorkspace(uniqueWorkDir);

        // Create a task
        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          ...baseCreateTaskPayload,
            workspaceId,
            prompt: "Test prompt",
          attachments: [],
            name: "Test Task",
            planMode: false,
            model: testModel,
            useWorktree: true,
          }),
        });
        const createBody = await createResponse.json();
        const taskId = createBody.config.id;

        // Wait for first completion
        await waitForTaskCompletion(taskId);

        // Push the task
        const pushResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/push`, { method: "POST" });
        expect(pushResponse.status).toBe(200);

        // Add comments
        const addressResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/address-comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comments: "Test comment", attachments: [] }),
        });
        expect(addressResponse.status).toBe(200);

        // Get comments - verify they exist and contain the correct data
        const commentsResponse = await fetch(`${baseUrl}/api/tasks/${taskId}/comments`);
        const commentsBody = await commentsResponse.json();
        expect(commentsBody.success).toBe(true);
        expect(commentsBody.comments.length).toBeGreaterThan(0);
        expect(commentsBody.comments[0].commentText).toBe("Test comment");
        expect(commentsBody.comments[0].reviewCycle).toBe(1);
        expect(commentsBody.comments[0].taskId).toBe(taskId);
      } finally {
        await rm(uniqueWorkDir, { recursive: true, force: true });
        await rm(uniqueBareRepo, { recursive: true, force: true });
      }
    });
  });
});
