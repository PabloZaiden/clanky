/**
 * Unit tests for user message logging across all prompt types.
 * Verifies that emitUserMessage() is called correctly in
 * buildExecutionPrompt and buildPlanModePrompt,
 * and that user messages are persisted in task.state.messages
 * and emitted as task.message events with role "user".
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
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
  AgentEvent,
  BackendConnectionConfig,
  CreateSessionOptions,
  PromptInput,
} from "../../src/backends/types";
import { createEventStream, type EventStream } from "../../src/utils/event-stream";
import { GitService } from "../../src/core/git-service";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { backendManager } from "../../src/core/backend-manager";

describe("User Message Logging", () => {
  let testDir: string;
  let emitter: SimpleEventEmitter<TaskEvent>;
  let emittedEvents: TaskEvent[];
  let gitService: GitService;

  /**
   * Create a mock backend that captures prompts and delivers responses.
   */
  function createMockBackend(responses: string[]): TaskBackend & { sentPrompts: PromptInput[] } {
    let responseIndex = 0;
    let connected = false;
    let pendingResponse: string | null = null;
    const sentPrompts: PromptInput[] = [];

    const backend: TaskBackend & { sentPrompts: PromptInput[] } = {
      sentPrompts,

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
        return {
          id: `session-${Date.now()}`,
          title: options.title,
          createdAt: new Date().toISOString(),
        };
      },

      async sendPrompt(_sessionId: string, _prompt: PromptInput) {
        const content = responses[responseIndex] ?? "Default response";
        responseIndex++;
        return {
          id: `msg-${Date.now()}`,
          content,
          parts: [{ type: "text" as const, text: content }],
        };
      },

      async sendPromptAsync(_sessionId: string, prompt: PromptInput): Promise<void> {
        sentPrompts.push(prompt);
        const content = responses[responseIndex] ?? "Default response";
        responseIndex++;
        pendingResponse = content;
      },

      async abortSession(_sessionId: string): Promise<void> {},

      async subscribeToEvents(_sessionId: string): Promise<EventStream<AgentEvent>> {
        const { stream, push, end } = createEventStream<AgentEvent>();

        (async () => {
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

      async replyToPermission(_requestId: string, _response: string): Promise<void> {},
      async replyToQuestion(_requestId: string, _answers: string[][]): Promise<void> {},
      async setConfigOption(_sessionId: string, _configId: string, _value: string) { return []; },
      async setSessionModel(_sessionId: string, _modelId: string) {},
    };

    return backend;
  }

  function createTask(overrides?: Partial<TaskConfig>): Task {
    const config: TaskConfig = {
      id: "test-user-msg-task",
      name: "test-task",
      directory: testDir,
      prompt: "Build a REST API",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceId: "test-workspace-id",
      model: { providerID: "test-provider", modelID: "test-model", variant: "" },
      stopPattern: "<promise>COMPLETE</promise>$",
      git: { branchPrefix: "", commitScope: "" },
      maxIterations: 1,
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

  /** Helper to extract user message events from emitted events. */
  function getUserMessageEvents(): TaskMessageEvent[] {
    return emittedEvents.filter(
      (e): e is TaskMessageEvent =>
        e.type === "task.message" && "message" in e && e.message.role === "user"
    );
  }

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "user-msg-test-"));
    emittedEvents = [];
    emitter = new SimpleEventEmitter<TaskEvent>();
    emitter.subscribe((event) => emittedEvents.push(event));

    const executor = new TestCommandExecutor();
    gitService = new GitService(executor);

    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
    backendManager.enableTestMode();

    await Bun.$`git init`.cwd(testDir).quiet();
    await Bun.$`git config user.email "test@test.com"`.cwd(testDir).quiet();
    await Bun.$`git config user.name "Test User"`.cwd(testDir).quiet();
    await writeFile(join(testDir, ".gitkeep"), "");
    await Bun.$`git add .`.cwd(testDir).quiet();
    await Bun.$`git commit -m "Initial commit"`.cwd(testDir).quiet();
  });

  afterEach(async () => {
    backendManager.resetForTesting();
    await rm(testDir, { recursive: true });
  });

  // ─── Execution Mode ───────────────────────────────────────────────────────

  describe("execution mode", () => {
    test("first execution iteration logs config.prompt as user message", async () => {
      const task = createTask({
        mode: "task",
        prompt: "Build a REST API",
        maxIterations: 1,
      });
      const backend = createMockBackend(["Working on it... <promise>COMPLETE</promise>"]);

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      const userMsgEvents = getUserMessageEvents();
      expect(userMsgEvents.length).toBe(1);
      expect(userMsgEvents[0]!.message.content).toBe("Build a REST API");

      // Verify persisted
      const userMessages = task.state.messages?.filter((m) => m.role === "user");
      expect(userMessages?.length).toBe(1);
      expect(userMessages?.[0]?.content).toBe("Build a REST API");
    });

    test("injected message in execution mode is logged as user message", async () => {
      const task = createTask({
        mode: "task",
        prompt: "Original goal",
        maxIterations: 1,
      });
      task.state.pendingPrompt = "Please also add tests";
      const backend = createMockBackend(["Done. <promise>COMPLETE</promise>"]);

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      const userMsgEvents = getUserMessageEvents();
      expect(userMsgEvents.length).toBe(1);
      expect(userMsgEvents[0]!.message.content).toBe("Please also add tests");
    });

    test("injected messages from separate runs keep unique persisted IDs", async () => {
      const task = createTask({
        mode: "task",
        prompt: "Original goal",
        maxIterations: 1,
      });
      task.state.git = {
        originalBranch: "main",
        workingBranch: "test-a1b2c3d",
        worktreePath: testDir,
        commits: [],
      };
      task.state.pendingPrompt = "First injected message";
      const backend = createMockBackend([
        "Run one done <promise>COMPLETE</promise>",
        "Run two done <promise>COMPLETE</promise>",
      ]);

      const firstEngine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
        skipGitSetup: true,
      });
      await firstEngine.start();

      // Simulate jumpstart-like restart with a new injected message.
      task.state.status = "stopped";
      task.state.completedAt = undefined;
      task.state.pendingPrompt = "Second injected message";

      const secondEngine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
        skipGitSetup: true,
      });
      await secondEngine.start();

      const persistedUserMessages = (task.state.messages ?? []).filter((message) => message.role === "user");
      expect(persistedUserMessages.map((message) => message.content)).toEqual([
        "First injected message",
        "Second injected message",
      ]);
      expect(new Set(persistedUserMessages.map((message) => message.id)).size).toBe(2);
    });

    test("first execution uses deterministic 'initial-goal' ID suffix", async () => {
      const task = createTask({
        mode: "task",
        prompt: "Build something",
        maxIterations: 1,
      });
      const backend = createMockBackend(["Done. <promise>COMPLETE</promise>"]);

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      const userMsgEvents = getUserMessageEvents();
      expect(userMsgEvents.length).toBe(1);
      expect(userMsgEvents[0]!.message.id).toContain("initial-goal");
    });
  });

  // ─── Plan Mode ─────────────────────────────────────────────────────────────

  describe("plan mode", () => {
    test("initial plan creation logs config.prompt as user message", async () => {
      const task = createTask({
        mode: "task",
        prompt: "Design a login system",
        maxIterations: 1,
      });
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
      const backend = createMockBackend(["Here is my plan... <promise>PLAN_READY</promise>"]);

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      const userMsgEvents = getUserMessageEvents();
      expect(userMsgEvents.length).toBe(1);
      expect(userMsgEvents[0]!.message.content).toBe("Design a login system");
      expect(userMsgEvents[0]!.message.id).toContain("initial-goal");
    });

    test("plan feedback is logged as user message", async () => {
      const task = createTask({
        mode: "task",
        prompt: "Design a login system",
        maxIterations: 1,
      });
      // Set up plan mode with feedback round
      task.state.status = "planning";
      task.state.planMode = {
        active: true,
        feedbackRounds: 1,
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
      task.state.pendingPrompt = "Please add more detail to step 3";
      const backend = createMockBackend(["Updated plan... <promise>PLAN_READY</promise>"]);

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      const userMsgEvents = getUserMessageEvents();
      expect(userMsgEvents.length).toBe(1);
      expect(userMsgEvents[0]!.message.content).toBe("Please add more detail to step 3");
      expect(userMsgEvents[0]!.message.id).toContain("plan-feedback-1");
    });
  });

  // ─── Deduplication ─────────────────────────────────────────────────────────

  describe("deduplication", () => {
    test("user message uses deterministic ID for retry safety", async () => {
      const task = createTask({ mode: "task", prompt: "Test dedup", maxIterations: 1 });
      const backend = createMockBackend(["Response."]);

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      // The user message should have a deterministic ID based on task ID
      const userMessages = task.state.messages?.filter((m) => m.role === "user");
      expect(userMessages?.length).toBe(1);
      expect(userMessages?.[0]?.id).toContain("test-user-msg-task");
    });
  });

  // ─── Both user and assistant messages in conversation ─────────────────────

  describe("conversation flow", () => {
    test("task execution produces both user and assistant messages in order", async () => {
      const task = createTask({ mode: "task", prompt: "What is 2+2?", maxIterations: 1 });
      const backend = createMockBackend(["4"]);

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      // Should have both user and assistant messages
      const messages = task.state.messages ?? [];
      const userMsgs = messages.filter((m) => m.role === "user");
      const assistantMsgs = messages.filter((m) => m.role === "assistant");

      expect(userMsgs.length).toBe(1);
      expect(assistantMsgs.length).toBe(1);
      expect(userMsgs[0]!.content).toBe("What is 2+2?");
      expect(assistantMsgs[0]!.content).toBe("4");

      // User message should come before assistant message (by timestamp or array order)
      const userIdx = messages.findIndex((m) => m.role === "user");
      const assistantIdx = messages.findIndex((m) => m.role === "assistant");
      expect(userIdx).toBeLessThan(assistantIdx);
    });

    test("task.message events emitted for both user and assistant", async () => {
      const task = createTask({ mode: "task", prompt: "Tell me a joke", maxIterations: 1 });
      const backend = createMockBackend(["Why did the chicken cross the road?"]);

      const engine = new TaskEngine({
        task,
        backend,
        gitService,
        eventEmitter: emitter,
      });

      await engine.start();

      const messageEvents = emittedEvents.filter(
        (e): e is TaskMessageEvent => e.type === "task.message"
      );
      const userEvents = messageEvents.filter((e) => e.message.role === "user");
      const assistantEvents = messageEvents.filter((e) => e.message.role === "assistant");

      expect(userEvents.length).toBe(1);
      expect(assistantEvents.length).toBe(1);
    });
  });
});
