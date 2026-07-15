/**
 * API integration tests for Plan Mode endpoints.
 * Tests HTTP requests to plan mode API endpoints.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { initializeDatabase } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { closeDatabase } from "../../src/persistence/database";
import { PlanModeMockBackend } from "../mocks/mock-backend";
import { UPLOADED_PLAN_IMPLEMENTATION_PROMPT } from "../../src/lib/uploaded-plan";

// Default test model for task creation (model is now required)
const testModel = { providerID: "test-provider", modelID: "test-model", variant: "" };
const defaultServerSettings = { agent: { provider: "opencode", transport: "stdio" } };
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
        serverSettings: serverSettings ?? defaultServerSettings,
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

  // Poll until task reaches expected status
  async function waitForStatus(
    taskId: string,
    expectedStatuses: string[],
    timeoutMs = 10000
  ): Promise<Record<string, unknown>> {
    const startTime = Date.now();
    let lastStatus = "unknown";
    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      if (response.ok) {
        const task = await response.json();
        lastStatus = task.state?.status ?? "unknown";
        if (expectedStatuses.includes(lastStatus)) {
          return task;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Task ${taskId} did not reach status [${expectedStatuses.join(", ")}] within ${timeoutMs}ms. Last: ${lastStatus}`
    );
  }

  // Poll until isPlanReady becomes true
  async function waitForPlanReady(taskId: string, timeoutMs = 10000): Promise<Record<string, unknown>> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/tasks/${taskId}`);
      if (response.ok) {
        const task = await response.json();
        if (task.state?.planMode?.isPlanReady === true) {
          return task;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Plan for task ${taskId} did not become ready within ${timeoutMs}ms`);
  }

  function getPromptText(prompt: { parts?: Array<{ type: string; text?: string }> }): string {
    return prompt.parts
      ?.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n") ?? "";
  }

  async function waitForSentPromptContaining(text: string, timeoutMs = 10000): Promise<string> {
    const startTime = Date.now();
    let lastPrompt = "";
    while (Date.now() - startTime < timeoutMs) {
      const prompts = mockBackend.getSentPrompts().map(getPromptText);
      const match = prompts.find((prompt) => prompt.includes(text));
      if (match) {
        return match;
      }
      lastPrompt = prompts.at(-1) ?? "";
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`No sent prompt contained "${text}" within ${timeoutMs}ms. Last prompt: ${lastPrompt}`);
  }

  beforeAll(async () => {
    // Create temp data directory
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-api-plan-test-data-"));

    // Set env var for persistence
    process.env["CLANKY_DATA_DIR"] = testDataDir;
    await initializeDatabase();

    // Set up backend manager with class-based mock
    mockBackend = new PlanModeMockBackend();
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    // Start test server
    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    // Stop server
    server.stop(true);

    // Clean up
    backendManager.resetForTesting();
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];

    // Remove temp data directory
    await rm(testDataDir, { recursive: true });
  });

  // Helper to create a unique work directory with git initialized
  async function createTestWorkDir(): Promise<string> {
    const workDir = await mkdtemp(join(tmpdir(), "clanky-api-plan-test-work-"));
    await Bun.$`git init -b main ${workDir}`.quiet();
    await Bun.$`git -C ${workDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${workDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${workDir}/README.md`.quiet();
    await Bun.$`git -C ${workDir} add .`.quiet();
    await Bun.$`git -C ${workDir} commit -m "Initial commit"`.quiet();
    currentRemoteDir = await mkdtemp(join(tmpdir(), "clanky-api-plan-test-remote-"));
    await Bun.$`git init --bare ${currentRemoteDir}`.quiet();
    await Bun.$`git -C ${workDir} remote add origin ${currentRemoteDir}`.quiet();
    const currentBranch = (await Bun.$`git -C ${workDir} branch --show-current`.text()).trim();
    await Bun.$`git -C ${workDir} push -u origin ${currentBranch}`.quiet();
    await Bun.$`git --git-dir=${currentRemoteDir} symbolic-ref HEAD refs/heads/${currentBranch}`.quiet();
    return workDir;
  }

  // Helper to create a unique work directory with git initialized AND workspace
  async function createTestWorkDirWithWorkspace(): Promise<{ workDir: string; workspaceId: string }> {
    const workDir = await createTestWorkDir();
    const workspaceId = await getOrCreateWorkspace(workDir, "Test Workspace");
    return { workDir, workspaceId };
  }

  // Clean up any active tasks and reset state before/after each test
  const setupAndCleanup = async () => {
    const { listTasks, updateTaskState, loadTask } = await import("../../src/persistence/tasks");
    const { taskManager } = await import("../../src/core/task-manager");
    
    // Clear all running engines first
    taskManager.resetForTesting();
    
    // Reset the mock backend state
    mockBackend.reset();
    
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
    
    // Create a fresh work directory and workspace for this test
    const { workDir, workspaceId } = await createTestWorkDirWithWorkspace();
    currentTestWorkDir = workDir;
    currentWorkspaceId = workspaceId;
  };
  
  const teardownTest = async () => {
    const { listTasks, updateTaskState, loadTask } = await import("../../src/persistence/tasks");
    const { taskManager } = await import("../../src/core/task-manager");
    
    // Clear all running engines first
    taskManager.resetForTesting();
    
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
    test("treats a .clanky-planning directory with only .gitkeep as empty", async () => {
      const planningDir = join(currentTestWorkDir, ".clanky-planning");
      await mkdir(planningDir, { recursive: true });
      await writeFile(join(planningDir, ".gitkeep"), "");

      const response = await fetch(
        `${baseUrl}/api/check-planning-dir?workspaceId=${encodeURIComponent(currentWorkspaceId)}`,
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

  describe("POST /api/tasks (plan mode)", () => {
    test("creates task in planning status when planMode is true", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          prompt: "Create a plan",
          name: "Test Task",
          workspaceId: currentWorkspaceId,
          maxIterations: 1,
          planMode: true,
          autoAcceptPlan: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.config?.id).toBeDefined();

      // Get the task and verify status
      const getResponse = await fetch(`${baseUrl}/api/tasks/${data.config.id}`);
      expect(getResponse.ok).toBe(true);
      const task = await getResponse.json();
      expect(task.state.status).toBe("planning");
      expect(task.state.planMode?.active).toBe(true);
    });

    test("returns 400 if required fields missing", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          // Missing name, prompt, directory
          planMode: true,
        }),
      });

      expect(response.status).toBe(400);
    });

    test("starts from uploaded plan as an approved plan", async () => {
      const uploadedPlanContent = `\uFEFF# Uploaded plan

1. Update the implementation.
2. Verify the behavior.

<promise>PLAN_READY</promise>`;

      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          prompt: UPLOADED_PLAN_IMPLEMENTATION_PROMPT,
          name: "Uploaded Plan Task",
          workspaceId: currentWorkspaceId,
          maxIterations: 1,
          planMode: false,
          autoAcceptPlan: false,
          model: testModel,
          useWorktree: true,
          uploadedPlan: {
            planContent: uploadedPlanContent,
          },
        }),
      });

      expect(response.status).toBe(201);
      const task = await response.json();
      expect(task.config.prompt).toBe(UPLOADED_PLAN_IMPLEMENTATION_PROMPT);
      expect(task.config.planMode).toBe(true);
      expect(task.config.autoAcceptPlan).toBe(true);
      expect(task.state.planMode?.active).toBe(false);
      expect(task.state.planMode?.isPlanReady).toBe(true);

      const worktreePath = task.state.git?.worktreePath;
      expect(worktreePath).toBeTruthy();
      const seededPlan = await Bun.file(join(worktreePath, ".clanky-planning", "plan.md")).text();
      expect(seededPlan).toContain("# Uploaded plan");
      expect(seededPlan).toContain("Update the implementation.");
      expect(seededPlan).not.toContain("<promise>PLAN_READY</promise>");

      const executionPrompt = await waitForSentPromptContaining(UPLOADED_PLAN_IMPLEMENTATION_PROMPT);
      expect(executionPrompt).toContain(UPLOADED_PLAN_IMPLEMENTATION_PROMPT);
    });

    test("returns 400 when uploaded plan content normalizes to empty", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          prompt: UPLOADED_PLAN_IMPLEMENTATION_PROMPT,
          name: "Empty Uploaded Plan",
          workspaceId: currentWorkspaceId,
          maxIterations: 1,
          planMode: false,
          autoAcceptPlan: false,
          model: testModel,
          useWorktree: true,
          uploadedPlan: {
            planContent: "<promise>PLAN_READY</promise>",
          },
        }),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toBe("invalid_uploaded_plan");
    });

    test("returns 400 when saving an uploaded plan as a draft", async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          prompt: UPLOADED_PLAN_IMPLEMENTATION_PROMPT,
          name: "Draft Uploaded Plan",
          workspaceId: currentWorkspaceId,
          maxIterations: 1,
          planMode: false,
          autoAcceptPlan: false,
          model: testModel,
          useWorktree: true,
          draft: true,
          uploadedPlan: {
            planContent: "# Plan\n\nDo it.",
          },
        }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe("POST /api/tasks/:id/plan/feedback", () => {
    test("returns 400 if task is not in planning status", async () => {
      // Create a normal task (not plan mode)
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          prompt: "Do something",
          name: "Test Task",
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
      const feedbackResponse = await fetch(`${baseUrl}/api/tasks/${id}/plan/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback: "This should fail",
          attachments: [],
        }),
      });

      expect(feedbackResponse.status).toBe(400);
    });

    test("returns 409 if task not found", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/nonexistent/plan/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback: "Test",
          attachments: [],
        }),
      });

      expect(response.status).toBe(409);
    });
  });

  describe("POST /api/tasks/:id/plan/accept", () => {
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

        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          ...baseCreateTaskPayload,
            prompt: "Create a plan",
            name: "Test Task",
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

        const acceptResponse = await fetch(`${baseUrl}/api/tasks/${id}/plan/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "open_ssh" }),
        });

        expect(acceptResponse.status).toBe(200);
        const data = await acceptResponse.json();
        expect(data.success).toBe(true);
        expect(data.mode).toBe("open_ssh");
        expect(data.sshSession?.config?.taskId).toBe(id);

        const task = await waitForStatus(id, ["completed"]);
        expect((task["state"] as { status: string }).status).toBe("completed");
      } finally {
        await rm(sshWorkDir, { recursive: true, force: true });
      }
    });

    test("returns 400 if task is not in planning status", async () => {
      // Commit any previous changes first
      try {
        await Bun.$`git -C ${currentTestWorkDir} add -A`.quiet();
        await Bun.$`git -C ${currentTestWorkDir} commit -m "Test changes" --allow-empty`.quiet();
      } catch {
        // Ignore if nothing to commit
      }

      // Create normal task
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          prompt: "Do something",
          name: "Test Task",
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
      const acceptResponse = await fetch(`${baseUrl}/api/tasks/${id}/plan/accept`, {
        method: "POST",
      });

      expect(acceptResponse.status).toBe(400);
    });
  });

  describe("POST /api/tasks/:id/plan/discard", () => {
    test("deletes the task", async () => {
      // Commit any previous changes first
      try {
        await Bun.$`git -C ${currentTestWorkDir} add -A`.quiet();
        await Bun.$`git -C ${currentTestWorkDir} commit -m "Test changes" --allow-empty`.quiet();
      } catch {
        // Ignore if nothing to commit
      }

      // Create task in plan mode
      const createResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...baseCreateTaskPayload,
          prompt: "Create a plan",
          name: "Test Task",
          workspaceId: currentWorkspaceId,
          maxIterations: 1,
          planMode: true,
          autoAcceptPlan: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const response = await createResponse.json();
      expect(response.config).toBeDefined();
      const id = response.config.id;
      await waitForPlanReady(id);

      // Verify task exists
      let getResponse = await fetch(`${baseUrl}/api/tasks/${id}`);
      expect(getResponse.ok).toBe(true);

      // Discard the plan
      const discardResponse = await fetch(`${baseUrl}/api/tasks/${id}/plan/discard`, {
        method: "POST",
      });

      expect(discardResponse.status).toBe(200);
      await waitForStatus(id, ["deleted"]);

      // Verify task is marked as deleted (soft delete)
      getResponse = await fetch(`${baseUrl}/api/tasks/${id}`);
      expect(getResponse.ok).toBe(true);
      const deletedTask = await getResponse.json();
      expect(deletedTask.state.status).toBe("deleted");
    });

    test("returns 404 if task not found", async () => {
      const response = await fetch(`${baseUrl}/api/tasks/nonexistent/plan/discard`, {
        method: "POST",
      });

      expect(response.status).toBe(404);
    });
  });
});
