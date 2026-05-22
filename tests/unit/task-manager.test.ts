/**
 * Unit tests for TaskManager.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { TaskManager } from "../../src/core/task-manager";
import { SimpleEventEmitter } from "../../src/core/event-emitter";
import type { TaskEvent } from "../../src/types/events";
import { updateTaskState } from "../../src/persistence/tasks";
import { getDefaultServerSettings } from "../../src/types/settings";
import { backendManager } from "../../src/core/backend-manager";
import type { TaskState } from "../../src/types/task";
import { createMockBackend, MockAcpBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";

describe("TaskManager", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let manager: TaskManager;
  let emitter: SimpleEventEmitter<TaskEvent>;
  let emittedEvents: TaskEvent[];
  const testWorkspaceId = "test-workspace-id";
  
  // Default test model for task creation (model is now required)
  const testModelFields = {
    modelProviderID: "test-provider",
    modelID: "test-model",
    modelVariant: "",
  };

  beforeEach(async () => {
    // Create temp directories
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-manager-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "clanky-manager-test-work-"));

    // Set env var for persistence
    process.env["CLANKY_DATA_DIR"] = testDataDir;

    // Ensure data directories exist
    const { ensureDataDirectories } = await import("../../src/persistence/database");
    await ensureDataDirectories();

    // Create the test workspace (required for tasks with workspaceId)
    const { createWorkspace } = await import("../../src/persistence/workspaces");
    await createWorkspace({
      id: testWorkspaceId,
      name: "Test Workspace",
      directory: testWorkDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      serverSettings: getDefaultServerSettings(),
    });

    // Set up a test backend for explicit title-generation flows.
    backendManager.setBackendForTesting(createMockBackend());
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    // Set up event emitter
    emittedEvents = [];
    emitter = new SimpleEventEmitter<TaskEvent>();
    emitter.subscribe((event) => emittedEvents.push(event));

    // Create manager
    manager = new TaskManager({
      eventEmitter: emitter,
    });
  });

  afterEach(async () => {
    // Shutdown manager
    await manager.shutdown();

    // Reset backend manager test state
    backendManager.resetForTesting();

    // Close database connection
    const { closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();

    // Clean up
    delete process.env["CLANKY_DATA_DIR"];
    await rm(testDataDir, { recursive: true });
    await rm(testWorkDir, { recursive: true });
  });

  describe("createTask", () => {
    test("creates a new task with defaults", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Do something",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      expect(task.config.id).toBeDefined();
      expect(task.config.directory).toBe(testWorkDir);
      expect(task.config.prompt).toBe("Do something");
      // Backend is now global, not per-task config
      expect(task.config.git.branchPrefix).toBe("");
      expect(task.state.status).toBe("idle");

      // Check event was emitted
      const createEvents = emittedEvents.filter((e) => e.type === "task.created");
      expect(createEvents.length).toBe(1);
    });

    test("creates a task with custom options", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Custom task",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        // Backend options removed - now global
        maxIterations: 10,
        planMode: false,
      });

      // Backend is now global, not per-task config
      expect(task.config.maxIterations).toBe(10);
    });

    test("normalizes configured branch prefixes", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Custom task",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        gitBranchPrefix: " Team Alpha ",
        planMode: false,
      });

      expect(task.config.git.branchPrefix).toBe("team-alpha/");
    });

    test("requires an explicit task name", async () => {
      await expect(
        manager.createTask({
          ...testModelFields,
          directory: testWorkDir,
          prompt: "Custom task",
          name: "   ",
          workspaceId: testWorkspaceId,
          planMode: false,
        })
      ).rejects.toThrow("Task name is required");
    });
  });

  describe("getPullRequestDestination", () => {
    test("returns a sanitized disabled reason when PR resolution throws unexpectedly", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Resolve PR",
        name: "PR Task",
        workspaceId: testWorkspaceId,
        planMode: false,
        useWorktree: false,
      });

      await updateTaskState(task.config.id, {
        ...task.state,
        status: "pushed",
        git: {
          originalBranch: "main",
          workingBranch: "feature/pr-link",
          commits: [],
        },
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 1,
        },
      });

      backendManager.setExecutorFactoryForTesting(() => {
        throw new Error("sensitive executor failure from /tmp/private-path");
      });

      const destination = await manager.getPullRequestDestination(task.config.id);

      expect(destination).toEqual({
        enabled: false,
        destinationType: "disabled",
        disabledReason: "Pull request navigation is temporarily unavailable.",
      });
      if (destination?.enabled === false) {
        expect(destination.disabledReason).not.toContain("/tmp/private-path");
      }
    });
  });

  describe("generateTaskTitle", () => {
    test("connects the workspace backend before creating a temporary title session", async () => {
      const strictBackend = createMockBackend();
      const originalConnect = strictBackend.connect.bind(strictBackend);
      strictBackend.connect = mock(async (config, signal) => originalConnect(config, signal));
      const originalCreateSession = strictBackend.createSession.bind(strictBackend);
      strictBackend.createSession = mock(async (options) => {
        if (!strictBackend.isConnected()) {
          throw new Error("Not connected. Call connect() first.");
        }
        return originalCreateSession(options);
      });
      backendManager.setBackendForTesting(strictBackend);

      const title = await manager.generateTaskTitle({
        directory: testWorkDir,
        prompt: "Create a task title for this prompt",
        workspaceId: testWorkspaceId,
        model: {
          providerID: testModelFields.modelProviderID,
          modelID: testModelFields.modelID,
          variant: testModelFields.modelVariant,
        },
      });

      expect(title).toBe("<promise>COMPLETE</promise>");
      expect(strictBackend.connect).toHaveBeenCalledTimes(1);
      expect(strictBackend.createSession).toHaveBeenCalledTimes(1);
    });

    test("falls back to the task model when the configured cheap model is unavailable", async () => {
      const backend = new MockAcpBackend({
        responses: ["Task title"],
        models: [
          {
            providerID: testModelFields.modelProviderID,
            providerName: "Test Provider",
            modelID: testModelFields.modelID,
            modelName: "Test Model",
            connected: true,
          },
        ],
      });
      let promptModel: { providerID: string; modelID: string; variant?: string } | undefined;
      const originalSendPrompt = backend.sendPrompt.bind(backend);
      backend.sendPrompt = async (sessionId, prompt) => {
        promptModel = prompt.model;
        return await originalSendPrompt(sessionId, prompt);
      };
      backendManager.setBackendForTesting(backend);

      await manager.generateTaskTitle({
        directory: testWorkDir,
        prompt: "Create a task title for this prompt",
        workspaceId: testWorkspaceId,
        model: {
          providerID: testModelFields.modelProviderID,
          modelID: testModelFields.modelID,
          variant: testModelFields.modelVariant,
        },
        cheapModel: {
          mode: "custom",
          model: {
            providerID: "missing-provider",
            modelID: "missing-model",
            variant: "",
          },
        },
      });

      expect(promptModel).toEqual({
        providerID: testModelFields.modelProviderID,
        modelID: testModelFields.modelID,
        variant: testModelFields.modelVariant,
      });
    });
  });


  describe("getTask", () => {
    test("returns a task by ID", async () => {
      const created = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const fetched = await manager.getTask(created.config.id);

      expect(fetched).not.toBeNull();
    });

    test("returns null for non-existent task", async () => {
      const fetched = await manager.getTask("non-existent-id");
      expect(fetched).toBeNull();
    });
  });

  describe("getAllTasks", () => {
    test("returns all tasks", async () => {
      await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test 1",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test 2",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const tasks = await manager.getAllTasks();

      expect(tasks.length).toBe(2);
    });
  });

  describe("updateTask", () => {
    test("updates task configuration", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Original prompt",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const updated = await manager.updateTask(task.config.id, {
        prompt: "Updated prompt",
      });

      expect(updated).not.toBeNull();
      expect(updated!.config.prompt).toBe("Updated prompt");
    });

    test("allows renaming a draft task", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Draft prompt",
        name: "Draft Task",
        workspaceId: testWorkspaceId,
        planMode: false,
        draft: true,
      });

      const updated = await manager.updateTask(task.config.id, {
        name: "Renamed Draft",
      });

      expect(updated).not.toBeNull();
      expect(updated!.config.name).toBe("Renamed Draft");
    });

    test("rejects renaming non-draft tasks but allows other updates", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Original prompt",
        name: "Started Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      await expect(
        manager.updateTask(task.config.id, {
          name: "Renamed Started Task",
        })
      ).rejects.toMatchObject({
        code: "TASK_RENAME_RESTRICTED",
        status: 409,
      });

      const updated = await manager.updateTask(task.config.id, {
        prompt: "Updated prompt",
      });

      expect(updated).not.toBeNull();
      expect(updated!.config.name).toBe("Started Task");
      expect(updated!.config.prompt).toBe("Updated prompt");
    });

    test("rejects baseBranch update when git state exists", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      await updateTaskState(task.config.id, {
        ...task.state,
        git: {
          originalBranch: "main",
          workingBranch: "test-a1b2c3d",
          commits: [],
        },
      });

      await expect(
        manager.updateTask(task.config.id, {
          baseBranch: "develop",
        })
      ).rejects.toMatchObject({
        code: "BASE_BRANCH_IMMUTABLE",
        status: 409,
      });
    });

    test("allows baseBranch update when git state is undefined", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const updated = await manager.updateTask(task.config.id, {
        baseBranch: "develop",
      });

      expect(updated).not.toBeNull();
      expect(updated!.config.baseBranch).toBe("develop");
    });

    test("rejects useWorktree update when git state exists", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
        useWorktree: true,
      });

      await updateTaskState(task.config.id, {
        ...task.state,
        git: {
          originalBranch: "main",
          workingBranch: "test-a1b2c3d",
          worktreePath: `${testWorkDir}/.clanky-worktrees/${task.config.id}`,
          commits: [],
        },
      });

      await expect(
        manager.updateTask(task.config.id, {
          useWorktree: false,
        })
      ).rejects.toMatchObject({
        code: "USE_WORKTREE_IMMUTABLE",
        status: 409,
      });
    });

    test("allows useWorktree update when git state is undefined", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
        useWorktree: true,
      });

      const updated = await manager.updateTask(task.config.id, {
        useWorktree: false,
      });

      expect(updated).not.toBeNull();
      expect(updated!.config.useWorktree).toBe(false);
    });
   
    test("returns null for non-existent task", async () => {
      const updated = await manager.updateTask("non-existent", { prompt: "Test" });
      expect(updated).toBeNull();
    });
  });

  describe("deleteTask", () => {
    test("soft-deletes a task (marks as deleted)", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const deleted = await manager.deleteTask(task.config.id);
      expect(deleted).toBe(true);

      // Soft delete: task still exists but with status "deleted"
      const fetched = await manager.getTask(task.config.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.state.status).toBe("deleted");

      // Check delete event
      const deleteEvents = emittedEvents.filter((e) => e.type === "task.deleted");
      expect(deleteEvents.length).toBe(1);
    });

    test("purges a deleted task", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // First soft delete
      await manager.deleteTask(task.config.id);
      
      // Then purge
      const purgeResult = await manager.purgeTask(task.config.id);
      expect(purgeResult.success).toBe(true);

      // Now it should be actually gone
      const fetched = await manager.getTask(task.config.id);
      expect(fetched).toBeNull();
    });

    test("cannot purge a non-deleted/non-merged task", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const purgeResult = await manager.purgeTask(task.config.id);
      expect(purgeResult.success).toBe(false);
      expect(purgeResult.error).toContain("Cannot purge task in status");
    });

    test("fails purge when worktree cleanup leaves an orphaned directory behind", async () => {
      await Bun.$`git init ${testWorkDir}`.quiet();
      await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`git -C ${testWorkDir} commit --allow-empty -m "Initial commit"`.quiet();

      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
        useWorktree: true,
      });
      const worktreePath = `${testWorkDir}/.clanky-worktrees/${task.config.id}`;
      await Bun.$`mkdir -p ${worktreePath}`.quiet();

      await updateTaskState(task.config.id, {
        ...task.state,
        status: "deleted",
        git: {
          originalBranch: "main",
          workingBranch: "purge-task-a1b2c3d",
          worktreePath,
          commits: [],
        },
      });

      const purgeResult = await manager.purgeTask(task.config.id);
      expect(purgeResult.success).toBe(false);
      expect(purgeResult.error).toContain("Failed to clean up git state during purge");
      expect(purgeResult.error).toContain("Worktree directory still exists after cleanup");

      const fetched = await manager.getTask(task.config.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.state.status).toBe("deleted");
    });

    test("purges a deleted task even when its workspace record is missing", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
        useWorktree: true,
      });

      await updateTaskState(task.config.id, {
        ...task.state,
        status: "deleted",
        git: {
          originalBranch: "main",
          workingBranch: "missing-workspace-a1b2c3d",
          worktreePath: `${testWorkDir}/.clanky-worktrees/${task.config.id}`,
          commits: [],
        },
      });

      const { getDatabase } = await import("../../src/persistence/database");
      const db = getDatabase();
      db.run("PRAGMA foreign_keys = OFF");
      try {
        db.run("DELETE FROM workspaces WHERE id = ?", [testWorkspaceId]);
      } finally {
        db.run("PRAGMA foreign_keys = ON");
      }

      const purgeResult = await manager.purgeTask(task.config.id);

      expect(purgeResult.success).toBe(true);
      expect(await manager.getTask(task.config.id)).toBeNull();
    });

    test("returns false for non-existent task", async () => {
      const deleted = await manager.deleteTask("non-existent");
      expect(deleted).toBe(false);
    });

    test("soft-deletes a task with git state even when its workspace record is missing", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      await updateTaskState(task.config.id, {
        ...task.state,
        git: {
          originalBranch: "main",
          workingBranch: "missing-workspace-delete-a1b2c3d",
          commits: [],
        },
      });

      const { getDatabase } = await import("../../src/persistence/database");
      const db = getDatabase();
      db.run("PRAGMA foreign_keys = OFF");
      try {
        db.run("DELETE FROM workspaces WHERE id = ?", [testWorkspaceId]);
      } finally {
        db.run("PRAGMA foreign_keys = ON");
      }

      const deleted = await manager.deleteTask(task.config.id);
      const updated = await manager.getTask(task.config.id);

      expect(deleted).toBe(true);
      expect(updated?.state.status).toBe("deleted");
    });
  });

  describe("markMerged", () => {
    test("requires task to be in final state", async () => {
      // Create a task in idle state (not a final state)
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const result = await manager.markMerged(task.config.id);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot mark task as merged");
      expect(result.error).toContain("idle");
    });

    test("requires task to have git state", async () => {
      // Create a task and set it to a final state without git
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Manually update the state to a pushed state without git
      await updateTaskState(task.config.id, {
        ...task.state,
        status: "pushed",
        // No git state
      });

      const result = await manager.markMerged(task.config.id);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("No git branch");
    });

    test("returns error for non-existent task", async () => {
      const result = await manager.markMerged("non-existent-id");
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    // Note: Success case for markMerged requires real git operations and is tested
    // in e2e/git-workflow.test.ts which verifies:
    // - Task status becomes "merged"
    // - Repository stays on the original branch
    // - task.merged event is emitted
  });

  describe("manualCompleteTask", () => {
    test("requires halted tasks to have git state", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      await updateTaskState(task.config.id, {
        ...task.state,
        status: "failed",
        error: {
          message: "Task failed before git setup",
          iteration: 0,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await manager.manualCompleteTask(task.config.id);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No git branch");

      const fetched = await manager.getTask(task.config.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.state.status).toBe("failed");
    });

    test("removes stale engines before persisting manual completion", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });
      const failedState = {
        ...task.state,
        status: "failed" as const,
        git: {
          originalBranch: "main",
          workingBranch: "manual-complete-test-branch",
          commits: [],
        },
        error: {
          message: "Manual completion regression",
          iteration: 1,
          timestamp: new Date().toISOString(),
        },
      };
      await updateTaskState(task.config.id, failedState);

      const staleEngineState = structuredClone(failedState) as TaskState;
      const engineMap = (manager as unknown as { engines: Map<string, unknown> }).engines;
      engineMap.set(task.config.id, {
        config: task.config,
        state: staleEngineState,
      });

      const result = await manager.manualCompleteTask(task.config.id);

      expect(result.success).toBe(true);
      expect(manager.isRunning(task.config.id)).toBe(false);
      expect(staleEngineState.status).toBe("completed");
      expect(staleEngineState.error).toBeUndefined();

      const fetched = await manager.getTask(task.config.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.state.status).toBe("completed");
      expect(fetched!.state.error).toBeUndefined();
    });
  });

  describe("isRunning", () => {
    test("returns false for non-running task", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      expect(manager.isRunning(task.config.id)).toBe(false);
    });
  });

  describe("clearPlanningFolder option", () => {
    test("creates a task with clearPlanningFolder = true", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Task with clearing",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        clearPlanningFolder: true,
        planMode: false,
      });

      expect(task.config.clearPlanningFolder).toBe(true);
    });

    test("creates a task with clearPlanningFolder = false", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Task without clearing",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        clearPlanningFolder: false,
        planMode: false,
      });

      expect(task.config.clearPlanningFolder).toBe(false);
    });

    test("creates a task with clearPlanningFolder defaulting to false", async () => {
      const task = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Task with default",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // After persistence, clearPlanningFolder defaults to false (not undefined)
      expect(task.config.clearPlanningFolder).toBe(false);
    });

    test("clearPlanningFolder is persisted correctly", async () => {
      const created = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test persistence",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        clearPlanningFolder: true,
        planMode: false,
      });

      // Fetch the task to verify persistence
      const fetched = await manager.getTask(created.config.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.config.clearPlanningFolder).toBe(true);
    });
  });

  describe("active task validation", () => {
    test("creates draft tasks without active task check", async () => {
      // First create a running task (simulate by setting status manually)
      const runningTask = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Running task",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Update status to running
      await updateTaskState(runningTask.config.id, {
        ...runningTask.state,
        status: "running",
      });

      // Draft tasks should not be blocked by existing active tasks
      const draftTask = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Draft task",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        draft: true,
        planMode: false,
      });

      expect(draftTask.config.id).toBeDefined();
      expect(draftTask.state.status).toBe("draft");
    });

    test("draft tasks do not block other tasks from being created", async () => {
      // Create a draft task first
      const draftTask = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Draft task",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        draft: true,
        planMode: false,
      });

      expect(draftTask.state.status).toBe("draft");

      // Create another task - should work since draft doesn't block
      const normalTask = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Normal task",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Normal task should be created
      expect(normalTask.config.id).toBeDefined();
      expect(normalTask.state.status).toBe("idle");
    });

    test("terminal state tasks do not block new tasks", async () => {
      const terminalStatuses = ["completed", "stopped", "failed", "max_iterations", "merged", "pushed", "deleted"] as const;

      for (const status of terminalStatuses) {
        // Create a task and set it to terminal state
        const terminalTask = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
          prompt: `Terminal ${status} task`,
          name: "Test Task",
          workspaceId: testWorkspaceId,
          planMode: false,
        });

        await updateTaskState(terminalTask.config.id, {
          ...terminalTask.state,
          status: status,
        });

        // Verify the status was set
        const verifyTask = await manager.getTask(terminalTask.config.id);
        expect(verifyTask?.state.status).toBe(status);
      }

      // Creating a new task should still work since all are terminal
      const newTask = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "New task after terminals",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      expect(newTask.config.id).toBeDefined();
      expect(newTask.state.status).toBe("idle");
    });
  });

  describe("forceResetAll", () => {
    test("preserves planning tasks during reset", async () => {
      // Create a task and set it to planning status
      const planningTask = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Planning task",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: true,
      });

      expect(planningTask.state.status).toBe("planning");
      
      // Set up plan mode state with isPlanReady = true
      await updateTaskState(planningTask.config.id, {
        ...planningTask.state,
        status: "planning",
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: true,
          planContent: "Test plan content",
        },
      });

      // Call forceResetAll
      const result = await manager.forceResetAll();
      
      expect(result.enginesCleared).toBe(0); // No engines in memory since we didn't start
      expect(result.tasksReset).toBe(0); // Planning tasks should not be reset

      // Verify the planning task still has planning status
      const fetchedTask = await manager.getTask(planningTask.config.id);
      expect(fetchedTask).not.toBeNull();
      expect(fetchedTask!.state.status).toBe("planning");
      expect(fetchedTask!.state.planMode?.isPlanReady).toBe(true);
    });

    test("stops non-planning tasks during reset", async () => {
      // Create a task and set it to running status
      const runningTask = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Running task",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Update to running status
      await updateTaskState(runningTask.config.id, {
        ...runningTask.state,
        status: "running",
      });

      // Call forceResetAll
      const result = await manager.forceResetAll();
      
      // Running tasks should be reset to stopped
      expect(result.tasksReset).toBe(1);

      // Verify the running task is now stopped
      const fetchedTask = await manager.getTask(runningTask.config.id);
      expect(fetchedTask).not.toBeNull();
      expect(fetchedTask!.state.status).toBe("stopped");
    });

    test("preserves planning tasks while stopping running tasks", async () => {
      // Create a planning task
      const planningTask = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Planning task",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: true,
      });

      await updateTaskState(planningTask.config.id, {
        ...planningTask.state,
        status: "planning",
        planMode: {
          active: true,
          feedbackRounds: 1,
          planningFolderCleared: true,
          isPlanReady: true,
        },
      });

      // Create a running task
      const runningTask = await manager.createTask({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Running task",
        name: "Test Task",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      await updateTaskState(runningTask.config.id, {
        ...runningTask.state,
        status: "running",
      });

      // Call forceResetAll
      const result = await manager.forceResetAll();
      
      // Only running task should be reset
      expect(result.tasksReset).toBe(1);

      // Planning task should still be in planning status
      const fetchedPlanningTask = await manager.getTask(planningTask.config.id);
      expect(fetchedPlanningTask!.state.status).toBe("planning");
      expect(fetchedPlanningTask!.state.planMode?.isPlanReady).toBe(true);

      // Running task should be stopped
      const fetchedRunningTask = await manager.getTask(runningTask.config.id);
      expect(fetchedRunningTask!.state.status).toBe("stopped");
    });
  });

});
