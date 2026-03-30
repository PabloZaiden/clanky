/**
 * Unit tests for persistence layer.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Loop, LoopStatus } from "../../src/types/loop";
import { DEFAULT_LOOP_CONFIG } from "../../src/types/loop";
import { getDefaultServerSettings } from "../../src/types/settings";

// We need to set the env var before importing the module
let testDataDir: string;
const testWorkspaceId = "test-workspace-id";

/**
 * Helper to ensure data directories and create test workspace.
 */
async function setupPersistence(): Promise<void> {
  const { ensureDataDirectories } = await import("../../src/persistence/database");
  const { createWorkspace } = await import("../../src/persistence/workspaces");
  
  await ensureDataDirectories();
  
  // Create the test workspace (required for loops with workspaceId)
  await createWorkspace({
    id: testWorkspaceId,
    name: "Test Workspace",
    directory: "/tmp/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    serverSettings: getDefaultServerSettings(),
  });
}

/**
 * Helper function to create a test loop with all required fields.
 */
function createTestLoop(overrides: {
  id: string;
  name?: string;
  directory?: string;
  prompt?: string;
  status?: LoopStatus;
  currentIteration?: number;
  createdAt?: string;
}): Loop {
  const now = new Date().toISOString();
  return {
    config: {
      id: overrides.id,
      name: overrides.name ?? overrides.id,
      directory: overrides.directory ?? "/tmp/test",
      prompt: overrides.prompt ?? "Test",
      createdAt: overrides.createdAt ?? now,
      updatedAt: now,
      workspaceId: "test-workspace-id",
      model: { providerID: "test-provider", modelID: "test-model" },
      stopPattern: "<promise>COMPLETE</promise>$",
      git: { branchPrefix: "", commitScope: "" },
      maxIterations: Infinity,
      maxConsecutiveErrors: 10,
      activityTimeoutSeconds: DEFAULT_LOOP_CONFIG.activityTimeoutSeconds,
      useWorktree: DEFAULT_LOOP_CONFIG.useWorktree,
      clearPlanningFolder: false,
      planMode: false,
      planModeAutoReply: true,
      mode: "loop",
    },
    state: {
      id: overrides.id,
      status: overrides.status ?? "idle",
      currentIteration: overrides.currentIteration ?? 0,
      recentIterations: [],
      logs: [],
      messages: [],
      toolCalls: [],
    },
  };
}

