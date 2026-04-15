/**
 * Unit tests for LoopManager.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LoopManager } from "../../src/core/loop-manager";
import { SimpleEventEmitter } from "../../src/core/event-emitter";
import type { LoopEvent } from "../../src/types/events";
import { updateLoopState } from "../../src/persistence/loops";
import { getDefaultServerSettings } from "../../src/types/settings";
import { backendManager } from "../../src/core/backend-manager";
import type { LoopState } from "../../src/types/loop";
import { createMockBackend, MockAcpBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";

describe("LoopManager", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let manager: LoopManager;
  let emitter: SimpleEventEmitter<LoopEvent>;
  let emittedEvents: LoopEvent[];
  const testWorkspaceId = "test-workspace-id";
  
  // Default test model for loop creation (model is now required)
  const testModelFields = {
    modelProviderID: "test-provider",
    modelID: "test-model",
    modelVariant: "",
  };

  beforeEach(async () => {
    // Create temp directories
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-manager-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "ralpher-manager-test-work-"));

    // Set env var for persistence
    process.env["RALPHER_DATA_DIR"] = testDataDir;

    // Ensure data directories exist
    const { ensureDataDirectories } = await import("../../src/persistence/database");
    await ensureDataDirectories();

    // Create the test workspace (required for loops with workspaceId)
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
    emitter = new SimpleEventEmitter<LoopEvent>();
    emitter.subscribe((event) => emittedEvents.push(event));

    // Create manager
    manager = new LoopManager({
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
    delete process.env["RALPHER_DATA_DIR"];
    await rm(testDataDir, { recursive: true });
    await rm(testWorkDir, { recursive: true });
  });

  describe("createLoop", () => {
    test("creates a new loop with defaults", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Do something",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      expect(loop.config.id).toBeDefined();
      expect(loop.config.directory).toBe(testWorkDir);
      expect(loop.config.prompt).toBe("Do something");
      // Backend is now global, not per-loop config
      expect(loop.config.git.branchPrefix).toBe("");
      expect(loop.state.status).toBe("idle");

      // Check event was emitted
      const createEvents = emittedEvents.filter((e) => e.type === "loop.created");
      expect(createEvents.length).toBe(1);
    });

    test("creates a loop with custom options", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Custom task",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        // Backend options removed - now global
        maxIterations: 10,
        planMode: false,
      });

      // Backend is now global, not per-loop config
      expect(loop.config.maxIterations).toBe(10);
    });

    test("normalizes configured branch prefixes", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Custom task",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        gitBranchPrefix: " Team Alpha ",
        planMode: false,
      });

      expect(loop.config.git.branchPrefix).toBe("team-alpha/");
    });

    test("requires an explicit loop name", async () => {
      await expect(
        manager.createLoop({
          ...testModelFields,
          directory: testWorkDir,
          prompt: "Custom task",
          name: "   ",
          workspaceId: testWorkspaceId,
          planMode: false,
        })
      ).rejects.toThrow("Loop name is required");
    });
  });

  describe("getPullRequestDestination", () => {
    test("returns a sanitized disabled reason when PR resolution throws unexpectedly", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Resolve PR",
        name: "PR Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
        useWorktree: false,
      });

      await updateLoopState(loop.config.id, {
        ...loop.state,
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
          reviewBranches: [],
        },
      });

      backendManager.setExecutorFactoryForTesting(() => {
        throw new Error("sensitive executor failure from /tmp/private-path");
      });

      const destination = await manager.getPullRequestDestination(loop.config.id);

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

  describe("generateLoopTitle", () => {
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

      const title = await manager.generateLoopTitle({
        directory: testWorkDir,
        prompt: "Create a loop title for this prompt",
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

    test("falls back to the loop model when the configured cheap model is unavailable", async () => {
      const backend = new MockAcpBackend({
        responses: ["Loop title"],
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

      await manager.generateLoopTitle({
        directory: testWorkDir,
        prompt: "Create a loop title for this prompt",
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


  describe("getLoop", () => {
    test("returns a loop by ID", async () => {
      const created = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const fetched = await manager.getLoop(created.config.id);

      expect(fetched).not.toBeNull();
    });

    test("returns null for non-existent loop", async () => {
      const fetched = await manager.getLoop("non-existent-id");
      expect(fetched).toBeNull();
    });
  });

  describe("getAllLoops", () => {
    test("returns all loops", async () => {
      await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test 1",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test 2",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const loops = await manager.getAllLoops();

      expect(loops.length).toBe(2);
    });
  });

  describe("updateLoop", () => {
    test("updates loop configuration", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Original prompt",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const updated = await manager.updateLoop(loop.config.id, {
        prompt: "Updated prompt",
      });

      expect(updated).not.toBeNull();
      expect(updated!.config.prompt).toBe("Updated prompt");
    });

    test("rejects baseBranch update when git state exists", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      await updateLoopState(loop.config.id, {
        ...loop.state,
        git: {
          originalBranch: "main",
          workingBranch: "test-a1b2c3d",
          commits: [],
        },
      });

      await expect(
        manager.updateLoop(loop.config.id, {
          baseBranch: "develop",
        })
      ).rejects.toMatchObject({
        code: "BASE_BRANCH_IMMUTABLE",
        status: 409,
      });
    });

    test("allows baseBranch update when git state is undefined", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const updated = await manager.updateLoop(loop.config.id, {
        baseBranch: "develop",
      });

      expect(updated).not.toBeNull();
      expect(updated!.config.baseBranch).toBe("develop");
    });

    test("rejects useWorktree update when git state exists", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
        useWorktree: true,
      });

      await updateLoopState(loop.config.id, {
        ...loop.state,
        git: {
          originalBranch: "main",
          workingBranch: "test-a1b2c3d",
          worktreePath: `${testWorkDir}/.ralph-worktrees/${loop.config.id}`,
          commits: [],
        },
      });

      await expect(
        manager.updateLoop(loop.config.id, {
          useWorktree: false,
        })
      ).rejects.toMatchObject({
        code: "USE_WORKTREE_IMMUTABLE",
        status: 409,
      });
    });

    test("allows useWorktree update when git state is undefined", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
        useWorktree: true,
      });

      const updated = await manager.updateLoop(loop.config.id, {
        useWorktree: false,
      });

      expect(updated).not.toBeNull();
      expect(updated!.config.useWorktree).toBe(false);
    });
   
    test("returns null for non-existent loop", async () => {
      const updated = await manager.updateLoop("non-existent", { prompt: "Test" });
      expect(updated).toBeNull();
    });
  });

  describe("deleteLoop", () => {
    test("soft-deletes a loop (marks as deleted)", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const deleted = await manager.deleteLoop(loop.config.id);
      expect(deleted).toBe(true);

      // Soft delete: loop still exists but with status "deleted"
      const fetched = await manager.getLoop(loop.config.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.state.status).toBe("deleted");

      // Check delete event
      const deleteEvents = emittedEvents.filter((e) => e.type === "loop.deleted");
      expect(deleteEvents.length).toBe(1);
    });

    test("purges a deleted loop", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // First soft delete
      await manager.deleteLoop(loop.config.id);
      
      // Then purge
      const purgeResult = await manager.purgeLoop(loop.config.id);
      expect(purgeResult.success).toBe(true);

      // Now it should be actually gone
      const fetched = await manager.getLoop(loop.config.id);
      expect(fetched).toBeNull();
    });

    test("cannot purge a non-deleted/non-merged loop", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const purgeResult = await manager.purgeLoop(loop.config.id);
      expect(purgeResult.success).toBe(false);
      expect(purgeResult.error).toContain("Cannot purge loop in status");
    });

    test("fails purge when worktree cleanup leaves an orphaned directory behind", async () => {
      await Bun.$`git init ${testWorkDir}`.quiet();
      await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
      await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
      await Bun.$`git -C ${testWorkDir} commit --allow-empty -m "Initial commit"`.quiet();

      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
        useWorktree: true,
      });
      const worktreePath = `${testWorkDir}/.ralph-worktrees/${loop.config.id}`;
      await Bun.$`mkdir -p ${worktreePath}`.quiet();

      await updateLoopState(loop.config.id, {
        ...loop.state,
        status: "deleted",
        git: {
          originalBranch: "main",
          workingBranch: "purge-loop-a1b2c3d",
          worktreePath,
          commits: [],
        },
      });

      const purgeResult = await manager.purgeLoop(loop.config.id);
      expect(purgeResult.success).toBe(false);
      expect(purgeResult.error).toContain("Failed to clean up git state during purge");
      expect(purgeResult.error).toContain("Worktree directory still exists after cleanup");

      const fetched = await manager.getLoop(loop.config.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.state.status).toBe("deleted");
    });

    test("returns false for non-existent loop", async () => {
      const deleted = await manager.deleteLoop("non-existent");
      expect(deleted).toBe(false);
    });
  });

  describe("markMerged", () => {
    test("requires loop to be in final state", async () => {
      // Create a loop in idle state (not a final state)
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      const result = await manager.markMerged(loop.config.id);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot mark loop as merged");
      expect(result.error).toContain("idle");
    });

    test("requires loop to have git state", async () => {
      // Create a loop and set it to a final state without git
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Manually update the state to a final state without git
      await updateLoopState(loop.config.id, {
        ...loop.state,
        status: "completed",
        // No git state
      });

      const result = await manager.markMerged(loop.config.id);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("No git branch");
    });

    test("returns error for non-existent loop", async () => {
      const result = await manager.markMerged("non-existent-id");
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    // Note: Success case for markMerged requires real git operations and is tested
    // in e2e/git-workflow.test.ts which verifies:
    // - Loop status becomes "merged"
    // - Repository stays on the original branch
    // - loop.merged event is emitted
  });

  describe("manualCompleteLoop", () => {
    test("requires halted loops to have git state", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      await updateLoopState(loop.config.id, {
        ...loop.state,
        status: "failed",
        error: {
          message: "Loop failed before git setup",
          iteration: 0,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await manager.manualCompleteLoop(loop.config.id);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No git branch");

      const fetched = await manager.getLoop(loop.config.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.state.status).toBe("failed");
    });

    test("removes stale engines before persisting manual completion", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });
      const failedState = {
        ...loop.state,
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
      await updateLoopState(loop.config.id, failedState);

      const staleEngineState = structuredClone(failedState) as LoopState;
      const engineMap = (manager as unknown as { engines: Map<string, unknown> }).engines;
      engineMap.set(loop.config.id, {
        config: loop.config,
        state: staleEngineState,
      });

      const result = await manager.manualCompleteLoop(loop.config.id);

      expect(result.success).toBe(true);
      expect(manager.isRunning(loop.config.id)).toBe(false);
      expect(staleEngineState.status).toBe("completed");
      expect(staleEngineState.error).toBeUndefined();

      const fetched = await manager.getLoop(loop.config.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.state.status).toBe("completed");
      expect(fetched!.state.error).toBeUndefined();
    });
  });

  describe("isRunning", () => {
    test("returns false for non-running loop", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      expect(manager.isRunning(loop.config.id)).toBe(false);
    });
  });

  describe("clearPlanningFolder option", () => {
    test("creates a loop with clearPlanningFolder = true", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Task with clearing",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        clearPlanningFolder: true,
        planMode: false,
      });

      expect(loop.config.clearPlanningFolder).toBe(true);
    });

    test("creates a loop with clearPlanningFolder = false", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Task without clearing",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        clearPlanningFolder: false,
        planMode: false,
      });

      expect(loop.config.clearPlanningFolder).toBe(false);
    });

    test("creates a loop with clearPlanningFolder defaulting to false", async () => {
      const loop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Task with default",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // After persistence, clearPlanningFolder defaults to false (not undefined)
      expect(loop.config.clearPlanningFolder).toBe(false);
    });

    test("clearPlanningFolder is persisted correctly", async () => {
      const created = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Test persistence",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        clearPlanningFolder: true,
        planMode: false,
      });

      // Fetch the loop to verify persistence
      const fetched = await manager.getLoop(created.config.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.config.clearPlanningFolder).toBe(true);
    });
  });

  describe("active loop validation", () => {
    test("creates draft loops without active loop check", async () => {
      // First create a running loop (simulate by setting status manually)
      const runningLoop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Running task",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Update status to running
      await updateLoopState(runningLoop.config.id, {
        ...runningLoop.state,
        status: "running",
      });

      // Draft loops should not be blocked by existing active loops
      const draftLoop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Draft task",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        draft: true,
        planMode: false,
      });

      expect(draftLoop.config.id).toBeDefined();
      expect(draftLoop.state.status).toBe("draft");
    });

    test("draft loops do not block other loops from being created", async () => {
      // Create a draft loop first
      const draftLoop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Draft task",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        draft: true,
        planMode: false,
      });

      expect(draftLoop.state.status).toBe("draft");

      // Create another loop - should work since draft doesn't block
      const normalLoop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Normal task",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Normal loop should be created
      expect(normalLoop.config.id).toBeDefined();
      expect(normalLoop.state.status).toBe("idle");
    });

    test("terminal state loops do not block new loops", async () => {
      const terminalStatuses = ["completed", "stopped", "failed", "max_iterations", "merged", "pushed", "deleted"] as const;

      for (const status of terminalStatuses) {
        // Create a loop and set it to terminal state
        const terminalLoop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
          prompt: `Terminal ${status} task`,
          name: "Test Loop",
          workspaceId: testWorkspaceId,
          planMode: false,
        });

        await updateLoopState(terminalLoop.config.id, {
          ...terminalLoop.state,
          status: status,
        });

        // Verify the status was set
        const verifyLoop = await manager.getLoop(terminalLoop.config.id);
        expect(verifyLoop?.state.status).toBe(status);
      }

      // Creating a new loop should still work since all are terminal
      const newLoop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "New task after terminals",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      expect(newLoop.config.id).toBeDefined();
      expect(newLoop.state.status).toBe("idle");
    });
  });

  describe("forceResetAll", () => {
    test("preserves planning loops during reset", async () => {
      // Create a loop and set it to planning status
      const planningLoop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Planning task",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: true,
      });

      expect(planningLoop.state.status).toBe("planning");
      
      // Set up plan mode state with isPlanReady = true
      await updateLoopState(planningLoop.config.id, {
        ...planningLoop.state,
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
      expect(result.loopsReset).toBe(0); // Planning loops should not be reset

      // Verify the planning loop still has planning status
      const fetchedLoop = await manager.getLoop(planningLoop.config.id);
      expect(fetchedLoop).not.toBeNull();
      expect(fetchedLoop!.state.status).toBe("planning");
      expect(fetchedLoop!.state.planMode?.isPlanReady).toBe(true);
    });

    test("stops non-planning loops during reset", async () => {
      // Create a loop and set it to running status
      const runningLoop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Running task",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      // Update to running status
      await updateLoopState(runningLoop.config.id, {
        ...runningLoop.state,
        status: "running",
      });

      // Call forceResetAll
      const result = await manager.forceResetAll();
      
      // Running loops should be reset to stopped
      expect(result.loopsReset).toBe(1);

      // Verify the running loop is now stopped
      const fetchedLoop = await manager.getLoop(runningLoop.config.id);
      expect(fetchedLoop).not.toBeNull();
      expect(fetchedLoop!.state.status).toBe("stopped");
    });

    test("preserves planning loops while stopping running loops", async () => {
      // Create a planning loop
      const planningLoop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Planning task",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: true,
      });

      await updateLoopState(planningLoop.config.id, {
        ...planningLoop.state,
        status: "planning",
        planMode: {
          active: true,
          feedbackRounds: 1,
          planningFolderCleared: true,
          isPlanReady: true,
        },
      });

      // Create a running loop
      const runningLoop = await manager.createLoop({
        ...testModelFields,
        directory: testWorkDir,
        prompt: "Running task",
        name: "Test Loop",
        workspaceId: testWorkspaceId,
        planMode: false,
      });

      await updateLoopState(runningLoop.config.id, {
        ...runningLoop.state,
        status: "running",
      });

      // Call forceResetAll
      const result = await manager.forceResetAll();
      
      // Only running loop should be reset
      expect(result.loopsReset).toBe(1);

      // Planning loop should still be in planning status
      const fetchedPlanningLoop = await manager.getLoop(planningLoop.config.id);
      expect(fetchedPlanningLoop!.state.status).toBe("planning");
      expect(fetchedPlanningLoop!.state.planMode?.isPlanReady).toBe(true);

      // Running loop should be stopped
      const fetchedRunningLoop = await manager.getLoop(runningLoop.config.id);
      expect(fetchedRunningLoop!.state.status).toBe("stopped");
    });
  });

});
