/**
 * API integration tests for tasks control endpoints.
 * Tests use actual HTTP requests to a test server.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { initializeDatabase } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { taskManager } from "../../src/core/task-manager";
import { saveTask } from "../../src/persistence/tasks";
import { closeDatabase } from "../../src/persistence/database";
import { AUTOMATIC_PR_WORKFLOW_FAILURE_MESSAGE } from "../../src/core/automatic-pr-flow-github";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { createMockBackend } from "../mocks/mock-backend";
import {
  createTempBareGitRepository,
  getCurrentBranch,
  initializeGitRepository,
  runGit,
} from "../helpers/git-fixtures";
import { pollUntil } from "../helpers/polling";

// Default test model for task creation (model is now required)
const testModel = { providerID: "test-provider", modelID: "test-model", variant: "" };
let baseCreateTaskPayload = {
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
  baseBranch: "",
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
    await pollUntil(
      async () => {
        const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
        if (!response.ok) {
          return `HTTP ${response.status}`;
        }
        const data = await response.json() as { state?: { status?: string } };
        return data.state?.status ?? "no state";
      },
      (status) => status === "completed" || status === "failed",
      {
        description: `task ${taskId} to complete`,
        timeoutMs,
        formatLastObserved: (status) => status,
      },
    );
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

  async function createTrackedBareRepo(prefix: string): Promise<string> {
    const directory = await createTempBareGitRepository({ prefix });
    tempDirsToCleanup.add(directory);
    return directory;
  }

  async function createTrackedGitRepo(prefix: string): Promise<string> {
    const directory = await createTrackedTempDir(prefix);
    await initializeGitRepository(directory, { initialCommit: "readme" });
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
    await initializeDatabase();

    // Initialize git repo
    await initializeGitRepository(testWorkDir, { initialCommit: "readme" });
    baseCreateTaskPayload.baseBranch = await getCurrentBranch(testWorkDir);
    
    // Add a fake remote for push tests (using local file path as a valid remote)
    testBareRepoDir = await createTempBareGitRepository({ prefix: "clanky-api-control-test-bare-" });
    await runGit(testWorkDir, ["remote", "add", "origin", testBareRepoDir]);

    // Create .clanky-planning directory and commit it
    await mkdir(join(testWorkDir, ".clanky-planning"), { recursive: true });
    await writeFile(join(testWorkDir, ".clanky-planning/plan.md"), "# Test Plan\n\nThis is a test plan.");
    await writeFile(join(testWorkDir, ".clanky-planning/status.md"), "# Status\n\nIn progress.");
    await runGit(testWorkDir, ["add", "."]);
    await runGit(testWorkDir, ["commit", "-m", "Add planning files"]);

    // Set up backend manager with test executor factory
    mockBackend = createMockBackend();
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    // Start test server on random port
    server = serveNativeApiRoutes();
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

    test("returns an empty diff when a persisted worktree is no longer available", async () => {
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId: testWorkspaceId,
          prompt: "Test missing worktree diff",
          name: "Missing Worktree Diff",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const taskId = (await createResponse.json()).config.id as string;
      const task = await taskManager.getTask(taskId);
      expect(task).not.toBeNull();

      task!.state.git = {
        originalBranch: baseCreateTaskPayload.baseBranch,
        workingBranch: "missing-worktree",
        worktreePath: join(testDataDir, "missing-worktree"),
        commits: [],
      };
      await saveTask(task!);

      const response = await fetch(`${baseUrl}/api/tasks/${taskId}/diff`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    });

    test("returns diff data for branch-only tasks without a worktree", async () => {
      const diffTestDir = await createTrackedTempDir("clanky-branch-only-diff-");
      await initializeGitRepository(diffTestDir, { initialCommit: "none" });
      await writeFile(join(diffTestDir, "README.md"), "# Branch-only diff");
      await runGit(diffTestDir, ["add", "."]);
      await runGit(diffTestDir, ["commit", "-m", "Initial commit"]);
      const diffBranch = await getCurrentBranch(diffTestDir);
      await runGit(diffTestDir, ["remote", "add", "origin", testBareRepoDir]);
      await runGit(diffTestDir, ["push", "-u", "-f", "origin", diffBranch]);

      const workspaceId = await getOrCreateWorkspace(diffTestDir);
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId,
          prompt: "Test branch-only diff",
          baseBranch: diffBranch,
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
      await initializeGitRepository(planTestDir, { initialCommit: "none" });
      await writeFile(join(planTestDir, "README.md"), "# Test");
      await mkdir(join(planTestDir, ".clanky-planning"), { recursive: true });
      await writeFile(join(planTestDir, ".clanky-planning/plan.md"), "# Test Plan\n\nThis is a test plan.");
      await runGit(planTestDir, ["add", "."]);
      await runGit(planTestDir, ["commit", "-m", "Initial commit"]);
      const planBranch = await getCurrentBranch(planTestDir);

      // Create workspace for this directory
      const workspaceId = await getOrCreateWorkspace(planTestDir);

      // Start the task (non-draft) so a worktree is created.
      // The mock backend completes immediately, and the worktree inherits
      // the .clanky-planning/plan.md file from the source repository's branch.
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId,
          baseBranch: planBranch,
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
      await initializeGitRepository(branchOnlyPlanDir, { initialCommit: "none" });
      await writeFile(join(branchOnlyPlanDir, "README.md"), "# Branch-only plan");
      await mkdir(join(branchOnlyPlanDir, ".clanky-planning"), { recursive: true });
      await writeFile(join(branchOnlyPlanDir, ".clanky-planning/plan.md"), "# Branch-only Plan\n\nPlan content.");
      await runGit(branchOnlyPlanDir, ["add", "."]);
      await runGit(branchOnlyPlanDir, ["commit", "-m", "Initial commit"]);
      const branchOnlyPlanBranch = await getCurrentBranch(branchOnlyPlanDir);
      await runGit(branchOnlyPlanDir, ["remote", "add", "origin", testBareRepoDir]);
      await runGit(branchOnlyPlanDir, ["push", "-u", "-f", "origin", branchOnlyPlanBranch]);

      const workspaceId = await getOrCreateWorkspace(branchOnlyPlanDir);
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId,
          baseBranch: branchOnlyPlanBranch,
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
      await initializeGitRepository(emptyWorkDir, { initialCommit: "none" });
      await writeFile(join(emptyWorkDir, "README.md"), "# Empty");
      await runGit(emptyWorkDir, ["add", "."]);
      await runGit(emptyWorkDir, ["commit", "-m", "Initial commit"]);
      const emptyWorkBranch = await getCurrentBranch(emptyWorkDir);

      // Create workspace for this directory
      const workspaceId = await getOrCreateWorkspace(emptyWorkDir);

      // Use draft mode -- no worktree is created
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId,
          baseBranch: emptyWorkBranch,
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

  describe("GET /api/tasks/:id/status-file", () => {
    test("returns status.md content", async () => {
      // Create a fresh workdir with .clanky-planning to avoid pollution from other tests
      const statusTestDir = await createTrackedTempDir("clanky-status-test-");
      await initializeGitRepository(statusTestDir, { initialCommit: "none" });
      await writeFile(join(statusTestDir, "README.md"), "# Test");
      await mkdir(join(statusTestDir, ".clanky-planning"), { recursive: true });
      await writeFile(join(statusTestDir, ".clanky-planning/status.md"), "# Status\n\nIn progress.");
      await runGit(statusTestDir, ["add", "."]);
      await runGit(statusTestDir, ["commit", "-m", "Initial commit"]);
      const statusBranch = await getCurrentBranch(statusTestDir);

      // Create workspace for this directory
      const workspaceId = await getOrCreateWorkspace(statusTestDir);

      // Start the task (non-draft) so a worktree is created.
      // The mock backend completes immediately, and the worktree inherits
      // the .clanky-planning/status.md file from the source repository's branch.
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId,
          baseBranch: statusBranch,
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
      await initializeGitRepository(branchOnlyStatusDir, { initialCommit: "none" });
      await writeFile(join(branchOnlyStatusDir, "README.md"), "# Branch-only status");
      await mkdir(join(branchOnlyStatusDir, ".clanky-planning"), { recursive: true });
      await writeFile(join(branchOnlyStatusDir, ".clanky-planning/status.md"), "# Branch-only Status\n\nStatus content.");
      await runGit(branchOnlyStatusDir, ["add", "."]);
      await runGit(branchOnlyStatusDir, ["commit", "-m", "Initial commit"]);
      const branchOnlyStatusBranch = await getCurrentBranch(branchOnlyStatusDir);
      await runGit(branchOnlyStatusDir, ["remote", "add", "origin", testBareRepoDir]);
      await runGit(branchOnlyStatusDir, ["push", "-u", "-f", "origin", branchOnlyStatusBranch]);

      const workspaceId = await getOrCreateWorkspace(branchOnlyStatusDir);
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          workspaceId,
          baseBranch: branchOnlyStatusBranch,
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
      const uniqueWorkDir = await createTrackedGitRepo("clanky-pending-prompt-test-");
      
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
      const uniqueWorkDir = await createTrackedGitRepo("clanky-pending-body-test-");
      
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
      const uniqueWorkDir = await createTrackedGitRepo("clanky-pending-empty-test-");
      
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
      const uniqueWorkDir = await createTrackedGitRepo("clanky-pending-del-test-");
      
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
      const uniqueWorkDir = await createTrackedGitRepo("clanky-comments-empty-test-");
      
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
      const uniqueWorkDir = await createTrackedGitRepo("clanky-comments-store-test-");
      const uniqueBareRepo = await createTrackedBareRepo("clanky-comments-store-bare-");
      await runGit(uniqueWorkDir, ["remote", "add", "origin", uniqueBareRepo]);
      
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
      const uniqueWorkDir = await createTrackedGitRepo("clanky-auto-pr-comments-test-");
      const uniqueBareRepo = await createTrackedBareRepo("clanky-auto-pr-comments-bare-");
      await runGit(uniqueWorkDir, ["remote", "add", "origin", uniqueBareRepo]);

      try {
        const currentBranch = await getCurrentBranch(uniqueWorkDir);
        await runGit(uniqueWorkDir, ["push", "origin", currentBranch]);

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
        if (!reviewCycleResult.success) {
          throw reviewCycleResult.error;
        }
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
      const uniqueWorkDir = await createTrackedGitRepo("clanky-comments-notreview-test-");
      
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

  });
});
