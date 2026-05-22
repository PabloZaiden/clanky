/**
 * Unit tests for TaskEngine and StopPatternDetector.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  TaskEngine,
  StopPatternDetector,
  type TaskBackend,
} from "../../src/core/task-engine";
import { handleModelChange } from "../../src/core/engine/engine-session";
import { SimpleEventEmitter } from "../../src/core/event-emitter";
import type { Task, TaskConfig, TaskState } from "../../src/types/task";
import { DEFAULT_TASK_CONFIG } from "../../src/types/task";
import type { TaskEvent } from "../../src/types/events";
import type {
  AgentSession,
  AgentResponse,
  AgentEvent,
  BackendConnectionConfig,
  CreateSessionOptions,
  PromptInput,
} from "../../src/backends/types";
import { createEventStream, type EventStream } from "../../src/utils/event-stream";
import { GitService } from "../../src/core/git-service";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { backendManager } from "../../src/core/backend-manager";

describe("StopPatternDetector", () => {
  test("matches default stop pattern at end of string", () => {
    const detector = new StopPatternDetector("<promise>COMPLETE</promise>$");

    expect(detector.matches("Some text\n<promise>COMPLETE</promise>")).toBe(true);
    expect(detector.matches("<promise>COMPLETE</promise>")).toBe(true);
    expect(detector.matches("No pattern here")).toBe(false);
    expect(detector.matches("<promise>COMPLETE</promise> more text")).toBe(false);
  });

  test("matches custom patterns", () => {
    const detector = new StopPatternDetector("DONE$");

    expect(detector.matches("Task is DONE")).toBe(true);
    expect(detector.matches("DONE")).toBe(true);
    expect(detector.matches("DONE but more")).toBe(false);
  });

  test("supports regex patterns", () => {
    const detector = new StopPatternDetector("(DONE|COMPLETE)$");

    expect(detector.matches("DONE")).toBe(true);
    expect(detector.matches("COMPLETE")).toBe(true);
    expect(detector.matches("OTHER")).toBe(false);
  });
});

  describe("TaskEngine", () => {
  let testDir: string;
  let mockBackend: TaskBackend;
  let emitter: SimpleEventEmitter<TaskEvent>;
  let emittedEvents: TaskEvent[];
  let gitService: GitService;

  // Create a mock backend that supports async streaming
  // Returns TaskBackend (structural type) to allow easy spreading and overriding
  function createMockBackend(responses: string[]): TaskBackend {
    let responseIndex = 0;
    let connected = false;
    const sessions = new Map<string, AgentSession>();
    let pendingResponse: string | null = null;

    return {
      async connect(_config: BackendConnectionConfig): Promise<void> {
        connected = true;
      },

      async disconnect(): Promise<void> {
        connected = false;
      },

      isConnected(): boolean {
        return connected;
      },

      async createSession(options: CreateSessionOptions): Promise<AgentSession> {
        const session: AgentSession = {
          id: `session-${Date.now()}`,
          title: options.title,
          createdAt: new Date().toISOString(),
        };
        sessions.set(session.id, session);
        return session;
      },

      async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
        const content = responses[responseIndex] ?? "Default response";
        responseIndex++;
        return {
          id: `msg-${Date.now()}`,
          content,
          parts: [{ type: "text", text: content }],
        };
      },

      async sendPromptAsync(_sessionId: string, _prompt: PromptInput): Promise<void> {
        // Store the response for subscribeToEvents to yield
        const content = responses[responseIndex] ?? "Default response";
        responseIndex++;
        pendingResponse = content;
      },

      async abortSession(_sessionId: string): Promise<void> {
        // Mark as aborted
      },

      async subscribeToEvents(_sessionId: string): Promise<EventStream<AgentEvent>> {
        const { stream, push, end } = createEventStream<AgentEvent>();

        // Push events asynchronously AFTER sendPromptAsync sets pendingResponse
        (async () => {
          // Wait for sendPromptAsync to set pendingResponse
          // Poll with small delay to allow sendPromptAsync to be called
          let attempts = 0;
          while (pendingResponse === null && attempts < 100) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            attempts++;
          }

          const content = pendingResponse;
          pendingResponse = null;

          if (content !== null) {
            push({ type: "message.start", messageId: `msg-${Date.now()}` });
            push({ type: "message.delta", content });
            push({ type: "message.complete", content });
          }
          end();
        })();

        return stream;
      },

      async replyToPermission(_requestId: string, _response: string): Promise<void> {
        // No-op for basic mock
      },

      async replyToQuestion(_requestId: string, _answers: string[][]): Promise<void> {
        // No-op for basic mock
      },

      async setConfigOption(_sessionId: string, _configId: string, _value: string) {
        return [];
      },
      async setSessionModel(_sessionId: string, _modelId: string) {},
    };
  }

  function createTestTask(overrides?: Partial<TaskConfig>): Task {
    const config: TaskConfig = {
      id: "test-task-123",
      name: "test-task",
      directory: testDir,
      prompt: "Do something",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceId: "test-workspace-id",
      model: { providerID: "test-provider", modelID: "test-model", variant: "" },
      // Backend is now global, not per-task config
      stopPattern: "<promise>COMPLETE</promise>$",
      git: { branchPrefix: "", commitScope: "" },
      maxIterations: Infinity,
      maxConsecutiveErrors: 10,
      activityTimeoutSeconds: DEFAULT_TASK_CONFIG.activityTimeoutSeconds,
      useWorktree: DEFAULT_TASK_CONFIG.useWorktree,
      clearPlanningFolder: false,
      planMode: false,
      mode: "task",
      ...overrides,
    };

    const state: TaskState = {
      id: config.id,
      status: "idle",
      currentIteration: 0,
      recentIterations: [],
      logs: [],
      messages: [],
      toolCalls: [],
    };

    return { config, state };
  }

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "task-engine-test-"));
    await mkdir(testDir, { recursive: true });
    emittedEvents = [];
    emitter = new SimpleEventEmitter<TaskEvent>();
    emitter.subscribe((event) => emittedEvents.push(event));
    
    // Create git service with test executor
    const executor = new TestCommandExecutor();
    gitService = new GitService(executor);
    
    // Set up backendManager with test executor factory for clearPlanningFolder
    // Also enable test mode so getWorkspaceSettings returns test settings instead of querying the database
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
    backendManager.enableTestMode();
    
    // Initialize git in the test directory (git is always required)
    await Bun.$`git init`.cwd(testDir).quiet();
    await Bun.$`git config user.email "test@test.com"`.cwd(testDir).quiet();
    await Bun.$`git config user.name "Test User"`.cwd(testDir).quiet();
    await writeFile(join(testDir, ".gitkeep"), "");
    await Bun.$`git add .`.cwd(testDir).quiet();
    await Bun.$`git commit -m "Initial commit"`.cwd(testDir).quiet();
  });

  afterEach(async () => {
    backendManager.resetForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  test("initializes with correct state", () => {
    const task = createTestTask();
    mockBackend = createMockBackend([]);

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    expect(engine.state.status).toBe("idle");
    expect(engine.config.id).toBe("test-task-123");
  });

  test("handleModelChange keeps variant-only changes instead of discarding them", async () => {
    const setConfigCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
    const updates: Array<Partial<TaskState>> = [];
    const logs: Array<Record<string, unknown>> = [];
    const config = createTestTask({
      model: { providerID: "copilot", modelID: "gpt-5.4", variant: "" },
    }).config;
    const state = {
      pendingModel: { providerID: "copilot", modelID: "gpt-5.4", variant: "high" },
    } as TaskState;

    await handleModelChange({
      backend: {
        setConfigOption: async (sessionId: string, configId: string, value: string) => {
          setConfigCalls.push({ sessionId, configId, value });
          return [];
        },
        setSessionModel: async () => {},
      } as unknown as TaskBackend,
      config,
      state,
      workingDirectory: testDir,
      emitLog: (_level, message, details) => {
        logs.push({ message, details });
        return "log-id";
      },
      updateState: (update) => {
        updates.push(update);
      },
      getSessionId: () => "session-variant-change",
      setSessionId: () => {},
    });

    expect(config.model).toEqual({
      providerID: "copilot",
      modelID: "gpt-5.4",
      variant: "high",
    });
    expect(setConfigCalls).toEqual([
      {
        sessionId: "session-variant-change",
        configId: "model",
        value: "gpt-5.4",
      },
    ]);
    expect(updates).toEqual([{ pendingModel: undefined }]);
    expect(logs[0]).toMatchObject({
      message: "Model change detected — setting via config option",
    });
  });

  test("uses the repository directory as workingDirectory when worktrees are disabled", () => {
    const task = createTestTask({ useWorktree: false });
    mockBackend = createMockBackend([]);

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    expect(engine.workingDirectory).toBe(testDir);
  });

  test("uses the worktree path as workingDirectory when worktrees are enabled", () => {
    const task = createTestTask();
    const worktreePath = join(testDir, ".clanky-worktrees/test-task");
    task.state.git = {
      originalBranch: "main",
      workingBranch: "test-task-a1b2c3d",
      worktreePath,
      commits: [],
    };
    mockBackend = createMockBackend([]);

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    expect(engine.workingDirectory).toBe(worktreePath);
  });

  test("starts and runs until completion", async () => {
    const task = createTestTask({ maxIterations: 5 });
    mockBackend = createMockBackend([
      "Working on iteration 1...",
      "Working on iteration 2...",
      "Done! <promise>COMPLETE</promise>",
    ]);

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.start();

    expect(engine.state.status).toBe("completed");
    expect(engine.state.currentIteration).toBe(3);

    // Check emitted events
    const startedEvents = emittedEvents.filter((e) => e.type === "task.started");
    const iterationStartEvents = emittedEvents.filter((e) => e.type === "task.iteration.start");
    const completedEvents = emittedEvents.filter((e) => e.type === "task.completed");

    expect(startedEvents.length).toBe(1);
    expect(iterationStartEvents.length).toBe(3);
    expect(completedEvents.length).toBe(1);
  });

  test("emits task.completed even if completion persistence is still pending", async () => {
    const task = createTestTask({ maxIterations: 1 });
    const persistDeferred = createDeferred<void>();
    let persistenceCalls = 0;
    let persistenceResolved = false;

    mockBackend = createMockBackend([
      "Done! <promise>COMPLETE</promise>",
    ]);

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
      onPersistState: async () => {
        persistenceCalls += 1;
        await persistDeferred.promise;
        persistenceResolved = true;
      },
    });

    const startPromise = engine.start();

    const deadline = Date.now() + 5000;
    while (
      Date.now() < deadline
      && !emittedEvents.some((event) => event.type === "task.log"
        && (event as { details?: Record<string, unknown> }).details?.["logKind"] === "response"
        && String((event as { details?: Record<string, unknown> }).details?.["responseContent"] ?? "").includes("<promise>COMPLETE</promise>"))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const completionDeadline = Date.now() + 5000;
    while (
      Date.now() < completionDeadline
      && (!emittedEvents.some((event) => event.type === "task.completed")
        || persistenceCalls === 0)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const responseLogSeen = emittedEvents.some((event) => event.type === "task.log"
      && (event as { details?: Record<string, unknown> }).details?.["logKind"] === "response"
      && String((event as { details?: Record<string, unknown> }).details?.["responseContent"] ?? "").includes("<promise>COMPLETE</promise>"));
    expect(responseLogSeen).toBe(true);
    expect(engine.state.status).toBe("completed");
    expect(emittedEvents.some((event) => event.type === "task.completed")).toBe(true);
    expect(persistenceCalls).toBeGreaterThan(0);
    expect(persistenceResolved).toBe(false);

    persistDeferred.resolve();
    await startPromise;
  });

  test("stops at max iterations", async () => {
    const task = createTestTask({ maxIterations: 2 });
    mockBackend = createMockBackend([
      "Working...",
      "Still working...",
      "More work...",
    ]);

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.start();

    expect(engine.state.status).toBe("max_iterations");
    expect(engine.state.currentIteration).toBe(2);
  });

  test("can be stopped manually", async () => {
    const task = createTestTask({ maxIterations: 10 });

    // Create a slow backend that we can control using async streaming
    let resolveEvents: (() => void) | undefined;
    let sendPromptAsyncCalled = false;
    let abortCalled = false;
    let disconnectCalled = false;

    const baseMock = createMockBackend([]);
    mockBackend = {
      ...baseMock,
      async sendPromptAsync(): Promise<void> {
        sendPromptAsyncCalled = true;
        // This just signals we're ready for events
      },
      async abortSession(sessionId: string): Promise<void> {
        abortCalled = true;
        await baseMock.abortSession(sessionId);
      },
      async disconnect(): Promise<void> {
        disconnectCalled = true;
        await baseMock.disconnect();
      },
      async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
        // Return an EventStream that waits for external signal before yielding events
        const { stream, push, end } = createEventStream<AgentEvent>();

        // Wait for external signal, then push events
        (async () => {
          await new Promise<void>((resolve) => {
            resolveEvents = resolve;
          });
          push({ type: "message.start", messageId: `msg-${Date.now()}` });
          push({ type: "message.delta", content: "Still working..." });
          push({ type: "message.complete", content: "Still working..." });
          end();
        })();

        return stream;
      },
    };

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Start in background
    const startPromise = engine.start();

    // Wait for sendPromptAsync to be called
    while (!sendPromptAsyncCalled) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Now stop the engine (this sets aborted flag)
    await engine.stop("Test stop");

    // Resolve the pending events so the task can finish
    if (resolveEvents) resolveEvents();

    await startPromise;

    expect(engine.state.status).toBe("stopped");
    expect(abortCalled).toBe(true);
    expect(disconnectCalled).toBe(true);
  });

  test("completes on second iteration", async () => {
    // This test verifies that the engine correctly runs multiple iterations
    // and completes when the stop pattern is detected
    const task = createTestTask({ maxIterations: 5 });

    // Create a backend that completes on 2nd iteration using async streaming
    let responseCount = 0;
    let promptSent = false;

    const baseMock = createMockBackend([]);
    mockBackend = {
      ...baseMock,
      async sendPromptAsync(): Promise<void> {
        responseCount++;
        promptSent = true;
      },
      async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
        const { stream, push, end } = createEventStream<AgentEvent>();

        // Push events asynchronously after sendPromptAsync
        (async () => {
          // Wait for sendPromptAsync to be called
          let attempts = 0;
          while (!promptSent && attempts < 100) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            attempts++;
          }
          promptSent = false;

          // Complete on second iteration
          const content = responseCount >= 2 ? "<promise>COMPLETE</promise>" : "Working...";

          push({ type: "message.start", messageId: `msg-${Date.now()}` });
          push({ type: "message.delta", content });
          push({ type: "message.complete", content });
          end();
        })();

        return stream;
      },
    };

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Run to completion
    await engine.start();

    // Verify it completed
    expect(engine.state.status).toBe("completed");
    expect(engine.state.currentIteration).toBe(2);
  });

  test("handles errors gracefully", async () => {
    // Set maxConsecutiveErrors to 1 so it fails after first error
    const task = createTestTask({ maxConsecutiveErrors: 1 });

    const baseMock = createMockBackend([]);
    mockBackend = {
      ...baseMock,
      async sendPromptAsync(): Promise<void> {
        throw new Error("Backend error");
      },
    };

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.start();

    expect(engine.state.status).toBe("failed");
    expect(engine.state.error?.message).toContain("Backend error");

    // Check error event was emitted
    const errorEvents = emittedEvents.filter((e) => e.type === "task.error");
    expect(errorEvents.length).toBe(1);
  });

  test("continues to next iteration after error event from backend (error doesn't count towards max iterations)", async () => {
    // This test validates that when the backend emits an error event mid-stream,
    // the engine correctly continues to the next iteration instead of stopping.
    // Also validates that error iterations don't count towards maxIterations.
    const task = createTestTask({ maxIterations: 3, maxConsecutiveErrors: 3 });
    const persistedSnapshots: Array<{
      currentIteration: number;
      status: TaskState["status"];
      consecutiveErrorCount?: number;
      lastOutcome?: string;
    }> = [];

    let iterationCount = 0;
    let promptSent = false;

    // Create a mock backend that:
    // - Iteration 1: starts responding, then emits an error
    // - Iteration 2: completes successfully with COMPLETE pattern
    const baseMock = createMockBackend([]);
    mockBackend = {
      ...baseMock,
      async sendPromptAsync(): Promise<void> {
        iterationCount++;
        promptSent = true;
      },
      async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
        const { stream, push, end } = createEventStream<AgentEvent>();

        // Push events asynchronously after sendPromptAsync
        (async () => {
          // Wait for sendPromptAsync to be called
          let attempts = 0;
          while (!promptSent && attempts < 100) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            attempts++;
          }
          promptSent = false;

          // Now iterationCount is accurate
          const currentIteration = iterationCount;

          if (currentIteration === 1) {
            // First iteration: start responding, then error
            push({ type: "message.start", messageId: `msg-${Date.now()}` });
            push({ type: "message.delta", content: "Starting to work..." });
            push({ type: "error", message: "Error: File not found: /some/file.ts" });
          } else if (currentIteration === 2) {
            // Second iteration: complete successfully
            push({ type: "message.start", messageId: `msg-${Date.now()}` });
            push({ type: "message.delta", content: "Fixed it! <promise>COMPLETE</promise>" });
            push({ type: "message.complete", content: "Fixed it! <promise>COMPLETE</promise>" });
          }
          end();
        })();

        return stream;
      },
    };

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
      onPersistState: async (state: TaskState) => {
        persistedSnapshots.push({
          currentIteration: state.currentIteration,
          status: state.status,
          consecutiveErrorCount: state.consecutiveErrors?.count,
          lastOutcome: state.recentIterations.at(-1)?.outcome,
        });
      },
    });

    // Add timeout to detect if the engine hangs
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Test timed out - engine hung after error")), 5000);
    });

    await Promise.race([engine.start(), timeoutPromise]);

    // Should have completed successfully
    expect(engine.state.status).toBe("completed");
    
    // Error iteration doesn't count - only the successful one counts
    // So currentIteration should be 1, not 2
    expect(engine.state.currentIteration).toBe(1);

    // Check iteration summaries - still have 2 attempts recorded
    expect(engine.state.recentIterations.length).toBe(2);
    expect(engine.state.recentIterations[0]!.outcome).toBe("error");
    expect(engine.state.recentIterations[1]!.outcome).toBe("complete");

    // Check that error event was emitted for iteration 1
    const errorEvents = emittedEvents.filter((e) => e.type === "task.error");
    expect(errorEvents.length).toBe(1);
    expect(persistedSnapshots.some((snapshot) =>
      snapshot.status === "running"
      && snapshot.currentIteration === 0
      && snapshot.consecutiveErrorCount === 1
      && snapshot.lastOutcome === "error")).toBe(true);

    // Check that both iteration start events were emitted
    const iterationStartEvents = emittedEvents.filter((e) => e.type === "task.iteration.start");
    expect(iterationStartEvents.length).toBe(2);
  }, 10000); // 10 second timeout for the test itself

  test("multiple errors don't count towards maxIterations limit", async () => {
    // If maxIterations is 2, and we have 3 errors followed by 2 successes,
    // we should hit maxIterations after 2 successful iterations, not fail early.
    const task = createTestTask({ maxIterations: 2, maxConsecutiveErrors: 10 });

    let attemptCount = 0;
    let promptSent = false;

    const baseMock = createMockBackend([]);
    mockBackend = {
      ...baseMock,
      async sendPromptAsync(): Promise<void> {
        attemptCount++;
        promptSent = true;
      },
      async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
        const { stream, push, end } = createEventStream<AgentEvent>();

        // Push events asynchronously after sendPromptAsync
        (async () => {
          // Wait for sendPromptAsync to be called
          let attempts = 0;
          while (!promptSent && attempts < 100) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            attempts++;
          }
          promptSent = false;

          // Now attemptCount is accurate
          const currentAttempt = attemptCount;

          if (currentAttempt <= 3) {
            // First 3 attempts: emit errors
            push({ type: "message.start", messageId: `msg-${Date.now()}` });
            push({ type: "error", message: `Error attempt ${currentAttempt}` });
          } else {
            // After that: success (no COMPLETE pattern, so it continues)
            push({ type: "message.start", messageId: `msg-${Date.now()}` });
            push({ type: "message.delta", content: "Success!" });
            push({ type: "message.complete", content: "Success!" });
          }
          end();
        })();

        return stream;
      },
    };

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Test timed out")), 5000);
    });

    await Promise.race([engine.start(), timeoutPromise]);

    // Should have hit maxIterations after 2 successful iterations
    expect(engine.state.status).toBe("max_iterations");
    expect(engine.state.currentIteration).toBe(2);

    // Total attempts should be 5 (3 errors + 2 successes)
    expect(attemptCount).toBe(5);

    // recentIterations should have all 5 attempts
    expect(engine.state.recentIterations.length).toBe(5);
    expect(engine.state.recentIterations[0]!.outcome).toBe("error");
    expect(engine.state.recentIterations[1]!.outcome).toBe("error");
    expect(engine.state.recentIterations[2]!.outcome).toBe("error");
    expect(engine.state.recentIterations[3]!.outcome).toBe("continue");
    expect(engine.state.recentIterations[4]!.outcome).toBe("continue");
  }, 10000);

    test("records iteration summaries", async () => {
      const task = createTestTask({ maxIterations: 3 });
    mockBackend = createMockBackend([
      "First",
      "Second",
      "<promise>COMPLETE</promise>",
    ]);

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.start();

    expect(engine.state.recentIterations.length).toBe(3);
    expect(engine.state.recentIterations[0]!.iteration).toBe(1);
    expect(engine.state.recentIterations[0]!.outcome).toBe("continue");
      expect(engine.state.recentIterations[2]!.outcome).toBe("complete");
    });

    test("setupGitBranch preserves originalBranch even on working branch", async () => {
      const task = createTestTask({ maxIterations: 1 });
      mockBackend = createMockBackend(["<promise>COMPLETE</promise>"]);

      await Bun.$`git checkout -b working-a1b2c3d`.cwd(testDir).quiet();

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      expect(engine.state.status).toBe("completed");
      expect(engine.state.git?.originalBranch).toBe("working-a1b2c3d");
    }, 10000);

    test("setupGitBranch preserves existing originalBranch", async () => {
      // Get the actual default branch name (varies by environment: main vs master)
      const defaultBranch = (await Bun.$`git branch --show-current`.cwd(testDir).text()).trim();
      
      const task = createTestTask({ maxIterations: 1 });
      task.state.git = {
        originalBranch: defaultBranch,
        workingBranch: "existing-a1b2c3d",
        commits: [],
      };
      mockBackend = createMockBackend(["<promise>COMPLETE</promise>"]);

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      expect(engine.state.status).toBe("completed");
      expect(engine.state.git?.originalBranch).toBe(defaultBranch);
    }, 10000);

    test("setupGitBranch checks out the base branch before pull when using worktrees", async () => {
      const task = createTestTask({
        baseBranch: "main",
        useWorktree: true,
      });
      task.state.startedAt = new Date().toISOString();

      const calls: string[] = [];
      const mockGitService = {
        isGitRepo: async () => true,
        ensureWorktreeExcluded: async () => {
          calls.push("exclude");
        },
        getCurrentBranch: async () => "feature/current",
        checkoutBranch: async (_directory: string, branch: string) => {
          calls.push(`checkout:${branch}`);
        },
        pull: async (_directory: string, branch?: string) => {
          calls.push(`pull:${branch}`);
          return true;
        },
        branchExists: async () => false,
        worktreeExists: async () => false,
        createWorktree: async (_directory: string, _worktreePath: string, branchName: string, originalBranch: string) => {
          calls.push(`createWorktree:${branchName}:${originalBranch}`);
        },
      } as unknown as GitService;

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService: mockGitService,
        eventEmitter: emitter,
      });

      await (engine as unknown as { setupGitBranch: () => Promise<void> }).setupGitBranch();

      expect(calls).toEqual([
        "exclude",
        "checkout:main",
        "pull:main",
        `createWorktree:${engine.state.git?.workingBranch}:main`,
      ]);
    });

    test("setupGitBranch appends a numeric suffix when the generated branch already exists", async () => {
      const task = createTestTask({
        name: "My Feature",
        prompt: "Test prompt",
        baseBranch: "main",
        useWorktree: true,
      });
      task.state.startedAt = new Date().toISOString();
      mockBackend = createMockBackend([]);

      const calls: string[] = [];
      const baseBranchName = "my-feature-46817f3";
      const mockGitService = {
        isGitRepo: async () => true,
        ensureWorktreeExcluded: async () => {
          calls.push("exclude");
        },
        getCurrentBranch: async () => "main",
        checkoutBranch: async (_directory: string, branch: string) => {
          calls.push(`checkout:${branch}`);
        },
        pull: async (_directory: string, branch?: string) => {
          calls.push(`pull:${branch}`);
          return true;
        },
        branchExists: async (_directory: string, branch: string) => branch === baseBranchName,
        worktreeExists: async () => false,
        createWorktree: async (
          _directory: string,
          _worktreePath: string,
          branchName: string,
          originalBranch: string,
        ) => {
          calls.push(`createWorktree:${branchName}:${originalBranch}`);
        },
      } as unknown as GitService;

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService: mockGitService,
        eventEmitter: emitter,
      });

      await (engine as unknown as { setupGitBranch: () => Promise<void> }).setupGitBranch();

      expect(engine.state.git?.workingBranch).toBe(`${baseBranchName}-2`);
      expect(calls).toEqual([
        "exclude",
        "pull:main",
        `createWorktree:${baseBranchName}-2:main`,
      ]);
    });

  test("setPendingPrompt updates state", async () => {
    const task = createTestTask({ maxIterations: 1 });

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Set pending prompt
    engine.setPendingPrompt("New modified prompt");
    expect(engine.state.pendingPrompt).toBe("New modified prompt");

    // Clear pending prompt
    engine.clearPendingPrompt();
    expect(engine.state.pendingPrompt).toBeUndefined();
  });

  test("buildPrompt uses pendingPrompt and clears it after use", async () => {
    const task = createTestTask({ maxIterations: 2 });
    mockBackend = createMockBackend([
      "First iteration response",
      "<promise>COMPLETE</promise>",
    ]);

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Set pending prompt before starting
    engine.setPendingPrompt("Modified goal for iteration 1");
    expect(engine.state.pendingPrompt).toBe("Modified goal for iteration 1");

    // Start the task - first iteration should consume the pending prompt
    await engine.start();

    // After the task completes, pending prompt should be cleared
    expect(engine.state.pendingPrompt).toBeUndefined();

    // Check that log events were emitted for user message injection
    const userMessageLogs = emittedEvents.filter(
      (e) => e.type === "task.log" && e.message.includes("User injected")
    );
    expect(userMessageLogs.length).toBeGreaterThan(0);
  });

  test("timeout triggers when no events are received within activity timeout", async () => {
    // Use a very short timeout to make the test fast
    const task = createTestTask({ 
      maxIterations: 2, 
      maxConsecutiveErrors: 2,
      activityTimeoutSeconds: 0.1, // 100ms timeout
    });

    let promptSent = false;

    // Create a backend that never sends events after message.start
    const baseMock = createMockBackend([]);
    mockBackend = {
      ...baseMock,
      async sendPromptAsync(): Promise<void> {
        promptSent = true;
      },
      async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
        const { stream, push } = createEventStream<AgentEvent>();

        // Push events asynchronously after sendPromptAsync
        (async () => {
          // Wait for sendPromptAsync to be called
          let attempts = 0;
          while (!promptSent && attempts < 100) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            attempts++;
          }
          promptSent = false;

          // Only send message.start, then never send any more events
          // This should trigger the timeout
          push({ type: "message.start", messageId: `msg-${Date.now()}` });
          // Intentionally NOT calling end() to simulate a hanging connection
        })();

        return stream;
      },
    };

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Add timeout to detect if the test hangs
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Test timed out - timeout did not trigger")), 5000);
    });

    await Promise.race([engine.start(), timeoutPromise]);

    // Engine should have failed due to max consecutive errors (timeout is treated as error)
    expect(engine.state.status).toBe("failed");
    
    // Check that error includes the timeout message
    expect(engine.state.error?.message).toContain("No activity for");

    // Check error events were emitted
    const errorEvents = emittedEvents.filter((e) => e.type === "task.error");
    expect(errorEvents.length).toBeGreaterThan(0);
  }, 10000);

  test("unlimited activity timeout waits for delayed events", async () => {
    const task = createTestTask({
      maxIterations: 2,
      activityTimeoutSeconds: null,
    });

    let promptSent = false;
    const baseMock = createMockBackend([]);
    mockBackend = {
      ...baseMock,
      async sendPromptAsync(): Promise<void> {
        promptSent = true;
      },
      async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
        const { stream, push, end } = createEventStream<AgentEvent>();

        (async () => {
          let attempts = 0;
          while (!promptSent && attempts < 100) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            attempts++;
          }

          await new Promise((resolve) => setTimeout(resolve, 100));
          push({ type: "message.start", messageId: `msg-${Date.now()}` });
          push({ type: "message.delta", content: "<promise>COMPLETE</promise>" });
          push({ type: "message.complete", content: "<promise>COMPLETE</promise>" });
          end();
        })();

        return stream;
      },
    };

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.start();

    expect(engine.state.status).toBe("completed");
    expect(engine.state.error).toBeUndefined();
  });

  test("permission.asked events trigger auto-approval", async () => {
    const task = createTestTask({ maxIterations: 2 });

    let promptSent = false;
    let permissionReplyReceived = false;
    let permissionReplyValue = "";

    const baseMock = createMockBackend([]);
    mockBackend = {
      ...baseMock,
      async sendPromptAsync(): Promise<void> {
        promptSent = true;
      },
      async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
        const { stream, push, end } = createEventStream<AgentEvent>();

        (async () => {
          let attempts = 0;
          while (!promptSent && attempts < 100) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            attempts++;
          }
          promptSent = false;

          // Emit a permission.asked event
          push({ type: "message.start", messageId: `msg-${Date.now()}` });
          push({ 
            type: "permission.asked", 
            requestId: "perm-123", 
            sessionId: "session-1",
            permission: "write_file",
            patterns: ["/some/path/*"],
          });
          
          // Give time for the permission to be handled
          await new Promise((resolve) => setTimeout(resolve, 50));
          
          // Then complete the message
          push({ type: "message.delta", content: "<promise>COMPLETE</promise>" });
          push({ type: "message.complete", content: "<promise>COMPLETE</promise>" });
          end();
        })();

        return stream;
      },
    };
    
    // Override the replyToPermission method for this test
    mockBackend.replyToPermission = async (requestId: string, reply: string): Promise<void> => {
      permissionReplyReceived = true;
      permissionReplyValue = reply;
      expect(requestId).toBe("perm-123");
    };

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Test timed out")), 5000);
    });

    await Promise.race([engine.start(), timeoutPromise]);

    expect(engine.state.status).toBe("completed");
    
    // Verify permission was auto-approved with "always"
    expect(permissionReplyReceived).toBe(true);
    expect(permissionReplyValue).toBe("always");

    // Check that log events mention permission approval
    const permissionLogs = emittedEvents.filter(
      (e) => e.type === "task.log" && e.message.includes("permission")
    );
    expect(permissionLogs.length).toBeGreaterThan(0);
  }, 10000);

  test("question.asked events trigger auto-answer", async () => {
    const task = createTestTask({ maxIterations: 2 });

    let promptSent = false;
    let questionReplyReceived = false;
    let questionReplyAnswers: string[][] = [];

    const baseMock = createMockBackend([]);
    mockBackend = {
      ...baseMock,
      async sendPromptAsync(): Promise<void> {
        promptSent = true;
      },
      async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
        const { stream, push, end } = createEventStream<AgentEvent>();

        (async () => {
          let attempts = 0;
          while (!promptSent && attempts < 100) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            attempts++;
          }
          promptSent = false;

          // Emit a question.asked event
          push({ type: "message.start", messageId: `msg-${Date.now()}` });
          push({ 
            type: "question.asked", 
            requestId: "question-456", 
            sessionId: "session-1",
            questions: [
              { 
                question: "Which framework should I use?",
                header: "Framework Choice",
                options: [
                  { label: "React", description: "Popular UI library" },
                  { label: "Vue", description: "Progressive framework" },
                ],
              },
            ],
          });
          
          // Give time for the question to be handled
          await new Promise((resolve) => setTimeout(resolve, 50));
          
          // Then complete the message
          push({ type: "message.delta", content: "<promise>COMPLETE</promise>" });
          push({ type: "message.complete", content: "<promise>COMPLETE</promise>" });
          end();
        })();

        return stream;
      },
    };
    
    // Override the replyToQuestion method for this test
    mockBackend.replyToQuestion = async (requestId: string, answers: string[][]): Promise<void> => {
      questionReplyReceived = true;
      questionReplyAnswers = answers;
      expect(requestId).toBe("question-456");
    };

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Test timed out")), 5000);
    });

    await Promise.race([engine.start(), timeoutPromise]);

    expect(engine.state.status).toBe("completed");
    
    // Verify question was auto-answered
    expect(questionReplyReceived).toBe(true);
    expect(questionReplyAnswers).toEqual([
      ["take the best course of action you recommend"],
    ]);

    // Check that log events mention question handling
    const questionLogs = emittedEvents.filter(
      (e) => e.type === "task.log" && e.message.includes("question")
    );
    expect(questionLogs.length).toBeGreaterThan(0);
  }, 10000);

  test("plan-mode questions also auto-answer immediately", async () => {
    const task = createTestTask({ planMode: true });
    task.state.status = "planning";
    task.state.planMode = {
      active: true,
      feedbackRounds: 0,
      planningFolderCleared: false,
      isPlanReady: false,
    };

    let repliedRequestId = "";
    let repliedAnswers: string[][] = [];
    mockBackend = {
      ...createMockBackend([]),
      async replyToQuestion(requestId: string, answers: string[][]): Promise<void> {
        repliedRequestId = requestId;
        repliedAnswers = answers;
      },
    };

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    const handleQuestionAsked = (engine as unknown as {
      handleQuestionAsked: (event: AgentEvent & { type: "question.asked" }) => Promise<void>;
    }).handleQuestionAsked.bind(engine);

    await handleQuestionAsked({
      type: "question.asked",
      requestId: "question-plan-auto-1",
      sessionId: "session-1",
      questions: [
        {
          header: "Choose an approach",
          question: "Which path should I take?",
          options: [
            { label: "Option A", description: "Use option A" },
            { label: "Option B", description: "Use option B" },
          ],
          custom: true,
        },
      ],
    });

    expect(repliedRequestId).toBe("question-plan-auto-1");
    expect(repliedAnswers).toEqual([["take the best course of action you recommend"]]);
    expect("pendingQuestion" in (engine.state.planMode ?? {})).toBe(false);
  });

  test("session.status events are logged for debugging", async () => {
    const task = createTestTask({ maxIterations: 2 });

    let promptSent = false;

    const baseMock = createMockBackend([]);
    mockBackend = {
      ...baseMock,
      async sendPromptAsync(): Promise<void> {
        promptSent = true;
      },
      async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
        const { stream, push, end } = createEventStream<AgentEvent>();

        (async () => {
          let attempts = 0;
          while (!promptSent && attempts < 100) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            attempts++;
          }
          promptSent = false;

          // Emit session.status events
          push({ type: "message.start", messageId: `msg-${Date.now()}` });
          push({ 
            type: "session.status", 
            sessionId: "session-1",
            status: "busy",
            attempt: 1,
            message: "Processing request",
          });
          push({ 
            type: "session.status", 
            sessionId: "session-1",
            status: "idle",
          });
          
          // Then complete the message
          push({ type: "message.delta", content: "<promise>COMPLETE</promise>" });
          push({ type: "message.complete", content: "<promise>COMPLETE</promise>" });
          end();
        })();

        return stream;
      },
    };

    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Test timed out")), 5000);
    });

    await Promise.race([engine.start(), timeoutPromise]);

    expect(engine.state.status).toBe("completed");
    
    // Check that session status was logged
    const statusLogs = emittedEvents.filter(
      (e) => e.type === "task.log" && e.message.includes("Session status")
    );
    
    // Should have at least 2 status log entries (busy and idle)
    expect(statusLogs.length).toBeGreaterThanOrEqual(2);
    
    // Verify the log content includes the status
    const busyLog = statusLogs.find((e) => e.type === "task.log" && e.message.includes("busy"));
    const idleLog = statusLogs.find((e) => e.type === "task.log" && e.message.includes("idle"));
    expect(busyLog).toBeDefined();
    expect(idleLog).toBeDefined();
  }, 10000);

  describe("clearPlanningFolder", () => {
    // Helper to get the worktree path from engine state
    function getWorktreePlanningDir(engine: TaskEngine): string {
      const worktreePath = engine.state.git?.worktreePath;
      return join(worktreePath ?? testDir, ".clanky-planning");
    }

    test("clears .clanky-planning folder when clearPlanningFolder is true", async () => {
      // Create .clanky-planning folder with files
      const planningDir = join(testDir, ".clanky-planning");
      await Bun.$`mkdir -p ${planningDir}`.quiet();
      await writeFile(join(planningDir, "plan.md"), "# Old Plan\nSome old content");
      await writeFile(join(planningDir, "status.md"), "# Old Status\nPrevious status");
      await writeFile(join(planningDir, ".gitkeep"), "");
      
      // Commit the .clanky-planning folder so the files are in the worktree
      await Bun.$`git add .`.cwd(testDir).quiet();
      await Bun.$`git commit -m "Add planning files"`.cwd(testDir).quiet();

      const task = createTestTask({ 
        maxIterations: 1, 
        clearPlanningFolder: true 
      });
      mockBackend = createMockBackend(["<promise>COMPLETE</promise>"]);

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      expect(engine.state.status).toBe("completed");

      // Verify .clanky-planning folder was cleared in the worktree (only .gitkeep should remain)
      const { readdir } = await import("fs/promises");
      const wtPlanningDir = getWorktreePlanningDir(engine);
      const files = await readdir(wtPlanningDir);
      expect(files).toEqual([".gitkeep"]);
      
      // Check that log event was emitted for clearing
      const clearLogs = emittedEvents.filter(
        (e) => e.type === "task.log" && e.message.includes("Clearing .clanky-planning folder")
      );
      expect(clearLogs.length).toBe(1);
    }, 10000);

    test("does not clear .clanky-planning folder when clearPlanningFolder is false (default)", async () => {
      // Create .clanky-planning folder with files
      const planningDir = join(testDir, ".clanky-planning");
      await Bun.$`mkdir -p ${planningDir}`.quiet();
      await writeFile(join(planningDir, "plan.md"), "# Existing Plan");
      await writeFile(join(planningDir, "status.md"), "# Existing Status");
      
      // Commit the .clanky-planning folder so the files are in the worktree
      await Bun.$`git add .`.cwd(testDir).quiet();
      await Bun.$`git commit -m "Add planning files"`.cwd(testDir).quiet();

      const task = createTestTask({ 
        maxIterations: 1,
        clearPlanningFolder: false,
      });
      mockBackend = createMockBackend(["<promise>COMPLETE</promise>"]);

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      expect(engine.state.status).toBe("completed");

      // Verify .clanky-planning folder still has all files in the worktree
      const { readdir, readFile } = await import("fs/promises");
      const wtPlanningDir = getWorktreePlanningDir(engine);
      const files = await readdir(wtPlanningDir);
      expect(files.sort()).toEqual(["plan.md", "status.md"]);
      
      // Verify content is preserved
      const planContent = await readFile(join(wtPlanningDir, "plan.md"), "utf-8");
      expect(planContent).toBe("# Existing Plan");
      
      // Check that no clear log event was emitted
      const clearLogs = emittedEvents.filter(
        (e) => e.type === "task.log" && e.message.includes("Clearing .clanky-planning folder")
      );
      expect(clearLogs.length).toBe(0);
    }, 10000);

    test("handles missing .clanky-planning folder gracefully", async () => {
      // Ensure no .clanky-planning folder exists
      const planningDir = join(testDir, ".clanky-planning");
      await Bun.$`rm -rf ${planningDir}`.quiet();

      const task = createTestTask({ 
        maxIterations: 1, 
        clearPlanningFolder: true 
      });
      mockBackend = createMockBackend(["<promise>COMPLETE</promise>"]);

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      // Should not throw an error
      await engine.start();

      expect(engine.state.status).toBe("completed");

      // Clanky now creates the managed planning directory before clearing it.
      const { readdir } = await import("fs/promises");
      expect(await readdir(getWorktreePlanningDir(engine))).toEqual([]);

      const debugLogs = emittedEvents.filter(
        (e) => e.type === "task.log" && e.message === ".clanky-planning directory is already empty"
      );
      expect(debugLogs.length).toBe(1);
    }, 10000);

    test("handles empty .clanky-planning folder gracefully", async () => {
      // Create .clanky-planning folder with only .gitkeep, commit, then remove .gitkeep and commit.
      // Git doesn't track empty directories, so the worktree won't have the .clanky-planning dir at all.
      const planningDir = join(testDir, ".clanky-planning");
      await Bun.$`mkdir -p ${planningDir}`.quiet();
      await writeFile(join(planningDir, ".gitkeep"), "");
      await Bun.$`git add .`.cwd(testDir).quiet();
      await Bun.$`git commit -m "Add empty planning folder"`.cwd(testDir).quiet();
      await Bun.$`rm ${planningDir}/.gitkeep`.quiet();
      await Bun.$`git add .`.cwd(testDir).quiet();
      await Bun.$`git commit -m "Remove gitkeep"`.cwd(testDir).quiet();

      const task = createTestTask({ 
        maxIterations: 1, 
        clearPlanningFolder: true 
      });
      mockBackend = createMockBackend(["<promise>COMPLETE</promise>"]);

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      expect(engine.state.status).toBe("completed");
      
      // Git doesn't track empty directories, but Clanky recreates the managed directory.
      const { readdir } = await import("fs/promises");
      expect(await readdir(getWorktreePlanningDir(engine))).toEqual([]);

      const debugLogs = emittedEvents.filter(
        (e) => e.type === "task.log" && e.message === ".clanky-planning directory is already empty"
      );
      expect(debugLogs.length).toBe(1);
    }, 10000);

    test("preserves .gitkeep when clearing .clanky-planning folder", async () => {
      // Create .clanky-planning folder with files including .gitkeep
      const planningDir = join(testDir, ".clanky-planning");
      await Bun.$`mkdir -p ${planningDir}`.quiet();
      await writeFile(join(planningDir, "plan.md"), "# Plan to delete");
      await writeFile(join(planningDir, "status.md"), "# Status to delete");
      await writeFile(join(planningDir, ".gitkeep"), "");
      
      // Commit the .clanky-planning folder so the files are in the worktree
      await Bun.$`git add .`.cwd(testDir).quiet();
      await Bun.$`git commit -m "Add planning files with gitkeep"`.cwd(testDir).quiet();

      const task = createTestTask({ 
        maxIterations: 1, 
        clearPlanningFolder: true 
      });
      mockBackend = createMockBackend(["<promise>COMPLETE</promise>"]);

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      expect(engine.state.status).toBe("completed");

      // Verify only .gitkeep remains in the worktree
      const { readdir } = await import("fs/promises");
      const wtPlanningDir = getWorktreePlanningDir(engine);
      const files = await readdir(wtPlanningDir);
      expect(files).toEqual([".gitkeep"]);
      
      // Check log shows correct count of deleted files
      const clearLogs = emittedEvents.filter(
        (e) => e.type === "task.log" && e.message.includes("2 file(s) deleted")
      );
      expect(clearLogs.length).toBe(1);
    }, 10000);

    test("clears subdirectories in .clanky-planning folder", async () => {
      // Create .clanky-planning folder with nested structure
      const planningDir = join(testDir, ".clanky-planning");
      const subDir = join(planningDir, "subdir");
      await Bun.$`mkdir -p ${subDir}`.quiet();
      await writeFile(join(planningDir, "plan.md"), "# Main plan");
      await writeFile(join(subDir, "nested.md"), "# Nested file");
      await writeFile(join(planningDir, ".gitkeep"), "");
      
      // Commit the .clanky-planning folder so the files are in the worktree
      await Bun.$`git add .`.cwd(testDir).quiet();
      await Bun.$`git commit -m "Add nested planning files"`.cwd(testDir).quiet();

      const task = createTestTask({ 
        maxIterations: 1, 
        clearPlanningFolder: true 
      });
      mockBackend = createMockBackend(["<promise>COMPLETE</promise>"]);

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      expect(engine.state.status).toBe("completed");

      // Verify only .gitkeep remains in the worktree (subdirectory should be deleted)
      const { readdir } = await import("fs/promises");
      const wtPlanningDir = getWorktreePlanningDir(engine);
      const files = await readdir(wtPlanningDir);
      expect(files).toEqual([".gitkeep"]);
    }, 10000);

    test("clearing happens after git branch setup (so deletions can be committed)", async () => {
      // Create .clanky-planning folder with files
      const planningDir = join(testDir, ".clanky-planning");
      await Bun.$`mkdir -p ${planningDir}`.quiet();
      await writeFile(join(planningDir, "plan.md"), "# Old Plan");
      await writeFile(join(planningDir, ".gitkeep"), "");
      
      // Commit the .clanky-planning folder
      await Bun.$`git add .`.cwd(testDir).quiet();
      await Bun.$`git commit -m "Add planning files"`.cwd(testDir).quiet();

      const task = createTestTask({ 
        maxIterations: 1, 
        clearPlanningFolder: true 
      });
      mockBackend = createMockBackend(["<promise>COMPLETE</promise>"]);

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      // Check the order of events: git setup should happen before clear (since clear commits after)
      const logEvents = emittedEvents.filter((e) => e.type === "task.log");
      const clearIndex = logEvents.findIndex((e) => 
        e.type === "task.log" && e.message.includes("Clearing .clanky-planning folder")
      );
      const gitIndex = logEvents.findIndex((e) => 
        e.type === "task.log" && e.message.includes("Setting up git branch")
      );
      
      expect(clearIndex).toBeGreaterThan(-1);
      expect(gitIndex).toBeGreaterThan(-1);
      // Git setup happens first, then clearing (so deletions are on the new branch and can be committed)
      expect(gitIndex).toBeLessThan(clearIndex);
    }, 30000);
  });

  describe("error context in prompts", () => {
    test("prompt includes error context after a failed iteration", async () => {
      const task = createTestTask({ maxIterations: 3, maxConsecutiveErrors: 3 });
      const capturedPrompts: PromptInput[] = [];
      let callCount = 0;

      // Create a backend that errors on first iteration, succeeds on second
      const baseMock = createMockBackend([]);
      let promptSent = false;
      mockBackend = {
        ...baseMock,
        async sendPromptAsync(_sessionId: string, prompt: PromptInput): Promise<void> {
          capturedPrompts.push(prompt);
          callCount++;
          promptSent = true;
        },
        async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
          const { stream, push, end } = createEventStream<AgentEvent>();

          (async () => {
            let attempts = 0;
            while (!promptSent && attempts < 100) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              attempts++;
            }
            promptSent = false;

            if (callCount === 1) {
              // First iteration: emit an error
              push({ type: "error", message: "Connection timed out" });
              end();
            } else {
              // Second iteration: succeed with completion
              push({ type: "message.start", messageId: `msg-${Date.now()}` });
              push({ type: "message.delta", content: "Done! <promise>COMPLETE</promise>" });
              push({ type: "message.complete", content: "Done! <promise>COMPLETE</promise>" });
              end();
            }
          })();

          return stream;
        },
      };

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      // Should have captured 2 prompts (error iteration + successful retry)
      expect(capturedPrompts.length).toBe(2);

      // First prompt should NOT contain error context
      const firstPromptText = capturedPrompts[0]!.parts[0]!;
      expect(firstPromptText.type).toBe("text");
      if (firstPromptText.type === "text") {
        expect(firstPromptText.text).not.toContain("Previous Iteration Error");
      }

      // Second prompt SHOULD contain error context
      const secondPromptText = capturedPrompts[1]!.parts[0]!;
      expect(secondPromptText.type).toBe("text");
      if (secondPromptText.type === "text") {
        expect(secondPromptText.text).toContain("Previous Iteration Error");
        expect(secondPromptText.text).toContain("Connection timed out");
        expect(secondPromptText.text).toContain("1 time(s) consecutively");
      }
    });

    test("prompt does NOT include error context on first iteration", async () => {
      const task = createTestTask({ maxIterations: 1 });
      const capturedPrompts: PromptInput[] = [];

      const baseMock = createMockBackend([]);
      let promptSent = false;
      mockBackend = {
        ...baseMock,
        async sendPromptAsync(_sessionId: string, prompt: PromptInput): Promise<void> {
          capturedPrompts.push(prompt);
          promptSent = true;
        },
        async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
          const { stream, push, end } = createEventStream<AgentEvent>();

          (async () => {
            let attempts = 0;
            while (!promptSent && attempts < 100) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              attempts++;
            }
            promptSent = false;

            push({ type: "message.start", messageId: `msg-${Date.now()}` });
            push({ type: "message.delta", content: "Done! <promise>COMPLETE</promise>" });
            push({ type: "message.complete", content: "Done! <promise>COMPLETE</promise>" });
            end();
          })();

          return stream;
        },
      };

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      expect(capturedPrompts.length).toBe(1);
      const promptText = capturedPrompts[0]!.parts[0]!;
      expect(promptText.type).toBe("text");
      if (promptText.type === "text") {
        expect(promptText.text).not.toContain("Previous Iteration Error");
      }
    });

    test("error context includes consecutive count", async () => {
      const task = createTestTask({ maxIterations: 3, maxConsecutiveErrors: 5 });
      const capturedPrompts: PromptInput[] = [];
      let callCount = 0;

      const baseMock = createMockBackend([]);
      let promptSent = false;
      mockBackend = {
        ...baseMock,
        async sendPromptAsync(_sessionId: string, prompt: PromptInput): Promise<void> {
          capturedPrompts.push(prompt);
          callCount++;
          promptSent = true;
        },
        async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
          const { stream, push, end } = createEventStream<AgentEvent>();

          (async () => {
            let attempts = 0;
            while (!promptSent && attempts < 100) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              attempts++;
            }
            promptSent = false;

            if (callCount <= 2) {
              // First two iterations: emit the same error
              push({ type: "error", message: "Backend unavailable" });
              end();
            } else {
              // Third iteration: succeed
              push({ type: "message.start", messageId: `msg-${Date.now()}` });
              push({ type: "message.delta", content: "Done! <promise>COMPLETE</promise>" });
              push({ type: "message.complete", content: "Done! <promise>COMPLETE</promise>" });
              end();
            }
          })();

          return stream;
        },
      };

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      // Should have 3 prompts: initial + 2 retries
      expect(capturedPrompts.length).toBe(3);

      // Second prompt should show count of 1
      const secondPromptText = capturedPrompts[1]!.parts[0]!;
      if (secondPromptText.type === "text") {
        expect(secondPromptText.text).toContain("1 time(s) consecutively");
        expect(secondPromptText.text).toContain("Backend unavailable");
      }

      // Third prompt should show count of 2
      const thirdPromptText = capturedPrompts[2]!.parts[0]!;
      if (thirdPromptText.type === "text") {
        expect(thirdPromptText.text).toContain("2 time(s) consecutively");
        expect(thirdPromptText.text).toContain("Backend unavailable");
      }
    });

    test("error context is cleared after successful iteration", async () => {
      const task = createTestTask({ maxIterations: 5, maxConsecutiveErrors: 5 });
      const capturedPrompts: PromptInput[] = [];
      let callCount = 0;

      const baseMock = createMockBackend([]);
      let promptSent = false;
      mockBackend = {
        ...baseMock,
        async sendPromptAsync(_sessionId: string, prompt: PromptInput): Promise<void> {
          capturedPrompts.push(prompt);
          callCount++;
          promptSent = true;
        },
        async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
          const { stream, push, end } = createEventStream<AgentEvent>();

          (async () => {
            let attempts = 0;
            while (!promptSent && attempts < 100) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              attempts++;
            }
            promptSent = false;

            if (callCount === 1) {
              // First iteration: error
              push({ type: "error", message: "Temporary failure" });
              end();
            } else if (callCount === 2) {
              // Second iteration: success (continue, not complete)
              push({ type: "message.start", messageId: `msg-${Date.now()}` });
              push({ type: "message.delta", content: "Working on it..." });
              push({ type: "message.complete", content: "Working on it..." });
              end();
            } else {
              // Third iteration: complete
              push({ type: "message.start", messageId: `msg-${Date.now()}` });
              push({ type: "message.delta", content: "Done! <promise>COMPLETE</promise>" });
              push({ type: "message.complete", content: "Done! <promise>COMPLETE</promise>" });
              end();
            }
          })();

          return stream;
        },
      };

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      // Should have 3 prompts: initial (error) + retry (success) + next (success)
      expect(capturedPrompts.length).toBe(3);

      // Second prompt should contain error context (retry after error)
      const secondPromptText = capturedPrompts[1]!.parts[0]!;
      if (secondPromptText.type === "text") {
        expect(secondPromptText.text).toContain("Previous Iteration Error");
        expect(secondPromptText.text).toContain("Temporary failure");
      }

      // Third prompt should NOT contain error context (after successful iteration)
      const thirdPromptText = capturedPrompts[2]!.parts[0]!;
      if (thirdPromptText.type === "text") {
        expect(thirdPromptText.text).not.toContain("Previous Iteration Error");
        expect(thirdPromptText.text).not.toContain("Temporary failure");
      }
    });

    test("plan mode prompt includes error context when retrying", async () => {
      const task = createTestTask({ maxIterations: 3, maxConsecutiveErrors: 3, planMode: true });
      // Set up plan mode state
      task.state.status = "planning";
      task.state.planMode = {
        active: true,
        feedbackRounds: 0,
        planningFolderCleared: false,
        isPlanReady: false,
      };
      // Plan mode skips git setup in start(), so we need to set the worktree path
      // manually (normally done by startPlanMode() before engine.start()).
      task.state.git = {
        originalBranch: "main",
        workingBranch: "test-a1b2c3d",
        worktreePath: testDir,
        commits: [],
      };

      const capturedPrompts: PromptInput[] = [];
      let callCount = 0;

      const baseMock = createMockBackend([]);
      let promptSent = false;
      mockBackend = {
        ...baseMock,
        async sendPromptAsync(_sessionId: string, prompt: PromptInput): Promise<void> {
          capturedPrompts.push(prompt);
          callCount++;
          promptSent = true;
        },
        async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
          const { stream, push, end } = createEventStream<AgentEvent>();

          (async () => {
            let attempts = 0;
            while (!promptSent && attempts < 100) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              attempts++;
            }
            promptSent = false;

            if (callCount === 1) {
              // First iteration: error
              push({ type: "error", message: "Model rate limited" });
              end();
            } else {
              // Second iteration: succeed with PLAN_READY
              push({ type: "message.start", messageId: `msg-${Date.now()}` });
              push({ type: "message.delta", content: "Plan created\n<promise>PLAN_READY</promise>" });
              push({ type: "message.complete", content: "Plan created\n<promise>PLAN_READY</promise>" });
              end();
            }
          })();

          return stream;
        },
      };

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      // Should have 2 prompts: error + retry
      expect(capturedPrompts.length).toBe(2);

      // First prompt (plan mode) should NOT contain error context
      const firstPromptText = capturedPrompts[0]!.parts[0]!;
      if (firstPromptText.type === "text") {
        expect(firstPromptText.text).toContain("Goal:");
        expect(firstPromptText.text).not.toContain("Previous Iteration Error");
      }

      // Second prompt (plan mode retry) SHOULD contain error context
      const secondPromptText = capturedPrompts[1]!.parts[0]!;
      if (secondPromptText.type === "text") {
        expect(secondPromptText.text).toContain("Goal:");
        expect(secondPromptText.text).toContain("Previous Iteration Error");
        expect(secondPromptText.text).toContain("Model rate limited");
      }
    });

    test("error context is cleared after plan_ready outcome so feedback prompts don't include stale errors", async () => {
      const task = createTestTask({ maxIterations: 5, maxConsecutiveErrors: 5, planMode: true });
      // Set up plan mode state
      task.state.status = "planning";
      task.state.planMode = {
        active: true,
        feedbackRounds: 0,
        planningFolderCleared: false,
        isPlanReady: false,
      };
      // Plan mode skips git setup in start(), so we need to set the worktree path
      // manually (normally done by startPlanMode() before engine.start()).
      task.state.git = {
        originalBranch: "main",
        workingBranch: "test-a1b2c3d",
        worktreePath: testDir,
        commits: [],
      };

      const capturedPrompts: PromptInput[] = [];
      let callCount = 0;

      const baseMock = createMockBackend([]);
      let promptSent = false;
      mockBackend = {
        ...baseMock,
        async sendPromptAsync(_sessionId: string, prompt: PromptInput): Promise<void> {
          capturedPrompts.push(prompt);
          callCount++;
          promptSent = true;
        },
        async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
          const { stream, push, end } = createEventStream<AgentEvent>();

          (async () => {
            let attempts = 0;
            while (!promptSent && attempts < 100) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              attempts++;
            }
            promptSent = false;

            if (callCount === 1) {
              // First iteration: error
              push({ type: "error", message: "Rate limit exceeded" });
              end();
            } else {
              // Second and subsequent iterations: succeed with PLAN_READY
              push({ type: "message.start", messageId: `msg-${Date.now()}` });
              push({ type: "message.delta", content: "Plan created\n<promise>PLAN_READY</promise>" });
              push({ type: "message.complete", content: "Plan created\n<promise>PLAN_READY</promise>" });
              end();
            }
          })();

          return stream;
        },
      };

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      // Start the task - first iteration errors, second returns plan_ready
      await engine.start();

      // Should have captured 2 prompts (error + retry that returned plan_ready)
      expect(capturedPrompts.length).toBe(2);

      // Second prompt should have had error context (retry after error)
      const secondPromptText = capturedPrompts[1]!.parts[0]!;
      if (secondPromptText.type === "text") {
        expect(secondPromptText.text).toContain("Previous Iteration Error");
        expect(secondPromptText.text).toContain("Rate limit exceeded");
      }

      // Verify consecutiveErrors was cleared by plan_ready outcome
      expect(task.state.consecutiveErrors).toBeUndefined();

      // Now simulate a plan feedback round: set pending prompt and resume
      task.state.planMode!.isPlanReady = false;
      task.state.planMode!.feedbackRounds += 1;
      engine.setPendingPrompt("Please add more details to the plan");

      await engine.runPlanIteration();

      // Should have captured a 3rd prompt (feedback round)
      expect(capturedPrompts.length).toBe(3);

      // Third prompt (feedback round) should NOT contain stale error context
      const thirdPromptText = capturedPrompts[2]!.parts[0]!;
      expect(thirdPromptText.type).toBe("text");
      if (thirdPromptText.type === "text") {
        expect(thirdPromptText.text).not.toContain("Previous Iteration Error");
        expect(thirdPromptText.text).not.toContain("Rate limit exceeded");
        // It should contain the feedback
        expect(thirdPromptText.text).toContain("Please add more details to the plan");
      }
    });

    test("runPlanIteration clears stale interrupt flags before starting planning again", async () => {
      const task = createTestTask({ maxIterations: 5, planMode: true });
      task.state.status = "planning";
      task.state.planMode = {
        active: true,
        feedbackRounds: 0,
        planningFolderCleared: false,
        isPlanReady: false,
      };
      task.state.git = {
        originalBranch: "main",
        workingBranch: "test-a1b2c3d",
        worktreePath: testDir,
        commits: [],
      };

      const capturedPrompts: PromptInput[] = [];
      const baseMock = createMockBackend(["Plan created\n<promise>PLAN_READY</promise>"]);
      mockBackend = {
        ...baseMock,
        async sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void> {
          capturedPrompts.push(prompt);
          await baseMock.sendPromptAsync(sessionId, prompt);
        },
      };

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      const internalEngine = engine as unknown as {
        aborted: boolean;
        injectionPending: boolean;
      };
      internalEngine.aborted = true;
      internalEngine.injectionPending = true;
      engine.setPendingPrompt("Feedback after stale interruption");

      await engine.runPlanIteration();

      expect(internalEngine.aborted).toBe(false);
      expect(internalEngine.injectionPending).toBe(false);
      expect(capturedPrompts).toHaveLength(1);
      expect(task.state.planMode?.isPlanReady).toBe(true);
    });
  });

  describe("session recovery", () => {
    test("interruptActiveSession clears sessionId when force disconnect is requested on an already disconnected backend", async () => {
      const task = createTestTask();
      let abortCalled = false;

      mockBackend = {
        ...createMockBackend([]),
        isConnected(): boolean {
          return false;
        },
        async abortSession(_sessionId: string): Promise<void> {
          abortCalled = true;
        },
      };

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      const internalEngine = engine as unknown as {
        sessionId: string | null;
        interruptActiveSession: (options: {
          abortMessage: string;
          abortWarnMessage: string;
          forceDisconnect: boolean;
          markAborted?: boolean;
          disconnectMessage?: string;
          disconnectWarnMessage?: string;
        }) => Promise<void>;
      };

      internalEngine.sessionId = "stale-session";

      await internalEngine.interruptActiveSession({
        abortMessage: "Aborting backend session...",
        abortWarnMessage: "Failed to abort the backend session during stop",
        forceDisconnect: true,
      });

      expect(abortCalled).toBe(true);
      expect(internalEngine.sessionId).toBeNull();
    });

    test("reconnectSession recreates a missing persisted session", async () => {
      const task = createTestTask();
      task.state.status = "planning";
      task.state.planMode = {
        active: true,
        feedbackRounds: 1,
        planningFolderCleared: false,
        isPlanReady: true,
      };
      task.state.git = {
        originalBranch: "master",
        workingBranch: "test-task-a1b2c3d",
        worktreePath: testDir,
        commits: [],
      };
      task.state.session = {
        id: "stale-session",
        serverUrl: "ssh://example:22",
      };

      let connected = false;
      let createdSessionCount = 0;
      const lookedUpSessionIds: string[] = [];

      mockBackend = {
        ...createMockBackend([]),
        isConnected(): boolean {
          return connected;
        },
        async connect(_config: BackendConnectionConfig): Promise<void> {
          connected = true;
        },
        async createSession(options: CreateSessionOptions): Promise<AgentSession> {
          createdSessionCount += 1;
          return {
            id: `new-session-${createdSessionCount}`,
            title: options.title,
            createdAt: new Date().toISOString(),
          };
        },
        async getSession(sessionId: string): Promise<AgentSession | null> {
          lookedUpSessionIds.push(sessionId);
          return null;
        },
      } as TaskBackend;

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.reconnectSession();

      expect(lookedUpSessionIds).toEqual(["stale-session"]);
      expect(createdSessionCount).toBe(1);
      expect(engine.state.session?.id).toBe("new-session-1");
    });

    test("reconnectSession reconnects the backend before validating an in-memory session", async () => {
      const task = createTestTask();
      task.state.status = "planning";
      task.state.planMode = {
        active: true,
        feedbackRounds: 1,
        planningFolderCleared: false,
        isPlanReady: true,
      };
      task.state.git = {
        originalBranch: "master",
        workingBranch: "test-task-a1b2c3d",
        worktreePath: testDir,
        commits: [],
      };
      task.state.session = {
        id: "persisted-session",
        serverUrl: "ssh://example:22",
      };

      let connected = false;
      let connectCount = 0;
      const lookedUpSessionIds: string[] = [];

      mockBackend = {
        ...createMockBackend([]),
        isConnected(): boolean {
          return connected;
        },
        async connect(_config: BackendConnectionConfig): Promise<void> {
          connected = true;
          connectCount += 1;
        },
        async getSession(sessionId: string): Promise<AgentSession | null> {
          lookedUpSessionIds.push(sessionId);
          return {
            id: sessionId,
            title: "persisted",
            createdAt: new Date().toISOString(),
          };
        },
      } as TaskBackend;

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });
      const internalEngine = engine as unknown as { sessionId: string | null };
      internalEngine.sessionId = "persisted-session";

      await engine.reconnectSession();

      expect(connectCount).toBe(1);
      expect(lookedUpSessionIds).toEqual(["persisted-session"]);
      expect(engine.state.session?.id).toBe("persisted-session");
      expect(internalEngine.sessionId).toBe("persisted-session");
    });

    test("recreates the session and retries once on session-not-found prompt errors", async () => {
      const task = createTestTask();
      let connected = false;
      let createdSessionCount = 0;
      let pendingPromptSession: string | null = null;
      let streamAttempt = 0;
      const promptSessions: string[] = [];

      mockBackend = {
        ...createMockBackend([]),
        isConnected(): boolean {
          return connected;
        },
        async connect(_config: BackendConnectionConfig): Promise<void> {
          connected = true;
        },
        async createSession(options: CreateSessionOptions): Promise<AgentSession> {
          createdSessionCount += 1;
          return {
            id: `session-${createdSessionCount}`,
            title: options.title,
            createdAt: new Date().toISOString(),
          };
        },
        async sendPromptAsync(sessionId: string, _prompt: PromptInput): Promise<void> {
          promptSessions.push(sessionId);
          pendingPromptSession = sessionId;
        },
        async subscribeToEvents(sessionId: string): Promise<EventStream<AgentEvent>> {
          const { stream, push, end } = createEventStream<AgentEvent>();

          (async () => {
            let attempts = 0;
            while (pendingPromptSession !== sessionId && attempts < 100) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              attempts++;
            }
            pendingPromptSession = null;

            streamAttempt += 1;
            if (streamAttempt === 1) {
              push({ type: "error", message: `Session ${sessionId} not found` });
              end();
              return;
            }

            push({ type: "message.start", messageId: `msg-${Date.now()}` });
            push({ type: "message.delta", content: "Recovered response <promise>COMPLETE</promise>" });
            push({ type: "message.complete", content: "Recovered response <promise>COMPLETE</promise>" });
            end();
          })();

          return stream;
        },
      } as TaskBackend;

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      expect(promptSessions).toEqual(["session-1", "session-2"]);
      expect(engine.state.session?.id).toBe("session-2");
      expect(engine.state.status).toBe("completed");
    }, 10000);
  });

  describe("abortSessionOnly", () => {
    test("emits task.session_aborted event", async () => {
      const task = createTestTask();
      mockBackend = createMockBackend([]);

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      // Call abortSessionOnly
      await engine.abortSessionOnly("Test abort reason");

      // Verify the event was emitted
      const sessionAbortedEvents = emittedEvents.filter(
        (e) => e.type === "task.session_aborted"
      );
      expect(sessionAbortedEvents.length).toBe(1);
      
      const event = sessionAbortedEvents[0]!;
      expect(event.type).toBe("task.session_aborted");
      if (event.type === "task.session_aborted") {
        expect(event.taskId).toBe(task.config.id);
        expect(event.reason).toBe("Test abort reason");
        expect(event.timestamp).toBeDefined();
      }
    });

    test("uses default reason when not provided", async () => {
      const task = createTestTask();
      mockBackend = createMockBackend([]);

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      // Call abortSessionOnly without reason
      await engine.abortSessionOnly();

      // Verify the event was emitted with default reason
      const sessionAbortedEvents = emittedEvents.filter(
        (e) => e.type === "task.session_aborted"
      );
      expect(sessionAbortedEvents.length).toBe(1);
      
      const event = sessionAbortedEvents[0]!;
      if (event.type === "task.session_aborted") {
        expect(event.reason).toBe("Connection reset requested");
      }
    });

    test("does not change task status", async () => {
      const task = createTestTask();
      // Set status to planning
      task.state.status = "planning";
      mockBackend = createMockBackend([]);

      const engine = new TaskEngine({
        task,
        backend: mockBackend,
        gitService,
        eventEmitter: emitter,
      });

      // Verify initial status
      expect(engine.state.status).toBe("planning");

      // Call abortSessionOnly
      await engine.abortSessionOnly();

      // Verify status is unchanged
      expect(engine.state.status).toBe("planning");
      
      // Verify no task.stopped event was emitted
      const stoppedEvents = emittedEvents.filter((e) => e.type === "task.stopped");
      expect(stoppedEvents.length).toBe(0);
    });
  });

  // ==========================================================================
  // Reasoning delta accumulation tests
  // ==========================================================================

  describe("reasoning delta accumulation", () => {
    /**
     * Creates a mock backend that yields a custom event sequence.
     * The events factory receives a push function and must call end() when done.
     */
    function createEventSequenceBackend(
      eventFactory: (push: (event: AgentEvent) => void, end: () => void) => void,
    ): TaskBackend {
      let promptSent = false;
      const baseMock = createMockBackend([]);
      return {
        ...baseMock,
        async sendPromptAsync(): Promise<void> {
          promptSent = true;
        },
        async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
          const { stream, push, end } = createEventStream<AgentEvent>();
          (async () => {
            let attempts = 0;
            while (!promptSent && attempts < 100) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              attempts++;
            }
            promptSent = false;
            eventFactory(push, end);
          })();
          return stream;
        },
      };
    }

    test("accumulates reasoning deltas into a single log entry without duplication", async () => {
      const task = createTestTask({ maxIterations: 1 });
      const backend = createEventSequenceBackend((push, end) => {
        push({ type: "message.start", messageId: "msg-1" });
        push({ type: "reasoning.delta", content: "Let me " });
        push({ type: "reasoning.delta", content: "think about " });
        push({ type: "reasoning.delta", content: "this." });
        push({ type: "message.delta", content: "Here is my response." });
        push({ type: "message.complete", content: "Here is my response." });
        end();
      });

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      // Find reasoning log events
      const logEvents = emittedEvents.filter(
        (e) => e.type === "task.log" && (e as { details?: Record<string, unknown> }).details?.["logKind"] === "reasoning",
      );

      // All reasoning deltas should update the SAME log entry (same ID)
      const logIds = new Set(logEvents.map((e) => (e as { id: string }).id));
      expect(logIds.size).toBe(1);

      // The final log event should have the fully accumulated content
      const lastReasoningLog = logEvents[logEvents.length - 1] as {
        details?: Record<string, unknown>;
      };
      expect(lastReasoningLog.details?.["responseContent"]).toBe("Let me think about this.");
    });

    test("uses the completion payload for the final assistant message instead of accumulated deltas", async () => {
      const task = createTestTask({
        maxIterations: Number.POSITIVE_INFINITY,
        stopPattern: "Omega$",
      });
      const backend = createEventSequenceBackend((push, end) => {
        push({ type: "message.start", messageId: "msg-1" });
        push({ type: "message.delta", content: "Alpha" });
        push({ type: "message.delta", content: "Omega" });
        push({ type: "message.complete", content: "Omega" });
        end();
      });

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      const assistantMessages = engine.state.messages.filter((message) => message.role === "assistant");
      expect(assistantMessages.map((message) => message.content)).toEqual(["Omega"]);

      const responseLogs = engine.state.logs.filter((log) => log.details?.["logKind"] === "response");
      expect(responseLogs.map((log) => log.details?.["responseContent"])).toEqual(["Omega"]);
      expect(engine.state.status).toBe("completed");
    });

    test("uses the latest post-tool response segment when completion payload is empty", async () => {
      const task = createTestTask({
        maxIterations: Number.POSITIVE_INFINITY,
        stopPattern: "CLANKY_DONE_MARKER$",
      });
      const backend = createEventSequenceBackend((push, end) => {
        push({ type: "message.start", messageId: "msg-1" });
        push({ type: "message.delta", content: "I’m checking the repo first." });
        push({ type: "tool.start", toolCallId: "tool-1", toolName: "read", input: { path: "README.md" } });
        push({ type: "tool.complete", toolCallId: "tool-1", toolName: "read", output: "README contents" });
        push({ type: "message.delta", content: "I made the change." });
        push({ type: "tool.start", toolCallId: "tool-2", toolName: "edit", input: { path: "README.md" } });
        push({ type: "tool.complete", toolCallId: "tool-2", toolName: "edit", output: "ok" });
        push({ type: "message.delta", content: "Done. CLANKY_DONE_MARKER" });
        push({ type: "message.complete", content: "" });
        end();
      });

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      const assistantMessages = engine.state.messages.filter((message) => message.role === "assistant");
      expect(assistantMessages.map((message) => message.content)).toEqual(["Done. CLANKY_DONE_MARKER"]);

      const responseLogs = engine.state.logs.filter((log) => log.details?.["logKind"] === "response");
      expect(responseLogs.map((log) => log.details?.["responseContent"])).toEqual([
        "I’m checking the repo first.",
        "I made the change.",
        "Done. CLANKY_DONE_MARKER",
      ]);
      expect(engine.state.status).toBe("completed");
    });

    test("starts fresh reasoning log after message.complete", async () => {
      // Use 2 iterations: first completes, second triggers new reasoning
      const task = createTestTask({ maxIterations: 2 });
      let iteration = 0;
      const backend = createEventSequenceBackend((push, end) => {
        iteration++;
        if (iteration === 1) {
          push({ type: "message.start", messageId: "msg-1" });
          push({ type: "reasoning.delta", content: "First thinking" });
          push({ type: "message.delta", content: "First response." });
          push({ type: "message.complete", content: "First response." });
        } else {
          push({ type: "message.start", messageId: "msg-2" });
          push({ type: "reasoning.delta", content: "Second thinking" });
          push({ type: "message.delta", content: "<promise>COMPLETE</promise>" });
          push({ type: "message.complete", content: "<promise>COMPLETE</promise>" });
        }
        end();
      });

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      // Collect all reasoning log events
      const logEvents = emittedEvents.filter(
        (e) => e.type === "task.log" && (e as { details?: Record<string, unknown> }).details?.["logKind"] === "reasoning",
      );

      // Should have events from two separate reasoning blocks (different IDs)
      const logIds = new Set(logEvents.map((e) => (e as { id: string }).id));
      expect(logIds.size).toBe(2);

      // Each block should have its own content (not merged/duplicated)
      const contents = [...logIds].map((id) => {
        const events = logEvents.filter((e) => (e as { id: string }).id === id);
        const last = events[events.length - 1] as { details?: Record<string, unknown> };
        return last.details?.["responseContent"];
      });
      expect(contents).toContain("First thinking");
      expect(contents).toContain("Second thinking");
    });

    test("starts fresh reasoning log after tool.start", async () => {
      const task = createTestTask({ maxIterations: 1 });
      const backend = createEventSequenceBackend((push, end) => {
        push({ type: "message.start", messageId: "msg-1" });
        push({ type: "reasoning.delta", content: "Before tool" });
        push({ type: "tool.start", toolName: "bash", input: { command: "ls" } });
        push({ type: "tool.complete", toolName: "bash", output: "file.txt" });
        push({ type: "reasoning.delta", content: "After tool" });
        push({ type: "message.delta", content: "<promise>COMPLETE</promise>" });
        push({ type: "message.complete", content: "<promise>COMPLETE</promise>" });
        end();
      });

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      // Collect all reasoning log events
      const logEvents = emittedEvents.filter(
        (e) => e.type === "task.log" && (e as { details?: Record<string, unknown> }).details?.["logKind"] === "reasoning",
      );

      // Should have two separate reasoning blocks (tool.start resets reasoning tracking)
      const logIds = new Set(logEvents.map((e) => (e as { id: string }).id));
      expect(logIds.size).toBe(2);

      // Each block should have its own content
      const contents = [...logIds].map((id) => {
        const events = logEvents.filter((e) => (e as { id: string }).id === id);
        const last = events[events.length - 1] as { details?: Record<string, unknown> };
        return last.details?.["responseContent"];
      });
      expect(contents).toContain("Before tool");
      expect(contents).toContain("After tool");
    });

    test("keeps repeated same-name tool calls attached to their own outputs", async () => {
      const task = createTestTask({ maxIterations: 1 });
      const backend = createEventSequenceBackend((push, end) => {
        push({ type: "message.start", messageId: "msg-1" });
        push({ type: "tool.start", toolCallId: "tool-view-a", toolName: "view", input: { path: "/workspace/repo/a.ts", view_range: [1, 20] } });
        push({ type: "tool.start", toolCallId: "tool-view-b", toolName: "view", input: { path: "/workspace/repo/b.ts", view_range: [1, 20] } });
        push({
          type: "tool.complete",
          toolCallId: "tool-view-a",
          toolName: "view",
          input: { path: "/workspace/repo/a.ts", view_range: [1, 20] },
          output: { content: "contents from a.ts" },
        });
        push({
          type: "tool.complete",
          toolCallId: "tool-view-b",
          toolName: "view",
          input: { path: "/workspace/repo/b.ts", view_range: [1, 20] },
          output: { content: "contents from b.ts" },
        });
        push({ type: "message.delta", content: "<promise>COMPLETE</promise>" });
        push({ type: "message.complete", content: "<promise>COMPLETE</promise>" });
        end();
      });

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      const summarizedToolCalls = engine.state.toolCalls
        .map((toolCall) => ({
          path: (toolCall.input as { path?: string }).path,
          status: toolCall.status,
          output: (toolCall.output as { content?: string } | undefined)?.content,
        }))
        .sort((left, right) => String(left.path).localeCompare(String(right.path)));

      expect(summarizedToolCalls).toEqual([
        {
          path: "/workspace/repo/a.ts",
          status: "completed",
          output: "contents from a.ts",
        },
        {
          path: "/workspace/repo/b.ts",
          status: "completed",
          output: "contents from b.ts",
        },
      ]);
    });

    test("message.start resets reasoning tracking for next message", async () => {
      const task = createTestTask({ maxIterations: 1 });
      const backend = createEventSequenceBackend((push, end) => {
        push({ type: "message.start", messageId: "msg-1" });
        push({ type: "reasoning.delta", content: "Reasoning block A" });
        push({ type: "message.delta", content: "Response text" });
        push({ type: "message.complete", content: "Response text" });
        end();
      });

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      // Find reasoning logs
      const logEvents = emittedEvents.filter(
        (e) => e.type === "task.log" && (e as { details?: Record<string, unknown> }).details?.["logKind"] === "reasoning",
      );

      // All reasoning deltas within one message should have the same log ID
      const logIds = new Set(logEvents.map((e) => (e as { id: string }).id));
      expect(logIds.size).toBe(1);

      // Content should be exactly the deltas, no duplication
      const lastLog = logEvents[logEvents.length - 1] as { details?: Record<string, unknown> };
      expect(lastLog.details?.["responseContent"]).toBe("Reasoning block A");
    });
  });
});