describe("Persistence", () => {
  beforeEach(async () => {
    // Create a temp directory for each test
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-test-"));
    process.env["RALPHER_DATA_DIR"] = testDataDir;
  });

  afterEach(async () => {
    // Close the database before cleaning up
    const { closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();

    // Clean up
    delete process.env["RALPHER_DATA_DIR"];
    await rm(testDataDir, { recursive: true });
  });

  describe("paths", () => {
    test("getDataDir returns env var when set", async () => {
      // Re-import to get fresh module with env var
      const { getDataDir } = await import("../../src/persistence/database");
      expect(getDataDir()).toBe(testDataDir);
    });

    test("getDatabasePath returns correct path", async () => {
      const { getDatabasePath } = await import("../../src/persistence/database");
      expect(getDatabasePath()).toBe(join(testDataDir, "ralpher.db"));
    });

    test("ensureDataDirectories creates database", async () => {
      const { ensureDataDirectories, isDataDirectoryReady } = await import("../../src/persistence/database");

      await ensureDataDirectories();

      const ready = await isDataDirectoryReady();
      expect(ready).toBe(true);
    });

    test("initializeDatabase repairs the chats table when legacy schema_migrations versions already exist", async () => {
      const { Database } = await import("bun:sqlite");
      const databasePath = join(testDataDir, "ralpher.db");
      const legacyDb = new Database(databasePath);

      legacyDb.run(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      legacyDb.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
        1,
        "legacy_reset_one",
        "2025-01-01T00:00:00.000Z",
      ]);
      legacyDb.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
        2,
        "legacy_reset_two",
        "2025-01-01T00:00:00.000Z",
      ]);
      legacyDb.close();

      const { initializeDatabase, getDatabase } = await import("../../src/persistence/database");
      await initializeDatabase();

      const row = getDatabase().query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chats'",
      ).get() as { name: string } | null;

      expect(row?.name).toBe("chats");
    });
  });

  describe("loops", () => {
    test("saveLoop and loadLoop work correctly", async () => {
      const { saveLoop, loadLoop } = await import("../../src/persistence/loops");

      await setupPersistence();

      const testLoop = createTestLoop({
        id: "test-loop-123",
        name: "test-loop",
        prompt: "Do something",
      });

      await saveLoop(testLoop);
      const loaded = await loadLoop("test-loop-123");

      expect(loaded).not.toBeNull();
      expect(loaded!.state.status).toBe("idle");
    });

    test("loadLoop normalizes legacy generic ralph commit scope", async () => {
      const { saveLoop, loadLoop } = await import("../../src/persistence/loops");

      await setupPersistence();

      const testLoop = createTestLoop({
        id: "legacy-scope-loop",
        name: "legacy-scope-loop",
      });
      testLoop.config.git.commitScope = "ralph";

      await saveLoop(testLoop);
      const loaded = await loadLoop("legacy-scope-loop");

      expect(loaded).not.toBeNull();
      expect(loaded!.config.git.commitScope).toBe("");
    });

    test("loadLoop coerces legacy persisted chat mode to loop", async () => {
      const { saveLoop, loadLoop } = await import("../../src/persistence/loops");
      const { getDatabase } = await import("../../src/persistence/database");

      await setupPersistence();

      const testLoop = createTestLoop({
        id: "legacy-mode-loop",
        name: "legacy-mode-loop",
      });

      await saveLoop(testLoop);
      getDatabase().run("UPDATE loops SET mode = 'chat' WHERE id = ?", ["legacy-mode-loop"]);

      const loaded = await loadLoop("legacy-mode-loop");

      expect(loaded).not.toBeNull();
      expect(loaded!.config.mode).toBe("loop");
    });

    test("persists plan-mode auto-reply and pending questions", async () => {
      const { saveLoop, loadLoop } = await import("../../src/persistence/loops");

      await setupPersistence();

      const testLoop = createTestLoop({
        id: "pending-question-loop",
        status: "planning",
      });
      testLoop.config.planMode = true;
      testLoop.config.planModeAutoReply = false;
      testLoop.state.planMode = {
        active: true,
        feedbackRounds: 0,
        planningFolderCleared: false,
        isPlanReady: false,
        pendingQuestion: {
          requestId: "question-1",
          sessionId: "session-1",
          askedAt: new Date().toISOString(),
          questions: [
            {
              header: "Pick one",
              question: "How should the plan proceed?",
              options: [
                { label: "Option A", description: "Try A" },
              ],
              custom: true,
            },
          ],
        },
      };

      await saveLoop(testLoop);
      const loaded = await loadLoop("pending-question-loop");

      expect(loaded?.config.planModeAutoReply).toBe(false);
      expect(loaded?.state.planMode?.pendingQuestion?.requestId).toBe("question-1");
      expect(loaded?.state.planMode?.pendingQuestion?.questions[0]?.custom).toBe(true);
    });

    test("loadLoop returns null for non-existent loop", async () => {
      const { loadLoop } = await import("../../src/persistence/loops");

      await setupPersistence();

      const loaded = await loadLoop("non-existent");
      expect(loaded).toBeNull();
    });

    test("deleteLoop removes the loop", async () => {
      const { saveLoop, loadLoop, deleteLoop } = await import("../../src/persistence/loops");

      await setupPersistence();

      const testLoop = createTestLoop({ id: "delete-me" });

      await saveLoop(testLoop);
      expect(await loadLoop("delete-me")).not.toBeNull();

      const deleted = await deleteLoop("delete-me");
      expect(deleted).toBe(true);
      expect(await loadLoop("delete-me")).toBeNull();
    });

    test("listLoops returns all loops", async () => {
      const { saveLoop, listLoops } = await import("../../src/persistence/loops");

      await setupPersistence();

      // Save two loops
      const loop1 = createTestLoop({
        id: "loop-1",
        directory: "/tmp/1",
        prompt: "Test 1",
        createdAt: "2024-01-01T00:00:00Z",
      });

      const loop2 = createTestLoop({
        id: "loop-2",
        directory: "/tmp/2",
        prompt: "Test 2",
        status: "running",
        currentIteration: 3,
        createdAt: "2024-01-02T00:00:00Z",
      });

      await saveLoop(loop1);
      await saveLoop(loop2);

      const loops = await listLoops();
      expect(loops.length).toBe(2);

      // Should be sorted by createdAt, newest first
      expect(loops[0]!.config.id).toBe("loop-2");
      expect(loops[1]!.config.id).toBe("loop-1");
    });

    describe("getActiveLoopByDirectory", () => {
      test("returns null when no loops exist for directory", async () => {
        const { getActiveLoopByDirectory } = await import("../../src/persistence/loops");

        await setupPersistence();

        const result = await getActiveLoopByDirectory("/tmp/test", "test-workspace-id");
        expect(result).toBeNull();
      });

      test("returns null when only draft loops exist for directory", async () => {
        const { saveLoop, getActiveLoopByDirectory } = await import("../../src/persistence/loops");

        await setupPersistence();

        const draftLoop = createTestLoop({ id: "draft-loop", status: "draft" });
        await saveLoop(draftLoop);

        const result = await getActiveLoopByDirectory("/tmp/test", "test-workspace-id");
        expect(result).toBeNull();
      });

      test("returns null when only terminal state loops exist for directory", async () => {
        const { saveLoop, getActiveLoopByDirectory } = await import("../../src/persistence/loops");

        await setupPersistence();

        const terminalStatuses: LoopStatus[] = ["completed", "stopped", "failed", "max_iterations", "merged", "pushed", "deleted"];

        for (let i = 0; i < terminalStatuses.length; i++) {
          const loop = createTestLoop({
            id: `terminal-loop-${i}`,
            status: terminalStatuses[i],
          });
          await saveLoop(loop);
        }

        const result = await getActiveLoopByDirectory("/tmp/test", "test-workspace-id");
        expect(result).toBeNull();
      });

      test("returns the active loop when one exists", async () => {
        const { saveLoop, getActiveLoopByDirectory, deleteLoop } = await import("../../src/persistence/loops");

        await setupPersistence();

        const activeStatuses: LoopStatus[] = ["idle", "planning", "starting", "running", "waiting"];

        for (const status of activeStatuses) {
          const testLoop = createTestLoop({
            id: `active-loop-${status}`,
            directory: `/tmp/active-test-${status}`,
            status,
          });

          await saveLoop(testLoop);

          const result = await getActiveLoopByDirectory(`/tmp/active-test-${status}`, "test-workspace-id");
          expect(result).not.toBeNull();
          expect(result!.config.id).toBe(`active-loop-${status}`);
          expect(result!.state.status).toBe(status);

          // Clean up
          await deleteLoop(testLoop.config.id);
        }
      });

      test("does not return loops from different directories", async () => {
        const { saveLoop, getActiveLoopByDirectory } = await import("../../src/persistence/loops");

        await setupPersistence();

        // Save a running loop in a different directory
        const otherDirLoop = createTestLoop({
          id: "other-dir-loop",
          directory: "/tmp/other-dir",
          status: "running",
        });

        await saveLoop(otherDirLoop);

        // Query for a different directory
        const result = await getActiveLoopByDirectory("/tmp/my-dir", "test-workspace-id");
        expect(result).toBeNull();
      });

      test("does not return loops from different workspaces with the same directory", async () => {
        const { saveLoop, getActiveLoopByDirectory } = await import("../../src/persistence/loops");
        const { createWorkspace } = await import("../../src/persistence/workspaces");

        await setupPersistence();

        // Create a second workspace with the same directory
        const otherWorkspaceId = "other-workspace-id";
        await createWorkspace({
          id: otherWorkspaceId,
          name: "Other Workspace",
          directory: "/tmp/test",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          serverSettings: getDefaultServerSettings(),
        });

        // Save a running loop in the other workspace's directory
        const otherWsLoop = createTestLoop({
          id: "other-ws-loop",
          directory: "/tmp/test",
          status: "running",
        });
        // Override workspaceId to point to the other workspace
        otherWsLoop.config.workspaceId = otherWorkspaceId;
        await saveLoop(otherWsLoop);

        // Query should NOT find it when looking for test-workspace-id
        const result = await getActiveLoopByDirectory("/tmp/test", "test-workspace-id");
        expect(result).toBeNull();

        // But SHOULD find it when looking for other-workspace-id
        const otherResult = await getActiveLoopByDirectory("/tmp/test", otherWorkspaceId);
        expect(otherResult).not.toBeNull();
        expect(otherResult!.config.id).toBe("other-ws-loop");
      });

      test("returns the active loop even when other loops exist for same directory", async () => {
        const { saveLoop, getActiveLoopByDirectory } = await import("../../src/persistence/loops");

        await setupPersistence();

        // Save a draft loop
        const draftLoop = createTestLoop({
          id: "draft-loop",
          directory: "/tmp/multi-test",
          status: "draft",
        });
        await saveLoop(draftLoop);

        // Save a completed loop
        const completedLoop = createTestLoop({
          id: "completed-loop",
          directory: "/tmp/multi-test",
          status: "completed",
          currentIteration: 5,
        });
        await saveLoop(completedLoop);

        // Save a running loop
        const runningLoop = createTestLoop({
          id: "running-loop",
          directory: "/tmp/multi-test",
          status: "running",
          currentIteration: 2,
        });
        await saveLoop(runningLoop);

        const result = await getActiveLoopByDirectory("/tmp/multi-test", "test-workspace-id");
        expect(result).not.toBeNull();
        expect(result!.config.id).toBe("running-loop");
        expect(result!.state.status).toBe("running");
      });
    });

    describe("resetStaleLoops", () => {
      test("resetStaleLoop resets a single stale loop without touching planning loops", async () => {
        const { saveLoop, loadLoop, resetStaleLoop } = await import("../../src/persistence/loops");

        await setupPersistence();

        const runningLoop = createTestLoop({
          id: "single-running-loop",
          directory: "/tmp/test-single-running",
          status: "running",
        });
        await saveLoop(runningLoop);

        const planningLoop = createTestLoop({
          id: "single-planning-loop",
          directory: "/tmp/test-single-planning",
          status: "planning",
        });
        await saveLoop(planningLoop);

        const runningReset = await resetStaleLoop("single-running-loop");
        const planningReset = await resetStaleLoop("single-planning-loop");

        expect(runningReset).toBe(true);
        expect(planningReset).toBe(false);

        const loadedRunning = await loadLoop("single-running-loop");
        expect(loadedRunning).not.toBeNull();
        expect(loadedRunning!.state.status).toBe("stopped");
        expect(loadedRunning!.state.error?.message).toBe("Forcefully stopped by connection reset");
        expect(loadedRunning!.state.error?.iteration).toBe(0);

        const loadedPlanning = await loadLoop("single-planning-loop");
        expect(loadedPlanning).not.toBeNull();
        expect(loadedPlanning!.state.status).toBe("planning");
      });

      test("resets idle loops to stopped", async () => {
        const { saveLoop, loadLoop, resetStaleLoops } = await import("../../src/persistence/loops");

        await setupPersistence();

        const idleLoop = createTestLoop({
          id: "idle-loop",
          status: "idle",
        });
        await saveLoop(idleLoop);

        const resetCount = await resetStaleLoops();
        expect(resetCount).toBe(1);

        const loaded = await loadLoop("idle-loop");
        expect(loaded).not.toBeNull();
        expect(loaded!.state.status).toBe("stopped");
        expect(loaded!.state.error?.message).toBe("Forcefully stopped by connection reset");
        expect(loaded!.state.error?.iteration).toBe(0);
      });

      test("resets running and waiting loops to stopped", async () => {
        const { saveLoop, loadLoop, resetStaleLoops } = await import("../../src/persistence/loops");

        await setupPersistence();

        const runningLoop = createTestLoop({
          id: "running-loop",
          directory: "/tmp/test-running",
          status: "running",
        });
        await saveLoop(runningLoop);

        const waitingLoop = createTestLoop({
          id: "waiting-loop",
          directory: "/tmp/test-waiting",
          status: "waiting",
        });
        await saveLoop(waitingLoop);

        const startingLoop = createTestLoop({
          id: "starting-loop",
          directory: "/tmp/test-starting",
          status: "starting",
        });
        await saveLoop(startingLoop);

        const resetCount = await resetStaleLoops();
        expect(resetCount).toBe(3);

        const loadedRunning = await loadLoop("running-loop");
        expect(loadedRunning!.state.status).toBe("stopped");
        expect(loadedRunning!.state.error?.iteration).toBe(0);

        const loadedWaiting = await loadLoop("waiting-loop");
        expect(loadedWaiting!.state.status).toBe("stopped");
        expect(loadedWaiting!.state.error?.iteration).toBe(0);

        const loadedStarting = await loadLoop("starting-loop");
        expect(loadedStarting!.state.status).toBe("stopped");
        expect(loadedStarting!.state.error?.iteration).toBe(0);
      });

      test("does NOT reset planning loops", async () => {
        const { saveLoop, loadLoop, resetStaleLoops } = await import("../../src/persistence/loops");

        await setupPersistence();

        const planningLoop = createTestLoop({
          id: "planning-loop",
          status: "planning",
        });
        await saveLoop(planningLoop);

        const resetCount = await resetStaleLoops();
        expect(resetCount).toBe(0);

        const loaded = await loadLoop("planning-loop");
        expect(loaded).not.toBeNull();
        expect(loaded!.state.status).toBe("planning");
      });

      test("does NOT reset terminal state loops", async () => {
        const { saveLoop, loadLoop, resetStaleLoops } = await import("../../src/persistence/loops");

        await setupPersistence();

        const completedLoop = createTestLoop({
          id: "completed-loop",
          directory: "/tmp/test-completed",
          status: "completed",
        });
        await saveLoop(completedLoop);

        const stoppedLoop = createTestLoop({
          id: "stopped-loop",
          directory: "/tmp/test-stopped",
          status: "stopped",
        });
        await saveLoop(stoppedLoop);

        const failedLoop = createTestLoop({
          id: "failed-loop",
          directory: "/tmp/test-failed",
          status: "failed",
        });
        await saveLoop(failedLoop);

        const resetCount = await resetStaleLoops();
        expect(resetCount).toBe(0);

        const loadedCompleted = await loadLoop("completed-loop");
        expect(loadedCompleted!.state.status).toBe("completed");

        const loadedStopped = await loadLoop("stopped-loop");
        expect(loadedStopped!.state.status).toBe("stopped");

        const loadedFailed = await loadLoop("failed-loop");
        expect(loadedFailed!.state.status).toBe("failed");
      });

      test("returns 0 when no stale loops exist", async () => {
        const { resetStaleLoops } = await import("../../src/persistence/loops");

        await setupPersistence();

        const resetCount = await resetStaleLoops();
        expect(resetCount).toBe(0);
      });
    });
  });
});
