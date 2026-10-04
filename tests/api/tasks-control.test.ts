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
import type { TaskTranscriptSnapshot } from "../../src/core/task-transcript-service";
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
import { fetchTestLocalExecutionHost } from "../setup";
import { LifetimeHarnessBackend } from "../mocks/lifetime-harness-backend";
import { defaultTestModel } from "../mocks/mock-backend";
import { HarnessError } from "../../src/backends/harness-errors";
import type { Task, HarnessActivity, MessageAttachment } from "@/shared";

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
  autoAcceptPlan: true,
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
    const executionHost = await fetchTestLocalExecutionHost(baseUrl);
    // Try to create a workspace for this directory
    const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name || directory.split("/").pop() || "Test",
        directory,
        executionHost,
        serverSettings: { agent: { adapter: "acp", provider: "opencode" } },
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
    mockBackend = createMockBackend([
      "<promise>PLAN_READY</promise>",
      "<promise>COMPLETE</promise>",
    ]);
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting((directory) => new TestCommandExecutor(directory));

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
    mockBackend = createMockBackend([
      "<promise>PLAN_READY</promise>",
      "<promise>COMPLETE</promise>",
    ]);
    backendManager.setBackendForTesting(mockBackend);
    backendManager.setExecutorFactoryForTesting((directory) => new TestCommandExecutor(directory));
    
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

  async function createNativeExecution(name: string): Promise<Task> {
    const directory = await createTrackedTempDir("clanky-native-completion-");
    await initializeGitRepository(directory, { initialCommit: "readme" });
    const workspaceId = await getOrCreateWorkspace(directory, "Native completion workspace");
    const baseBranch = await getCurrentBranch(directory);
    const create = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseCreateTaskPayload, workspaceId, baseBranch, name,
        prompt: "Synthetic native task", model: testModel, useWorktree: true,
        uploadedPlan: { planContent: "# Synthetic plan\n\nComplete the synthetic task." },
      }),
    });
    expect(create.status).toBe(201);
    const taskId = (await create.json() as Task).config.id;
    return pollUntil(
      async () => await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task,
      (task) => task.state.status === "running"
        && Boolean(task.state.session?.binding)
        && task.state.harness?.capabilities?.adapter === "copilot"
        && task.state.harness.activity?.observation === "available",
      { description: "native task with usable capabilities and session-lived observation", timeoutMs: 5000, formatLastObserved: (task) => JSON.stringify(task.state) },
    );
  }

  async function waitForNativePrincipalMessages(taskId: string, count: number): Promise<TaskTranscriptSnapshot> {
    return pollUntil(
      async () => await (await fetch(`${baseUrl}/api/tasks/${taskId}/snapshot?full=1`)).json() as TaskTranscriptSnapshot,
      (snapshot) => snapshot.transcript.messages.filter((message) => message.role === "assistant").length >= count,
      { description: "native principal execution acknowledgement", timeoutMs: 5000, formatLastObserved: (snapshot) => JSON.stringify(snapshot) },
    );
  }

  test("seals principal COMPLETE before native terminal and cleans up owned background work", async () => {
    const releaseNativePrompt = Promise.withResolvers<void>();
    const native = new LifetimeHarnessBackend({
      models: [defaultTestModel], responses: ["chore: preserve native result"],
      streamEventSequences: [[{ type: "message.complete", content: "Late native result" }]],
      onStreamEvent: async () => { await releaseNativePrompt.promise; },
    });
    backendManager.setBackendForTesting(native);
    backendManager.setExecutorFactoryForTesting((directory) => new TestCommandExecutor(directory));
    let taskId: string | undefined;
    try {
      const running = await createNativeExecution("Native completion");
      taskId = running.config.id;
      const sessionId = running.state.session!.id;
      const child: HarnessActivity = {
        id: "owned-child", description: "Native child", kind: "subagent", status: "running",
        ownership: "owned", workspaceWrites: "possible", native: { adapter: "copilot", conversationId: sessionId, activityId: "owned-child" },
      };
      native.publishActivities(sessionId, [child, { ...child, id: "owned-sibling", description: "Native sibling", native: { ...child.native, activityId: "owned-sibling" } }]);
      native.publishEvent(sessionId, { type: "message.complete", content: "<promise>COMPLETE</promise>", scope: { kind: "child", activityId: child.id } });
      native.publishEvent(sessionId, { type: "message.start", messageId: "principal-interim", scope: { kind: "principal" } });
      native.publishEvent(sessionId, { type: "message.complete", content: "Still working", scope: { kind: "principal" } });
      const interim = await pollUntil(
        async () => await (await fetch(`${baseUrl}/api/tasks/${taskId}/snapshot?full=1`)).json() as TaskTranscriptSnapshot,
        (snapshot) => snapshot.transcript.messages.some((message) => message.content === "Still working"),
        { description: "principal activity after child completion", timeoutMs: 5000, formatLastObserved: (snapshot) => JSON.stringify(snapshot) },
      );
      expect(interim.task.state.status).toBe("running");
      const stopped = await fetch(`${baseUrl}/api/tasks/${taskId}/activity/${child.id}/stop`, { method: "POST" });
      expect(stopped.status).toBe(200);
      const afterStop = await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task;
      const observed = afterStop.state.harness?.activity;
      expect(observed?.observation).toBe("available");
      if (observed?.observation !== "available") throw new Error("Expected task activity.");
      expect(observed.activities.map((entry) => [entry.id, entry.status])).toEqual([["owned-child", "stopped"], ["owned-sibling", "running"]]);
      native.publishEvent(sessionId, { type: "message.start", messageId: "principal-complete", scope: { kind: "principal" } });
      native.publishEvent(sessionId, { type: "message.complete", content: "<promise>COMPLETE</promise>", scope: { kind: "principal" } });
      const completed = await pollUntil(
        async () => await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task,
        (task) => task.state.status === "completed" && task.state.harness?.cleanup?.status === "settled",
        { description: "principal completion without native terminal and owned cleanup", timeoutMs: 5000, formatLastObserved: (task) => JSON.stringify(task.state) },
      );
      expect(completed.state.currentIteration).toBe(1);
      releaseNativePrompt.resolve();
      await pollUntil(
        async () => await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task,
        (task) => task.state.harness?.gitOutcome?.status === "succeeded",
        { description: "native workspace finalization", timeoutMs: 5000, formatLastObserved: (task) => JSON.stringify(task.state.harness) },
      );
      await taskManager.shutdown();
      const persisted = await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task;
      expect(persisted.state.status).toBe("completed");
    } finally {
      releaseNativePrompt.resolve();
      if (taskId) await fetch(`${baseUrl}/api/tasks/${taskId}/stop`, { method: "POST" });
      await native.disconnect();
    }
  });

  test("blocks Git acceptance until native writers settle and retries final Git without rerunning the task", async () => {
    const release = Promise.withResolvers<void>();
    const native = new LifetimeHarnessBackend({
      models: [defaultTestModel], responses: ["chore: preserve native output"],
      streamEventSequences: [[{ type: "message.complete", content: "Late native result" }]],
      onStreamEvent: async () => { await release.promise; },
    });
    backendManager.setBackendForTesting(native);
    backendManager.setExecutorFactoryForTesting((directory) => new TestCommandExecutor(directory));
    let taskId: string | undefined;
    try {
      const running = await createNativeExecution("Native unsettled writers");
      taskId = running.config.id;
      const sessionId = running.state.session!.id;
      const worktreePath = running.state.git!.worktreePath!;
      const originalHead = (await runGit(worktreePath, ["rev-parse", "HEAD"])).stdout;
      await writeFile(join(worktreePath, "native-output.txt"), "Synthetic native output\n");
      native.publishActivities(sessionId, [{
        id: "unsettled-writer", description: "Unsettled native writer", kind: "subagent",
        ownership: "owned", workspaceWrites: "unknown", status: "unknown",
        native: { adapter: "copilot", conversationId: sessionId, activityId: "unsettled-writer" },
      }]);
      native.publishEvent(sessionId, { type: "message.start", messageId: "principal-complete", scope: { kind: "principal" } });
      native.publishEvent(sessionId, { type: "message.complete", content: "<promise>COMPLETE</promise>", scope: { kind: "principal" } });
      await pollUntil(
        async () => await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task,
        (task) => task.state.status === "completed" && task.state.harness?.cleanup?.status === "pending",
        { description: "completed task with unresolved native writer", timeoutMs: 5000, formatLastObserved: (task) => JSON.stringify(task.state) },
      );
      release.resolve();
      for (const operation of ["accept", "push"]) {
        const blocked = await fetch(`${baseUrl}/api/tasks/${taskId}/${operation}`, { method: "POST" });
        expect(blocked.status).toBe(409);
        expect((await blocked.json()).error).toBe("task_background_work_unsettled");
      }
      expect((await runGit(worktreePath, ["rev-parse", "HEAD"])).stdout).toBe(originalHead);
      const stop = await fetch(`${baseUrl}/api/tasks/${taskId}/activity/unsettled-writer/stop`, { method: "POST" });
      expect(stop.status).toBe(200);
      const accepted = await fetch(`${baseUrl}/api/tasks/${taskId}/accept`, { method: "POST" });
      expect(accepted.status).toBe(200);
      const settled = await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task;
      expect(settled.state.status).toBe("accepted_local");
      expect(settled.state.currentIteration).toBe(1);
      expect(settled.state.harness?.cleanup?.status).toBe("settled");
      expect(settled.state.harness?.gitOutcome?.status).toBe("succeeded");
      expect((await runGit(worktreePath, ["show", "HEAD:native-output.txt"])).stdout).toBe("Synthetic native output\n");
    } finally {
      release.resolve();
      await taskManager.shutdown();
      if (taskId) await fetch(`${baseUrl}/api/tasks/${taskId}`, { method: "DELETE" });
      await native.disconnect();
    }
  });

  test("preserves final Git failure through shutdown and recovers the owned session without another task iteration", async () => {
    const release = Promise.withResolvers<void>();
    const native = new LifetimeHarnessBackend({
      models: [defaultTestModel], responses: ["chore: preserve native output"],
      streamEventSequences: [[{ type: "message.complete", content: "Late native result" }]],
      onStreamEvent: async () => { await release.promise; },
    });
    backendManager.setBackendForTesting(native);
    backendManager.setExecutorFactoryForTesting((directory) => new TestCommandExecutor(directory));
    let taskId: string | undefined;
    try {
      const running = await createNativeExecution("Native final Git failure");
      taskId = running.config.id;
      const sessionId = running.state.session!.id;
      const worktreePath = running.state.git!.worktreePath!;
      const hookPath = join(running.config.directory, ".git", "hooks", "pre-commit");
      const originalHead = (await runGit(worktreePath, ["rev-parse", "HEAD"])).stdout;
      await writeFile(join(worktreePath, "native-output.txt"), "Synthetic native output\n");
      await writeFile(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      native.publishEvent(sessionId, { type: "message.start", messageId: "principal-complete", scope: { kind: "principal" } });
      native.publishEvent(sessionId, { type: "message.complete", content: "<promise>COMPLETE</promise>", scope: { kind: "principal" } });
      release.resolve();
      await pollUntil(
        async () => await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task,
        (task) => task.state.status === "completed" && task.state.harness?.gitOutcome?.status === "failed",
        { description: "logical completion with an actual failed Git hook", timeoutMs: 5000, formatLastObserved: (task) => JSON.stringify(task.state) },
      );
      await taskManager.shutdown();
      const persisted = await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task;
      expect(persisted.state.status).toBe("completed");
      expect(persisted.state.harness?.cleanup?.status).toBe("settled");
      expect(persisted.state.harness?.gitOutcome?.status).toBe("failed");
      const blocked = await fetch(`${baseUrl}/api/tasks/${taskId}/accept`, { method: "POST" });
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).error).toBe("task_final_git_failed");
      expect((await runGit(worktreePath, ["rev-parse", "HEAD"])).stdout).toBe(originalHead);
      await rm(hookPath);
      const accepted = await fetch(`${baseUrl}/api/tasks/${taskId}/accept`, { method: "POST" });
      expect(accepted.status).toBe(200);
      const recovered = await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task;
      expect(recovered.state.status).toBe("accepted_local");
      expect(recovered.state.currentIteration).toBe(1);
      expect(recovered.state.session?.id).toBe(sessionId);
      expect(recovered.state.harness?.gitOutcome?.status).toBe("succeeded");
      expect((await runGit(worktreePath, ["show", "HEAD:native-output.txt"])).stdout).toBe("Synthetic native output\n");
    } finally {
      release.resolve();
      await taskManager.shutdown();
      if (taskId) await fetch(`${baseUrl}/api/tasks/${taskId}`, { method: "DELETE" });
      await native.disconnect();
    }
  });

  test("keeps deterministically rejected task steering editable without losing its pending input", async () => {
    const release = Promise.withResolvers<void>();
    const native = new LifetimeHarnessBackend({
      models: [defaultTestModel], inputAdmission: "accepted",
      streamEventSequences: [[{ type: "message.complete", content: "Principal active" }]],
      onStreamEvent: async () => { await release.promise; },
    });
    // The genuine adapter's typed pre-RPC failure is covered by native-bootstrap.
    // Here the public task boundary protects durable claim rollback and editing.
    native.harness.steer = async () => {
      throw new HarnessError("harness_unsupported_feature", "Unsupported inline attachment.");
    };
    backendManager.setBackendForTesting(native);
    backendManager.setExecutorFactoryForTesting((directory) => new TestCommandExecutor(directory));
    let taskId: string | undefined;
    try {
      const running = await createNativeExecution("Rejected task input");
      taskId = running.config.id;
      const pending = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-prompt`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Unsupported input", attachments: [] }),
      });
      expect(pending.status).toBe(200);
      const before = await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task;
      const inputId = before.state.pendingInput!.id;
      const rejected = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-inputs/${inputId}/steer`, { method: "POST" });
      expect(rejected.status).toBe(409);
      expect((await rejected.json()).error).toBe("harness_unsupported_feature");
      const after = await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task;
      expect(after.state.status).toBe("running");
      expect(after.state.pendingInput?.id).toBe(inputId);
      expect(after.state.harness?.inputs?.find((entry) => entry.admission.inputId === inputId)?.admission).toEqual({
        status: "rejected", inputId, code: "unsupported",
      });
      const replacement = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-prompt`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Corrected input", attachments: [] }),
      });
      expect(replacement.status).toBe(200);
      const updated = await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task;
      expect(updated.state.pendingPrompt).toBe("Corrected input");
      expect(updated.state.pendingInput?.id).not.toBe(inputId);
    } finally {
      release.resolve();
      await taskManager.shutdown();
      if (taskId) await fetch(`${baseUrl}/api/tasks/${taskId}`, { method: "DELETE" });
      await native.disconnect();
    }
  });

  test("keeps unknown task steering through ordinary continuation and recovers content and attachments after shutdown", async () => {
    const release = Promise.withResolvers<void>();
    const native = new LifetimeHarnessBackend({
      models: [defaultTestModel], inputAdmission: "unknown", acknowledgePrompts: true,
      responses: ["chore: preserve task input"],
      streamEventSequences: [[{ type: "message.complete", content: "Late native result" }]],
      onStreamEvent: async () => { await release.promise; },
    });
    backendManager.setBackendForTesting(native);
    backendManager.setExecutorFactoryForTesting((directory) => new TestCommandExecutor(directory));
    let taskId: string | undefined;
    try {
      const running = await createNativeExecution("Native unknown input");
      taskId = running.config.id;
      const sessionId = running.state.session!.id;
      await waitForNativePrincipalMessages(taskId, 1);
      const attachment: MessageAttachment = {
        id: crypto.randomUUID(), filename: "context.txt", mimeType: "text/plain",
        data: Buffer.from("Synthetic context").toString("base64"), size: Buffer.byteLength("Synthetic context"),
      };
      const queued = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-prompt`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Steer this task", attachments: [attachment] }),
      });
      expect(queued.status).toBe(200);
      const pending = await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task;
      const inputId = pending.state.pendingInput!.id;
      expect(pending.state.pendingInput?.attachments).toEqual([attachment]);
      const steerUrl = `${baseUrl}/api/tasks/${taskId}/pending-inputs/${inputId}/steer`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const admission = await fetch(steerUrl, { method: "POST" });
        expect(admission.status).toBe(200);
        expect((await admission.json()).admission.status).toBe("unknown");
      }
      const remove = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-prompt`, { method: "DELETE" });
      expect(remove.status).toBe(409);
      expect((await remove.json()).error).toBe("task_input_unresolved");
      const replace = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-prompt`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Do not replace an uncertain input", attachments: [] }),
      });
      expect(replace.status).toBe(409);
      native.publishEvent(sessionId, { type: "prompt.complete", outcome: "completed", scope: { kind: "principal" } });
      const continued = await waitForNativePrincipalMessages(taskId, 2);
      expect(continued.task.state.pendingInput?.id).toBe(inputId);
      expect(continued.transcript.messages.filter((message) => message.role === "user" && message.content === "Steer this task")).toHaveLength(0);
      release.resolve();
      await taskManager.shutdown();
      const stopped = await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task;
      expect(stopped.state.pendingInput).toEqual({ id: inputId, attachments: [attachment] });
      expect(stopped.state.harness?.inputs?.find((entry) => entry.admission.inputId === inputId)?.admission.status).toBe("unknown");
      const recovered = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-inputs/${inputId}/reconcile`, { method: "POST" });
      expect(recovered.status).toBe(200);
      expect((await recovered.json()).admission.status).toBe("delivered");
      const snapshot = await (await fetch(`${baseUrl}/api/tasks/${taskId}/snapshot?full=1`)).json() as TaskTranscriptSnapshot;
      expect(snapshot.task.state.session?.id).toBe(sessionId);
      expect(snapshot.task.state.currentIteration).toBe(stopped.state.currentIteration);
      expect(snapshot.task.state.pendingInput).toBeUndefined();
      const messages = snapshot.transcript.messages.filter((message) => message.role === "user" && message.content === "Steer this task");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe(inputId);
      expect(messages[0]?.attachments).toEqual([attachment]);
    } finally {
      release.resolve();
      await taskManager.shutdown();
      if (taskId) await fetch(`${baseUrl}/api/tasks/${taskId}`, { method: "DELETE" });
      await native.disconnect();
    }
  });

  test("atomically records accepted task steering once and retains its delivery receipt", async () => {
    const release = Promise.withResolvers<void>();
    const native = new LifetimeHarnessBackend({
      models: [defaultTestModel], inputAdmission: "accepted", acknowledgePrompts: true,
      responses: ["chore: preserve task input"],
      streamEventSequences: [[{ type: "message.complete", content: "Late native result" }]],
      onStreamEvent: async () => { await release.promise; },
    });
    backendManager.setBackendForTesting(native);
    backendManager.setExecutorFactoryForTesting((directory) => new TestCommandExecutor(directory));
    let taskId: string | undefined;
    try {
      const running = await createNativeExecution("Native accepted input");
      taskId = running.config.id;
      await waitForNativePrincipalMessages(taskId, 1);
      const queued = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-prompt`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Accepted native input", attachments: [] }),
      });
      expect(queued.status).toBe(200);
      const pending = await (await fetch(`${baseUrl}/api/tasks/${taskId}`)).json() as Task;
      const inputId = pending.state.pendingInput!.id;
      for (let attempt = 0; attempt < 2; attempt++) {
        const admission = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-inputs/${inputId}/steer`, { method: "POST" });
        expect(admission.status).toBe(200);
        expect((await admission.json()).admission.status).toBe("accepted");
      }
      let snapshot = await (await fetch(`${baseUrl}/api/tasks/${taskId}/snapshot?full=1`)).json() as TaskTranscriptSnapshot;
      expect(snapshot.task.state.pendingInput).toBeUndefined();
      const admittedMessages = snapshot.transcript.messages.filter((message) => message.role === "user" && message.content === "Accepted native input");
      expect(admittedMessages).toHaveLength(1);
      expect(admittedMessages[0]?.id).toBe(inputId);
      const delivered = await fetch(`${baseUrl}/api/tasks/${taskId}/pending-inputs/${inputId}/reconcile`, { method: "POST" });
      expect(delivered.status).toBe(200);
      expect((await delivered.json()).admission.status).toBe("delivered");
      snapshot = await (await fetch(`${baseUrl}/api/tasks/${taskId}/snapshot?full=1`)).json() as TaskTranscriptSnapshot;
      expect(snapshot.task.state.harness?.inputs?.find((entry) => entry.admission.inputId === inputId)?.admission.status).toBe("delivered");
      expect(snapshot.transcript.messages.filter((message) => message.role === "user" && message.content === "Accepted native input")).toHaveLength(1);
    } finally {
      release.resolve();
      await taskManager.shutdown();
      if (taskId) await fetch(`${baseUrl}/api/tasks/${taskId}`, { method: "DELETE" });
      await native.disconnect();
    }
  });

  describe("GET /api/tasks/:id/diff", () => {
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
      await writeFile(join(planTestDir, ".clanky-planning/plan.md"), "This is a test plan.");
      await runGit(planTestDir, ["add", "."]);
      await runGit(planTestDir, ["commit", "-m", "Initial commit"]);
      const planBranch = await getCurrentBranch(planTestDir);

      // Create workspace for this directory
      const workspaceId = await getOrCreateWorkspace(planTestDir);

      // Import a plan so it remains available in the task worktree after startup.
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
          model: testModel,
          useWorktree: true,
          uploadedPlan: { planContent: "This is a test plan." },
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

      await rm(planTestDir, { recursive: true, force: true });
    });

    test("returns plan.md content for branch-only tasks without a worktree", async () => {
      const branchOnlyPlanDir = await createTrackedTempDir("clanky-branch-only-plan-");
      await initializeGitRepository(branchOnlyPlanDir, { initialCommit: "none" });
      await writeFile(join(branchOnlyPlanDir, "README.md"), "# Branch-only plan");
      await mkdir(join(branchOnlyPlanDir, ".clanky-planning"), { recursive: true });
      await writeFile(join(branchOnlyPlanDir, ".clanky-planning/plan.md"), "Plan content.");
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
          model: testModel,
          useWorktree: false,
          uploadedPlan: { planContent: "Plan content." },
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
      await writeFile(join(statusTestDir, ".clanky-planning/status.md"), "In progress.");
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

      await rm(statusTestDir, { recursive: true, force: true });
    });

    test("returns status.md content for branch-only tasks without a worktree", async () => {
      const branchOnlyStatusDir = await createTrackedTempDir("clanky-branch-only-status-");
      await initializeGitRepository(branchOnlyStatusDir, { initialCommit: "none" });
      await writeFile(join(branchOnlyStatusDir, "README.md"), "# Branch-only status");
      await mkdir(join(branchOnlyStatusDir, ".clanky-planning"), { recursive: true });
      await writeFile(join(branchOnlyStatusDir, ".clanky-planning/status.md"), "Status content.");
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

      await rm(branchOnlyStatusDir, { recursive: true, force: true });
    });
  });

  describe("Review Comments API", () => {
    test("POST /api/tasks/:id/address-comments stores and returns comment IDs", async () => {
      // Use unique directory with bare repo to avoid conflicts
      const uniqueWorkDir = await createTrackedGitRepo("clanky-comments-store-test-");
      const uniqueBareRepo = await createTrackedBareRepo("clanky-comments-store-bare-");
      await runGit(uniqueWorkDir, ["remote", "add", "origin", uniqueBareRepo]);
      await runGit(uniqueWorkDir, [
        "push",
        "-u",
        "origin",
        await getCurrentBranch(uniqueWorkDir),
      ]);
      
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

  });
});
