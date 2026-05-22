/**
 * Unit tests for persistence layer.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Task, TaskStatus } from "../../src/types/task";
import { DEFAULT_TASK_CONFIG } from "../../src/types/task";
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
  
  // Create the test workspace (required for tasks with workspaceId)
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
 * Helper function to create a test task with all required fields.
 */
function createTestTask(overrides: {
  id: string;
  name?: string;
  directory?: string;
  prompt?: string;
  status?: TaskStatus;
  currentIteration?: number;
  createdAt?: string;
}): Task {
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
      model: { providerID: "test-provider", modelID: "test-model", variant: "" },
      stopPattern: "<promise>COMPLETE</promise>$",
      git: { branchPrefix: "", commitScope: "" },
      maxIterations: Infinity,
       maxConsecutiveErrors: 10,
       activityTimeoutSeconds: DEFAULT_TASK_CONFIG.activityTimeoutSeconds,
       useWorktree: DEFAULT_TASK_CONFIG.useWorktree,
       clearPlanningFolder: false,
       planMode: false,
       autoAcceptPlan: false,
       mode: "task",
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
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-test-"));
    process.env["CLANKY_DATA_DIR"] = testDataDir;
  });

  afterEach(async () => {
    // Close the database before cleaning up
    const { closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();

    // Clean up
    delete process.env["CLANKY_DATA_DIR"];
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
      expect(getDatabasePath()).toBe(join(testDataDir, "clanky.db"));
    });

    test("ensureDataDirectories creates database", async () => {
      const { ensureDataDirectories, isDataDirectoryReady } = await import("../../src/persistence/database");

      await ensureDataDirectories();

      const ready = await isDataDirectoryReady();
      expect(ready).toBe(true);
    });

    test("initializeDatabase creates the clean Clanky reset schema", async () => {
      const { initializeDatabase, getDatabase } = await import("../../src/persistence/database");
      const { getSchemaVersion } = await import("../../src/persistence/migrations");

      await initializeDatabase();

      const db = getDatabase();
      const tableNames = (db.query(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
        ORDER BY name
      `).all() as Array<{ name: string }>).map((row) => row.name);
      const taskColumns = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      const chatColumns = (db.query("PRAGMA table_info(chats)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      const sshSessionColumns = (db.query("PRAGMA table_info(ssh_sessions)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      const sshServerSessionColumns = (db.query("PRAGMA table_info(ssh_server_sessions)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      );

      expect(tableNames).toContain("tasks");
      expect(getSchemaVersion(db)).toBe(0);
      expect(taskColumns).toEqual(expect.arrayContaining([
        "auto_accept_plan",
        "pull_request_monitoring",
        "automatic_pr_flow",
        "fully_autonomous",
        "fully_autonomous_pending",
        "cheap_model",
        "pending_prompt_mode",
      ]));
      expect(chatColumns).toContain("task_id");
      expect(sshSessionColumns).toContain("use_tmux");
      expect(sshServerSessionColumns).toContain("use_tmux");
    });

    test("resetDatabase drops chats and passkey credentials before recreating the schema", async () => {
      const { ensureDataDirectories, getDatabase, resetDatabase } = await import("../../src/persistence/database");
      const { createWorkspace } = await import("../../src/persistence/workspaces");

      await ensureDataDirectories();
      await createWorkspace({
        id: testWorkspaceId,
        name: "Test Workspace",
        directory: "/tmp/test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        serverSettings: getDefaultServerSettings(),
      });

      const now = new Date().toISOString();
      const db = getDatabase();
      db.run(
        `
          INSERT INTO chats (
            id, name, workspace_id, directory, created_at, updated_at, interrupt_requested
          ) VALUES (?, ?, ?, ?, ?, ?, 0)
        `,
        ["chat-before-reset", "Chat Before Reset", testWorkspaceId, "/tmp/test", now, now],
      );
      db.run(
        `
          INSERT INTO passkey_credentials (
            id, name, credential_id, public_key, counter, device_type, backed_up, transports, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          "passkey-before-reset",
          "Primary passkey",
          "credential-before-reset",
          new Uint8Array([1, 2, 3]),
          0,
          "singleDevice",
          0,
          "[]",
          now,
          now,
        ],
      );

      resetDatabase();

      const chatsRow = db.query("SELECT COUNT(*) AS count FROM chats").get() as { count: number };
      const passkeysRow = db.query("SELECT COUNT(*) AS count FROM passkey_credentials").get() as { count: number };

      expect(chatsRow.count).toBe(0);
      expect(passkeysRow.count).toBe(0);
    });
  });

  describe("tasks", () => {
    test("saveTask and loadTask work correctly", async () => {
      const { saveTask, loadTask } = await import("../../src/persistence/tasks");

      await setupPersistence();

      const testTask = createTestTask({
        id: "test-task-123",
        name: "test-task",
        prompt: "Do something",
      });

      await saveTask(testTask);
      const loaded = await loadTask("test-task-123");

      expect(loaded).not.toBeNull();
      expect(loaded!.state.status).toBe("idle");
    });

    test("saveTask and loadTask preserve pending prompt mode", async () => {
      const { saveTask, loadTask } = await import("../../src/persistence/tasks");

      await setupPersistence();

      const testTask = createTestTask({
        id: "pending-prompt-mode-task",
        name: "pending-prompt-mode-task",
      });
      testTask.state.pendingPrompt = "Answer directly";
      testTask.state.pendingPromptMode = "plain_chat";

      await saveTask(testTask);
      const loaded = await loadTask("pending-prompt-mode-task");

      expect(loaded).not.toBeNull();
      expect(loaded!.state.pendingPrompt).toBe("Answer directly");
      expect(loaded!.state.pendingPromptMode).toBe("plain_chat");
    });

    test("loadTask normalizes legacy generic clanky commit scope", async () => {
      const { saveTask, loadTask } = await import("../../src/persistence/tasks");

      await setupPersistence();

      const testTask = createTestTask({
        id: "legacy-scope-task",
        name: "legacy-scope-task",
      });
      testTask.config.git.commitScope = "clanky";

      await saveTask(testTask);
      const loaded = await loadTask("legacy-scope-task");

      expect(loaded).not.toBeNull();
      expect(loaded!.config.git.commitScope).toBe("");
    });

    test("loadTask coerces legacy persisted chat mode to task", async () => {
      const { saveTask, loadTask } = await import("../../src/persistence/tasks");
      const { getDatabase } = await import("../../src/persistence/database");

      await setupPersistence();

      const testTask = createTestTask({
        id: "legacy-mode-task",
        name: "legacy-mode-task",
      });

      await saveTask(testTask);
      getDatabase().run("UPDATE tasks SET mode = 'chat' WHERE id = ?", ["legacy-mode-task"]);

      const loaded = await loadTask("legacy-mode-task");

      expect(loaded).not.toBeNull();
      expect(loaded!.config.mode).toBe("task");
    });

    test("ignores legacy pending plan questions and clears them on save", async () => {
      const { saveTask, loadTask } = await import("../../src/persistence/tasks");
      const { getDatabase } = await import("../../src/persistence/database");

      await setupPersistence();

      const testTask = createTestTask({
        id: "pending-question-task",
        status: "planning",
      });
      testTask.config.planMode = true;
      testTask.state.planMode = {
        active: true,
        feedbackRounds: 0,
        planningFolderCleared: false,
        isPlanReady: false,
      };

      await saveTask(testTask);
      getDatabase().run(
        "UPDATE tasks SET pending_plan_question = ? WHERE id = ?",
        [
          JSON.stringify({
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
          }),
          "pending-question-task",
        ],
      );
      const loaded = await loadTask("pending-question-task");

      expect(loaded?.state.planMode).toBeDefined();
      expect("pendingQuestion" in (loaded?.state.planMode ?? {})).toBe(false);

      await saveTask(loaded!);
      const row = getDatabase()
        .query("SELECT pending_plan_question FROM tasks WHERE id = ?")
        .get("pending-question-task") as Record<string, unknown>;
      expect(row["pending_plan_question"]).toBeNull();
    });

    test("persists auto-accept plan setting", async () => {
      const { saveTask, loadTask } = await import("../../src/persistence/tasks");

      await setupPersistence();

      const testTask = createTestTask({
        id: "auto-accept-task",
      });
      testTask.config.planMode = true;
      testTask.config.autoAcceptPlan = true;

      await saveTask(testTask);
      const loaded = await loadTask("auto-accept-task");

      expect(loaded?.config.autoAcceptPlan).toBe(true);
    });

    test("persists cheap helper model selection", async () => {
      const { saveTask, loadTask } = await import("../../src/persistence/tasks");

      await setupPersistence();

      const testTask = createTestTask({
        id: "cheap-model-task",
      });
      testTask.config.cheapModel = {
        mode: "custom",
        model: {
          providerID: "openai",
          modelID: "gpt-4o-mini",
          variant: "fast",
        },
      };

      await saveTask(testTask);
      const loaded = await loadTask("cheap-model-task");

      expect(loaded?.config.cheapModel).toEqual(testTask.config.cheapModel);
    });

    test("persists pull request monitoring state", async () => {
      const { saveTask, loadTask } = await import("../../src/persistence/tasks");

      await setupPersistence();

      const testTask = createTestTask({
        id: "pr-monitor-task",
        status: "pushed",
      });
      testTask.state.git = {
        originalBranch: "main",
        workingBranch: "feature/pr-monitor-task",
        commits: [],
      };
      testTask.state.reviewMode = {
        addressable: true,
        completionAction: "push",
        reviewCycles: 0,
      };
      testTask.state.pullRequestMonitoring = {
        status: "open",
        lastCheckedAt: "2026-04-11T04:00:00.000Z",
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/owner/repo/pull/42",
      };

      await saveTask(testTask);
      const loaded = await loadTask("pr-monitor-task");

      expect(loaded?.state.pullRequestMonitoring).toEqual(testTask.state.pullRequestMonitoring);
    });

    test("persists automatic PR flow state", async () => {
      const { saveTask, loadTask } = await import("../../src/persistence/tasks");

      await setupPersistence();

      const testTask = createTestTask({
        id: "automatic-pr-flow-task",
        status: "pushed",
      });
      testTask.state.git = {
        originalBranch: "main",
        workingBranch: "feature/automatic-pr-flow-task",
        commits: [],
      };
      testTask.state.reviewMode = {
        addressable: true,
        completionAction: "push",
        reviewCycles: 0,
      };
      testTask.state.automaticPrFlow = {
        enabled: true,
        status: "processing_feedback",
        startedAt: "2026-04-11T04:00:00.000Z",
        updatedAt: "2026-04-11T04:10:00.000Z",
        lastCheckedAt: "2026-04-11T04:05:00.000Z",
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/owner/repo/pull/42",
        activeBatch: {
          batchId: "batch-1",
          itemIds: ["thread-1", "review-2"],
          items: [
            { id: "thread-1", source: "review_thread", threadId: "thread-1" },
            { id: "review-2", source: "review" },
          ],
          startedAt: "2026-04-11T04:06:00.000Z",
          reviewCycle: 1,
        },
        handledItems: [
          {
            id: "comment-1",
            source: "review_comment",
            outcome: "ignored",
            handledAt: "2026-04-11T04:04:00.000Z",
          },
        ],
      };

      await saveTask(testTask);
      const loaded = await loadTask("automatic-pr-flow-task");

      expect(loaded?.state.automaticPrFlow).toEqual(testTask.state.automaticPrFlow);
    });

    test("ignores undefined automatic PR flow values from legacy or partial rows", async () => {
      const { taskToRow, rowToTask } = await import("../../src/persistence/tasks/helpers");

      const testTask = createTestTask({
        id: "legacy-auto-pr-flow-row",
        status: "pushed",
      });
      testTask.state.automaticPrFlow = {
        enabled: true,
        status: "monitoring",
        startedAt: "2026-04-11T04:00:00.000Z",
        updatedAt: "2026-04-11T04:00:00.000Z",
        handledItems: [],
      };

      const row = taskToRow(testTask);
      row["automatic_pr_flow"] = undefined;

      const loaded = rowToTask(row);

      expect(loaded.state.automaticPrFlow).toBeUndefined();
    });

    test("ignores undefined pull request monitoring values from legacy or partial rows", async () => {
      const { taskToRow, rowToTask } = await import("../../src/persistence/tasks/helpers");

      const testTask = createTestTask({
        id: "legacy-pr-monitor-row",
        status: "pushed",
      });
      testTask.state.pullRequestMonitoring = {
        status: "open",
        lastCheckedAt: "2026-04-11T04:00:00.000Z",
      };

      const row = taskToRow(testTask);
      row["pull_request_monitoring"] = undefined;

      const loaded = rowToTask(row);

      expect(loaded.state.pullRequestMonitoring).toBeUndefined();
    });

    test("loadTask returns null for non-existent task", async () => {
      const { loadTask } = await import("../../src/persistence/tasks");

      await setupPersistence();

      const loaded = await loadTask("non-existent");
      expect(loaded).toBeNull();
    });

    test("deleteTask removes the task", async () => {
      const { saveTask, loadTask, deleteTask } = await import("../../src/persistence/tasks");

      await setupPersistence();

      const testTask = createTestTask({ id: "delete-me" });

      await saveTask(testTask);
      expect(await loadTask("delete-me")).not.toBeNull();

      const deleted = await deleteTask("delete-me");
      expect(deleted).toBe(true);
      expect(await loadTask("delete-me")).toBeNull();
    });

    test("listTasks returns all tasks", async () => {
      const { saveTask, listTasks } = await import("../../src/persistence/tasks");

      await setupPersistence();

      // Save two tasks
      const task1 = createTestTask({
        id: "task-1",
        directory: "/tmp/1",
        prompt: "Test 1",
        createdAt: "2024-01-01T00:00:00Z",
      });

      const task2 = createTestTask({
        id: "task-2",
        directory: "/tmp/2",
        prompt: "Test 2",
        status: "running",
        currentIteration: 3,
        createdAt: "2024-01-02T00:00:00Z",
      });

      await saveTask(task1);
      await saveTask(task2);

      const tasks = await listTasks();
      expect(tasks.length).toBe(2);

      // Should be sorted by createdAt, newest first
      expect(tasks[0]!.config.id).toBe("task-2");
      expect(tasks[1]!.config.id).toBe("task-1");
    });

    describe("getActiveTaskByDirectory", () => {
      test("returns null when no tasks exist for directory", async () => {
        const { getActiveTaskByDirectory } = await import("../../src/persistence/tasks");

        await setupPersistence();

        const result = await getActiveTaskByDirectory("/tmp/test", "test-workspace-id");
        expect(result).toBeNull();
      });

      test("returns null when only draft tasks exist for directory", async () => {
        const { saveTask, getActiveTaskByDirectory } = await import("../../src/persistence/tasks");

        await setupPersistence();

        const draftTask = createTestTask({ id: "draft-task", status: "draft" });
        await saveTask(draftTask);

        const result = await getActiveTaskByDirectory("/tmp/test", "test-workspace-id");
        expect(result).toBeNull();
      });

      test("returns null when only terminal state tasks exist for directory", async () => {
        const { saveTask, getActiveTaskByDirectory } = await import("../../src/persistence/tasks");

        await setupPersistence();

        const terminalStatuses: TaskStatus[] = ["completed", "stopped", "failed", "max_iterations", "merged", "pushed", "deleted"];

        for (let i = 0; i < terminalStatuses.length; i++) {
          const task = createTestTask({
            id: `terminal-task-${i}`,
            status: terminalStatuses[i],
          });
          await saveTask(task);
        }

        const result = await getActiveTaskByDirectory("/tmp/test", "test-workspace-id");
        expect(result).toBeNull();
      });

      test("returns the active task when one exists", async () => {
        const { saveTask, getActiveTaskByDirectory, deleteTask } = await import("../../src/persistence/tasks");

        await setupPersistence();

        const activeStatuses: TaskStatus[] = ["idle", "planning", "starting", "running", "waiting"];

        for (const status of activeStatuses) {
          const testTask = createTestTask({
            id: `active-task-${status}`,
            directory: `/tmp/active-test-${status}`,
            status,
          });

          await saveTask(testTask);

          const result = await getActiveTaskByDirectory(`/tmp/active-test-${status}`, "test-workspace-id");
          expect(result).not.toBeNull();
          expect(result!.config.id).toBe(`active-task-${status}`);
          expect(result!.state.status).toBe(status);

          // Clean up
          await deleteTask(testTask.config.id);
        }
      });

      test("does not return tasks from different directories", async () => {
        const { saveTask, getActiveTaskByDirectory } = await import("../../src/persistence/tasks");

        await setupPersistence();

        // Save a running task in a different directory
        const otherDirTask = createTestTask({
          id: "other-dir-task",
          directory: "/tmp/other-dir",
          status: "running",
        });

        await saveTask(otherDirTask);

        // Query for a different directory
        const result = await getActiveTaskByDirectory("/tmp/my-dir", "test-workspace-id");
        expect(result).toBeNull();
      });

      test("does not return tasks from different workspaces with the same directory", async () => {
        const { saveTask, getActiveTaskByDirectory } = await import("../../src/persistence/tasks");
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

        // Save a running task in the other workspace's directory
        const otherWsTask = createTestTask({
          id: "other-ws-task",
          directory: "/tmp/test",
          status: "running",
        });
        // Override workspaceId to point to the other workspace
        otherWsTask.config.workspaceId = otherWorkspaceId;
        await saveTask(otherWsTask);

        // Query should NOT find it when looking for test-workspace-id
        const result = await getActiveTaskByDirectory("/tmp/test", "test-workspace-id");
        expect(result).toBeNull();

        // But SHOULD find it when looking for other-workspace-id
        const otherResult = await getActiveTaskByDirectory("/tmp/test", otherWorkspaceId);
        expect(otherResult).not.toBeNull();
        expect(otherResult!.config.id).toBe("other-ws-task");
      });

      test("returns the active task even when other tasks exist for same directory", async () => {
        const { saveTask, getActiveTaskByDirectory } = await import("../../src/persistence/tasks");

        await setupPersistence();

        // Save a draft task
        const draftTask = createTestTask({
          id: "draft-task",
          directory: "/tmp/multi-test",
          status: "draft",
        });
        await saveTask(draftTask);

        // Save a completed task
        const completedTask = createTestTask({
          id: "completed-task",
          directory: "/tmp/multi-test",
          status: "completed",
          currentIteration: 5,
        });
        await saveTask(completedTask);

        // Save a running task
        const runningTask = createTestTask({
          id: "running-task",
          directory: "/tmp/multi-test",
          status: "running",
          currentIteration: 2,
        });
        await saveTask(runningTask);

        const result = await getActiveTaskByDirectory("/tmp/multi-test", "test-workspace-id");
        expect(result).not.toBeNull();
        expect(result!.config.id).toBe("running-task");
        expect(result!.state.status).toBe("running");
      });
    });

    describe("resetStaleTasks", () => {
      test("resetStaleTask resets a single stale task without touching planning tasks", async () => {
        const { saveTask, loadTask, resetStaleTask } = await import("../../src/persistence/tasks");

        await setupPersistence();

        const runningTask = createTestTask({
          id: "single-running-task",
          directory: "/tmp/test-single-running",
          status: "running",
        });
        await saveTask(runningTask);

        const planningTask = createTestTask({
          id: "single-planning-task",
          directory: "/tmp/test-single-planning",
          status: "planning",
        });
        await saveTask(planningTask);

        const runningReset = await resetStaleTask("single-running-task");
        const planningReset = await resetStaleTask("single-planning-task");

        expect(runningReset).toBe(true);
        expect(planningReset).toBe(false);

        const loadedRunning = await loadTask("single-running-task");
        expect(loadedRunning).not.toBeNull();
        expect(loadedRunning!.state.status).toBe("stopped");
        expect(loadedRunning!.state.error?.message).toBe("Forcefully stopped by connection reset");
        expect(loadedRunning!.state.error?.iteration).toBe(0);

        const loadedPlanning = await loadTask("single-planning-task");
        expect(loadedPlanning).not.toBeNull();
        expect(loadedPlanning!.state.status).toBe("planning");
      });

      test("resets idle tasks to stopped", async () => {
        const { saveTask, loadTask, resetStaleTasks } = await import("../../src/persistence/tasks");

        await setupPersistence();

        const idleTask = createTestTask({
          id: "idle-task",
          status: "idle",
        });
        await saveTask(idleTask);

        const resetCount = await resetStaleTasks();
        expect(resetCount).toBe(1);

        const loaded = await loadTask("idle-task");
        expect(loaded).not.toBeNull();
        expect(loaded!.state.status).toBe("stopped");
        expect(loaded!.state.error?.message).toBe("Forcefully stopped by connection reset");
        expect(loaded!.state.error?.iteration).toBe(0);
      });

      test("resets running and waiting tasks to stopped", async () => {
        const { saveTask, loadTask, resetStaleTasks } = await import("../../src/persistence/tasks");

        await setupPersistence();

        const runningTask = createTestTask({
          id: "running-task",
          directory: "/tmp/test-running",
          status: "running",
        });
        await saveTask(runningTask);

        const waitingTask = createTestTask({
          id: "waiting-task",
          directory: "/tmp/test-waiting",
          status: "waiting",
        });
        await saveTask(waitingTask);

        const startingTask = createTestTask({
          id: "starting-task",
          directory: "/tmp/test-starting",
          status: "starting",
        });
        await saveTask(startingTask);

        const resetCount = await resetStaleTasks();
        expect(resetCount).toBe(3);

        const loadedRunning = await loadTask("running-task");
        expect(loadedRunning!.state.status).toBe("stopped");
        expect(loadedRunning!.state.error?.iteration).toBe(0);

        const loadedWaiting = await loadTask("waiting-task");
        expect(loadedWaiting!.state.status).toBe("stopped");
        expect(loadedWaiting!.state.error?.iteration).toBe(0);

        const loadedStarting = await loadTask("starting-task");
        expect(loadedStarting!.state.status).toBe("stopped");
        expect(loadedStarting!.state.error?.iteration).toBe(0);
      });

      test("does NOT reset planning tasks", async () => {
        const { saveTask, loadTask, resetStaleTasks } = await import("../../src/persistence/tasks");

        await setupPersistence();

        const planningTask = createTestTask({
          id: "planning-task",
          status: "planning",
        });
        await saveTask(planningTask);

        const resetCount = await resetStaleTasks();
        expect(resetCount).toBe(0);

        const loaded = await loadTask("planning-task");
        expect(loaded).not.toBeNull();
        expect(loaded!.state.status).toBe("planning");
      });

      test("does NOT reset terminal state tasks", async () => {
        const { saveTask, loadTask, resetStaleTasks } = await import("../../src/persistence/tasks");

        await setupPersistence();

        const completedTask = createTestTask({
          id: "completed-task",
          directory: "/tmp/test-completed",
          status: "completed",
        });
        await saveTask(completedTask);

        const stoppedTask = createTestTask({
          id: "stopped-task",
          directory: "/tmp/test-stopped",
          status: "stopped",
        });
        await saveTask(stoppedTask);

        const failedTask = createTestTask({
          id: "failed-task",
          directory: "/tmp/test-failed",
          status: "failed",
        });
        await saveTask(failedTask);

        const resetCount = await resetStaleTasks();
        expect(resetCount).toBe(0);

        const loadedCompleted = await loadTask("completed-task");
        expect(loadedCompleted!.state.status).toBe("completed");

        const loadedStopped = await loadTask("stopped-task");
        expect(loadedStopped!.state.status).toBe("stopped");

        const loadedFailed = await loadTask("failed-task");
        expect(loadedFailed!.state.status).toBe("failed");
      });

      test("returns 0 when no stale tasks exist", async () => {
        const { resetStaleTasks } = await import("../../src/persistence/tasks");

        await setupPersistence();

        const resetCount = await resetStaleTasks();
        expect(resetCount).toBe(0);
      });
    });
  });
});
