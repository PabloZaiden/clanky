/**
 * Unit tests for pending model and message functionality.
 * Tests the setPendingModel, clearPendingModel, setPending, and clearPending methods.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  TaskEngine,
  type TaskBackend,
} from "../../src/core/task-engine";
import { SimpleEventEmitter } from "../../src/core/event-emitter";
import type { Task, TaskConfig, TaskState } from "../../src/types/task";
import { DEFAULT_TASK_CONFIG } from "../../src/types/task";
import type { TaskEvent, TaskMessageEvent } from "../../src/types/events";
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

describe("TaskEngine Pending Model", () => {
  let testDir: string;
  let mockBackend: TaskBackend;
  let emitter: SimpleEventEmitter<TaskEvent>;
  let emittedEvents: TaskEvent[];
  let gitService: GitService;
  let capturedPrompts: PromptInput[];

  // Create a mock backend that captures prompts
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

      async sendPrompt(_sessionId: string, prompt: PromptInput): Promise<AgentResponse> {
        // Capture the prompt for inspection
        capturedPrompts.push(prompt);
        const content = responses[responseIndex] ?? "Default response";
        responseIndex++;
        return {
          id: `msg-${Date.now()}`,
          content,
          parts: [{ type: "text", text: content }],
        };
      },

      async sendPromptAsync(_sessionId: string, prompt: PromptInput): Promise<void> {
        capturedPrompts.push(prompt);
        pendingResponse = responses[responseIndex] ?? "Default response";
        responseIndex++;
      },

      async abortSession(_sessionId: string): Promise<void> {
        // Not used in tests
      },

      async subscribeToEvents(_sessionId: string): Promise<EventStream<AgentEvent>> {
        const { stream, push, end } = createEventStream<AgentEvent>();

        (async () => {
          // Wait a bit for sendPromptAsync to set pendingResponse
          await new Promise((resolve) => setTimeout(resolve, 10));
          const content = pendingResponse ?? "Default";
          pendingResponse = null;

          push({ type: "message.start", messageId: `msg-${Date.now()}` });
          push({ type: "message.delta", content });
          push({ type: "message.complete", content });
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
    const now = new Date().toISOString();
    const config: TaskConfig = {
      id: "test-task-1",
      name: "Test Task",
      directory: testDir,
      prompt: "Test prompt",
      createdAt: now,
      updatedAt: now,
      workspaceId: "test-workspace-id",
      stopPattern: "<promise>COMPLETE</promise>$",
      git: {
        branchPrefix: "",
        commitScope: "",
      },
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
        variant: "",
      },
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

  beforeEach(async () => {
    // Create test directory with git repo
    testDir = await mkdtemp(join(tmpdir(), "task-pending-test-"));
    const executor = new TestCommandExecutor();

    // Initialize git repo using Bun.$ (like the working tests do)
    await Bun.$`git init`.cwd(testDir).quiet();
    await Bun.$`git config user.email "test@test.com"`.cwd(testDir).quiet();
    await Bun.$`git config user.name "Test"`.cwd(testDir).quiet();
    await writeFile(join(testDir, "README.md"), "# Test");
    await Bun.$`git add .`.cwd(testDir).quiet();
    await Bun.$`git commit -m "Initial commit"`.cwd(testDir).quiet();

    // Create .clanky-planning directory
    await mkdir(join(testDir, ".clanky-planning"), { recursive: true });

    gitService = new GitService(executor);
    emitter = new SimpleEventEmitter<TaskEvent>();
    emittedEvents = [];
    capturedPrompts = [];
    mockBackend = createMockBackend(["Response 1", "Response 2", "<promise>COMPLETE</promise>"]);
    
    // Set up backendManager with test executor factory and enable test mode
    // so getWorkspaceSettings returns test settings instead of querying the database
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
    backendManager.enableTestMode();
    
    // Collect emitted events using subscribe (not on("*", ...))
    emitter.subscribe((event) => {
      emittedEvents.push(event);
    });
  });

  afterEach(async () => {
    backendManager.resetForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  test("setPendingModel stores the pending model", async () => {
    const task = createTestTask();
    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Set pending model
    engine.setPendingModel({ providerID: "openai", modelID: "gpt-4o", variant: "" });

    // Verify state was updated
    expect(task.state.pendingModel).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
      variant: "",
    });
  });

  test("setPendingModel emits task.pending.updated event", async () => {
    const task = createTestTask();
    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Set pending model
    engine.setPendingModel({ providerID: "openai", modelID: "gpt-4o", variant: "" });

    // Verify event was emitted
    const pendingEvents = emittedEvents.filter((e) => e.type === "task.pending.updated");
    expect(pendingEvents.length).toBe(1);
    expect(pendingEvents[0]).toMatchObject({
      type: "task.pending.updated",
      taskId: "test-task-1",
      pendingModel: { providerID: "openai", modelID: "gpt-4o", variant: "" },
    });
  });

  test("clearPendingModel removes the pending model", async () => {
    const task = createTestTask();
    task.state.pendingModel = { providerID: "openai", modelID: "gpt-4o", variant: "" };
    
    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Clear pending model
    engine.clearPendingModel();

    // Verify state was updated
    expect(task.state.pendingModel).toBeUndefined();
  });

  test("clearPending removes both pending model and prompt", async () => {
    const task = createTestTask();
    task.state.pendingModel = { providerID: "openai", modelID: "gpt-4o", variant: "" };
    task.state.pendingPrompt = "User message";
    
    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Clear all pending values
    engine.clearPending();

    // Verify state was updated
    expect(task.state.pendingModel).toBeUndefined();
    expect(task.state.pendingPrompt).toBeUndefined();
  });

  test("pendingModel is used in buildPrompt and then cleared", async () => {
    const task = createTestTask();
    // Set pending model before starting
    task.state.pendingModel = { providerID: "openai", modelID: "gpt-4o", variant: "" };
    
    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Start the engine (which will run one iteration using sendPrompt)
    await engine.start();

    // Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify the prompt used the pending model
    expect(capturedPrompts.length).toBeGreaterThan(0);
    expect(capturedPrompts[0]!.model).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
      variant: "",
    });

    // Verify pending model was cleared after use
    expect(task.state.pendingModel).toBeUndefined();
  });

  test("pendingModel updates config.model after being consumed", async () => {
    const task = createTestTask({
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", variant: "" },
    });
    // Set pending model before starting
    task.state.pendingModel = { providerID: "openai", modelID: "gpt-4o", variant: "" };
    
    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Start the engine
    await engine.start();

    // Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify config.model was updated to the new model
    expect(task.config.model).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
      variant: "",
    });
  });

  test("setPendingPrompt adds user message to prompt while preserving original goal", async () => {
    const task = createTestTask({ prompt: "Original prompt" });
    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Set pending prompt before starting
    engine.setPendingPrompt("Custom user message");

    // Start the engine
    await engine.start();

    // Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify the prompt text contains BOTH the original goal AND the custom message
    expect(capturedPrompts.length).toBeGreaterThan(0);
    const promptText = capturedPrompts[0]!.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("");
    
    // Should contain the original goal
    expect(promptText).toContain("Original Goal: Original prompt");
    
    // Should contain the user message as a separate section
    expect(promptText).toContain("User Message");
    expect(promptText).toContain("Custom user message");

    // Verify pending prompt was cleared
    expect(task.state.pendingPrompt).toBeUndefined();
  });

  test("prompt without pendingPrompt only shows original goal (no user message section)", async () => {
    const task = createTestTask({ prompt: "Original prompt only" });
    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Start the engine WITHOUT setting a pending prompt
    await engine.start();

    // Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify the prompt text contains the original goal but NOT a user message section
    expect(capturedPrompts.length).toBeGreaterThan(0);
    const promptText = capturedPrompts[0]!.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("");
    
    // Should contain the original goal
    expect(promptText).toContain("Original Goal: Original prompt only");
    
    // Should NOT contain a User Message section header
    expect(promptText).not.toContain("**User Message**");
  });

  test("injectPendingNow sets pending values and marks injection pending", async () => {
    const task = createTestTask();
    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Call injectPendingNow (without a running task, it should just set values)
    await engine.injectPendingNow({
      message: "Injected message",
      model: { providerID: "openai", modelID: "gpt-4o", variant: "" },
    });

    // Verify state was updated
    expect(task.state.pendingPrompt).toBe("Injected message");
    expect(task.state.pendingModel).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
      variant: "",
    });

    // Verify event was emitted
    const pendingEvents = emittedEvents.filter((e) => e.type === "task.pending.updated");
    expect(pendingEvents.length).toBe(1);
    expect(pendingEvents[0]).toMatchObject({
      type: "task.pending.updated",
      taskId: "test-task-1",
      pendingPrompt: "Injected message",
      pendingModel: { providerID: "openai", modelID: "gpt-4o", variant: "" },
    });
  });

  test("injectPendingNow with only message sets just the message", async () => {
    const task = createTestTask();
    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.injectPendingNow({ message: "Only message" });

    expect(task.state.pendingPrompt).toBe("Only message");
    expect(task.state.pendingModel).toBeUndefined();
  });

  test("injectPendingNow with only model sets just the model", async () => {
    const task = createTestTask();
    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.injectPendingNow({ model: { providerID: "openai", modelID: "gpt-4o", variant: "" } });

    expect(task.state.pendingPrompt).toBeUndefined();
    expect(task.state.pendingModel).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
      variant: "",
    });
  });

  test("injectPendingNow aborts the active session instead of queueing on it", async () => {
    const task = createTestTask();
    let abortCount = 0;
    const backend = createMockBackend(["Still working"]);
    backend.abortSession = async (_sessionId: string): Promise<void> => {
      abortCount += 1;
    };

    const engine = new TaskEngine({
      task,
      backend,
      gitService,
      eventEmitter: emitter,
    });
    const internalEngine = engine as unknown as {
      isTaskRunning: boolean;
      sessionId: string | null;
      injectionPending: boolean;
    };
    internalEngine.isTaskRunning = true;
    internalEngine.sessionId = "active-session";

    await engine.injectPendingNow({ message: "Replacement message" });

    expect(task.state.pendingPrompt).toBe("Replacement message");
    expect(abortCount).toBe(1);
    expect(internalEngine.injectionPending).toBe(true);
  });

  test("abort-fallback injection errors are consumed without leaving injectionPending stuck", async () => {
    const task = createTestTask();
    task.state.status = "running";
    task.state.currentIteration = 3;
    task.state.pendingPrompt = "Retry with queued input";
    task.state.consecutiveErrors = {
      lastErrorMessage: "old error",
      count: 2,
    };
    const engine = new TaskEngine({
      task,
      backend: createMockBackend(["Still working"]),
      gitService,
      eventEmitter: emitter,
    });
    const internalEngine = engine as unknown as {
      sessionId: string | null;
      injectionPending: boolean;
      aborted: boolean;
      handleErrorOutcome: (result: {
        continue: boolean;
        outcome: "error";
        responseContent: string;
        error?: string;
        messageCount: number;
        toolCallCount: number;
      }) => Promise<boolean>;
    };
    internalEngine.sessionId = "active-session";
    internalEngine.injectionPending = true;
    internalEngine.aborted = false;

    const shouldExit = await internalEngine.handleErrorOutcome({
      continue: false,
      outcome: "error",
      responseContent: "",
      error: "session cancelled",
      messageCount: 0,
      toolCallCount: 0,
    });

    expect(shouldExit).toBe(false);
    expect(task.state.currentIteration).toBe(2);
    expect(task.state.consecutiveErrors).toBeUndefined();
    expect(internalEngine.injectionPending).toBe(false);
    expect(internalEngine.aborted).toBe(false);
    expect(emittedEvents.some((event) => event.type === "task.error")).toBe(false);
  });

  test("runTask checks maxIterations before continuing after a normal iteration", async () => {
    const task = createTestTask({ maxIterations: 1 });
    task.state.status = "running";
    const engine = new TaskEngine({
      task,
      backend: createMockBackend(["Still working"]),
      gitService,
      eventEmitter: emitter,
    });
    const internalEngine = engine as unknown as {
      sessionId: string | null;
      runIteration: () => Promise<{
        continue: boolean;
        outcome: "continue";
        responseContent: string;
        messageCount: number;
        toolCallCount: number;
      }>;
      handleIterationOutcome: () => Promise<boolean>;
      hasReachedMaxIterations: () => Promise<boolean>;
      shouldContinue: () => boolean;
      runTask: () => Promise<void>;
    };
    const callOrder: string[] = [];
    internalEngine.sessionId = "active-session";
    internalEngine.runIteration = async () => {
      task.state.currentIteration = 1;
      return {
        continue: true,
        outcome: "continue",
        responseContent: "",
        messageCount: 0,
        toolCallCount: 0,
      };
    };
    internalEngine.handleIterationOutcome = async () => false;
    internalEngine.hasReachedMaxIterations = async () => {
      callOrder.push("max");
      task.state.status = "max_iterations";
      return true;
    };
    internalEngine.shouldContinue = () => true;

    await internalEngine.runTask();

    expect(callOrder).toEqual(["max"]);
    expect(String(task.state.status)).toBe("max_iterations");
  });

  test("pending message is persisted as user message when consumed", async () => {
    const task = createTestTask({ prompt: "Original prompt" });
    const engine = new TaskEngine({
      task,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Set pending prompt before starting
    engine.setPendingPrompt("User injected message for testing");

    // Start the engine
    await engine.start();

    // Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify a task.message event with role "user" was emitted containing the message
    const userMessageEvents = emittedEvents.filter(
      (e): e is TaskMessageEvent => e.type === "task.message" && e.message.role === "user"
    );
    expect(userMessageEvents.length).toBeGreaterThanOrEqual(1);
    const userMsg = userMessageEvents.find(
      (e) => e.message.content === "User injected message for testing"
    );
    expect(userMsg).toBeDefined();
    expect(userMsg!.message.role).toBe("user");

    // Verify the message is also persisted in the task state messages array
    const userMessages = task.state.messages?.filter((msg) => msg.role === "user");
    expect(userMessages?.length).toBeGreaterThanOrEqual(1);
    const persistedMsg = userMessages?.find((msg) => msg.content === "User injected message for testing");
    expect(persistedMsg).toBeDefined();
  });
});
