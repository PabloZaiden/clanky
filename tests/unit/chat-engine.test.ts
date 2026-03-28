/**
 * Unit tests for LoopEngine chat mode behavior.
 * Tests single-turn execution, chat prompt building, stop pattern skipping,
 * and chat message injection (both while running and while idle).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  LoopEngine,
  type LoopBackend,
} from "../../src/core/loop-engine";
import { SimpleEventEmitter } from "../../src/core/event-emitter";
import type { Loop, LoopConfig, LoopState } from "../../src/types/loop";
import { DEFAULT_LOOP_CONFIG } from "../../src/types/loop";
import type { LoopEvent, LoopMessageEvent } from "../../src/types/events";
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
import type { MessageImageAttachment } from "../../src/types/message-attachments";

type MockLoopBackend = LoopBackend & { sentPrompts: PromptInput[] };

describe("LoopEngine - Chat Mode", () => {
  const sampleAttachment: MessageImageAttachment = {
    id: "img-1",
    filename: "screen.png",
    mimeType: "image/png",
    data: "ZmFrZQ==",
    size: 1234,
  };
  let testDir: string;
  let mockBackend: MockLoopBackend;
  let emitter: SimpleEventEmitter<LoopEvent>;
  let emittedEvents: LoopEvent[];
  let gitService: GitService;

  /**
   * Create a mock backend that supports async streaming.
   * Tracks prompts sent for assertion.
   */
  function createMockBackend(responses: string[]): MockLoopBackend {
    let responseIndex = 0;
    let connected = false;
    let pendingResponse: string | null = null;
    const sentPrompts: PromptInput[] = [];

    const backend: MockLoopBackend = {
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

      async abortSession(_sessionId: string): Promise<void> {
        // Mark as aborted
      },

      async subscribeToEvents(_sessionId: string): Promise<EventStream<AgentEvent>> {
        const { stream, push, end } = createEventStream<AgentEvent>();

        (async () => {
          // Wait for sendPromptAsync to set pendingResponse
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
        // No-op
      },

      async replyToQuestion(_requestId: string, _answers: string[][]): Promise<void> {
        // No-op
      },

      async setConfigOption(_sessionId: string, _configId: string, _value: string) {
        return [];
      },
      async setSessionModel(_sessionId: string, _modelId: string) {},
    };

    return backend;
  }

  function createChatLoop(overrides?: Partial<LoopConfig>): Loop {
    const config: LoopConfig = {
      id: "test-chat-123",
      name: "test-chat",
      directory: testDir,
      prompt: "Hello, how are you?",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceId: "test-workspace-id",
      model: { providerID: "test-provider", modelID: "test-model" },
      stopPattern: "<promise>COMPLETE</promise>$",
      git: { branchPrefix: "", commitScope: "" },
      maxIterations: 1,
      maxConsecutiveErrors: 10,
      activityTimeoutSeconds: DEFAULT_LOOP_CONFIG.activityTimeoutSeconds,
      useWorktree: DEFAULT_LOOP_CONFIG.useWorktree,
      clearPlanningFolder: false,
      planMode: false,
      mode: "chat",
      ...overrides,
    };

    const state: LoopState = {
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
    testDir = await mkdtemp(join(tmpdir(), "chat-engine-test-"));
    emittedEvents = [];
    emitter = new SimpleEventEmitter<LoopEvent>();
    emitter.subscribe((event) => emittedEvents.push(event));

    const executor = new TestCommandExecutor();
    gitService = new GitService(executor);

    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
    backendManager.enableTestMode();

    await Bun.$`git -C ${testDir} init`.quiet();
    await Bun.$`git -C ${testDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testDir} config user.name "Test User"`.quiet();
    await writeFile(join(testDir, ".gitkeep"), "");
    await Bun.$`git -C ${testDir} add .`.quiet();
    await Bun.$`git -C ${testDir} commit -m "Initial commit"`.quiet();
  });

  afterEach(async () => {
    backendManager.resetForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  test("isChatMode returns true for chat mode loops", () => {
    const loop = createChatLoop();
    mockBackend = createMockBackend([]);

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    expect(engine.isChatMode).toBe(true);
  });

  test("isChatMode returns false for loop mode loops", () => {
    const loop = createChatLoop({ mode: "loop" });
    mockBackend = createMockBackend([]);

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    expect(engine.isChatMode).toBe(false);
  });

  test("chat mode runs exactly one iteration and completes", async () => {
    const loop = createChatLoop();
    mockBackend = createMockBackend([
      "Here is my response to your question.",
    ]);

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.start();

    expect(engine.state.status).toBe("completed");
    expect(engine.state.currentIteration).toBe(1);

    // Should have exactly 1 iteration
    const iterationStartEvents = emittedEvents.filter((e) => e.type === "loop.iteration.start");
    expect(iterationStartEvents.length).toBe(1);

    const completedEvents = emittedEvents.filter((e) => e.type === "loop.completed");
    expect(completedEvents.length).toBe(1);
  });

  test("chat mode includes transient image attachments in the first prompt and user event", async () => {
    const loop = createChatLoop();
    mockBackend = createMockBackend([
      "Here is my response to your question.",
    ]);

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
      initialPromptAttachments: [sampleAttachment],
    });

    await engine.start();

    expect(mockBackend.sentPrompts[0]?.parts[0]).toMatchObject({
      type: "text",
    });
    expect(
      mockBackend.sentPrompts[0]?.parts[0]?.type === "text"
        ? mockBackend.sentPrompts[0].parts[0].text
        : "",
    ).toContain("Hello, how are you?");
    expect(mockBackend.sentPrompts[0]?.parts[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "ZmFrZQ==",
      filename: "screen.png",
    });

    const userMessageEvent = emittedEvents.find((event): event is LoopMessageEvent =>
      event.type === "loop.message" && event.message.role === "user",
    );
    expect(userMessageEvent?.message.attachments).toEqual([sampleAttachment]);
  });

  test("chat mode completes even when response contains COMPLETE pattern", async () => {
    // In chat mode, stop pattern detection is skipped entirely.
    // The outcome is always "complete" after one iteration, regardless of content.
    const loop = createChatLoop();
    mockBackend = createMockBackend([
      "Done! <promise>COMPLETE</promise>",
    ]);

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.start();

    expect(engine.state.status).toBe("completed");
    expect(engine.state.currentIteration).toBe(1);
  });

  test("chat mode does not auto-iterate even with maxIterations > 1", async () => {
    // Even if maxIterations allows more, chat mode stops after 1
    const loop = createChatLoop({ maxIterations: 10 });
    mockBackend = createMockBackend([
      "First response",
      "Second response (should not be reached)",
    ]);

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.start();

    expect(engine.state.status).toBe("completed");
    expect(engine.state.currentIteration).toBe(1);
  });

  test("chat prompt includes working directory context on first message", async () => {
    const loop = createChatLoop({ prompt: "What files are here?" });
    const backend = createMockBackend(["Here are your files..."]);
    mockBackend = backend;

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.start();

    // The first prompt sent should include the working directory context
    expect(backend.sentPrompts.length).toBeGreaterThanOrEqual(1);
    const firstPromptText = backend.sentPrompts[0]!.parts[0]!.type === "text"
      ? backend.sentPrompts[0]!.parts[0]!.text
      : "";
    expect(firstPromptText).toContain("You are working in directory:");
    expect(firstPromptText).toContain("What files are here?");
  });

  test("chat prompt does NOT include planning instructions", async () => {
    const loop = createChatLoop({ prompt: "Help me with this bug" });
    const backend = createMockBackend(["Fixed the bug."]);
    mockBackend = backend;

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.start();

    expect(backend.sentPrompts.length).toBeGreaterThanOrEqual(1);
    const firstPromptText = backend.sentPrompts[0]!.parts[0]!.type === "text"
      ? backend.sentPrompts[0]!.parts[0]!.text
      : "";

    // Should NOT contain loop-mode planning instructions
    expect(firstPromptText).not.toContain(".planning/plan.md");
    expect(firstPromptText).not.toContain("<promise>COMPLETE</promise>");
    expect(firstPromptText).not.toContain("never ask for input");
    expect(firstPromptText).not.toContain("PLAN_READY");
    expect(firstPromptText).not.toContain("Read AGENTS.md");
  });

  test("chat prompt uses pendingPrompt when set", async () => {
    const loop = createChatLoop({ prompt: "Initial prompt" });
    loop.state.pendingPrompt = "Follow-up question";
    const backend = createMockBackend(["Answer to follow-up."]);
    mockBackend = backend;

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.start();

    const firstPromptText = backend.sentPrompts[0]!.parts[0]!.type === "text"
      ? backend.sentPrompts[0]!.parts[0]!.text
      : "";
    expect(firstPromptText).toContain("Follow-up question");

    // pendingPrompt should be cleared after use
    expect(engine.state.pendingPrompt).toBeUndefined();
  });

  test("chat prompt supports model override via pendingModel", async () => {
    const loop = createChatLoop();
    const backend = createMockBackend(["Response with custom model."]);
    mockBackend = backend;

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Set pending model before start
    engine.setPendingModel({ providerID: "anthropic", modelID: "claude-3-opus" });

    await engine.start();

    // The prompt should have used the overridden model
    expect(backend.sentPrompts.length).toBeGreaterThanOrEqual(1);
    const usedModel = backend.sentPrompts[0]!.model;
    expect(usedModel?.providerID).toBe("anthropic");
    expect(usedModel?.modelID).toBe("claude-3-opus");

    // pendingModel should be cleared after use
    expect(engine.state.pendingModel).toBeUndefined();
  });

  test("injectChatMessage while running aborts and re-iterates", async () => {
    const loop = createChatLoop();

    // Create a controllable backend
    let sendPromptAsyncCalled = false;
    let abortCalled = false;
    let eventStreamCount = 0;
    let resolveEvents: (() => void) | undefined;
    const sentPrompts: PromptInput[] = [];

    const baseMock = createMockBackend([]);
    mockBackend = {
      ...baseMock,
      async sendPromptAsync(_sessionId: string, prompt: PromptInput): Promise<void> {
        sentPrompts.push(prompt);
        sendPromptAsyncCalled = true;
      },
      async abortSession(): Promise<void> {
        abortCalled = true;
        // Resolve the waiting events to let the iteration finish
        if (resolveEvents) resolveEvents();
      },
      async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
        const { stream, push, end } = createEventStream<AgentEvent>();
        eventStreamCount += 1;

        (async () => {
          if (eventStreamCount > 1) {
            push({ type: "message.start", messageId: `msg-${Date.now()}` });
            push({ type: "message.delta", content: "Replacement response" });
            push({ type: "message.complete", content: "Replacement response" });
            end();
            return;
          }

          // Wait for external signal or abort
          await new Promise<void>((resolve) => {
            resolveEvents = resolve;
          });

          // After abort/resolve, emit a minimal response
          push({ type: "message.start", messageId: `msg-${Date.now()}` });
          push({ type: "message.delta", content: "Interrupted" });
          push({ type: "message.complete", content: "Interrupted" });
          end();
        })();

        return stream;
      },
    };

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Start the engine (will block waiting for resolveEvents)
    const startPromise = engine.start();

    // Wait for the prompt to be sent
    while (!sendPromptAsyncCalled) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Inject a chat message while running
    await engine.injectChatMessage("New follow-up message");

    // The abort should have been called
    expect(abortCalled).toBe(true);

    // Wait for start to complete
    await startPromise;

    // The pending prompt should have been consumed by the second iteration
    // (chat mode runs 1 iteration per turn, so after injection we get another iteration)
    expect(engine.state.status).toBe("completed");
  }, 10000);

  test("injectChatMessage while running preserves the active session while replacing the turn", async () => {
    const loop = createChatLoop();

    let sendPromptAsyncCalled = false;
    let abortCalled = false;
    let connectCount = 0;
    let disconnectCount = 0;
    let createdSessionCount = 0;
    let eventStreamCount = 0;
    let resolveEvents: (() => void) | undefined;
    const sentPrompts: PromptInput[] = [];
    const promptSessionIds: string[] = [];

    const baseMock = createMockBackend(["First interrupted reply", "Second reply"]);
    mockBackend = {
      ...baseMock,
      async connect(config: BackendConnectionConfig): Promise<void> {
        connectCount += 1;
        await baseMock.connect(config);
      },
      async createSession(options: CreateSessionOptions): Promise<AgentSession> {
        createdSessionCount += 1;
        return {
          id: `session-${createdSessionCount}`,
          title: options.title,
          createdAt: new Date().toISOString(),
        };
      },
      async disconnect(): Promise<void> {
        disconnectCount += 1;
        resolveEvents?.();
        await baseMock.disconnect();
      },
      supportsActivePromptQueueing(): boolean {
        return true;
      },
      async sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void> {
        promptSessionIds.push(sessionId);
        sentPrompts.push(prompt);
        sendPromptAsyncCalled = true;
      },
      async abortSession(): Promise<void> {
        abortCalled = true;
        resolveEvents?.();
      },
      async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
        const { stream, push, end } = createEventStream<AgentEvent>();
        eventStreamCount += 1;

        (async () => {
          if (eventStreamCount > 1) {
            push({ type: "message.start", messageId: `msg-${Date.now()}` });
            push({ type: "message.delta", content: "Replacement response" });
            push({ type: "message.complete", content: "Replacement response" });
            end();
            return;
          }

          await new Promise<void>((resolve) => {
            resolveEvents = resolve;
          });

          push({ type: "error", message: "session cancelled" });
          end();
        })();

        return stream;
      },
    };

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    const startPromise = engine.start();

    while (!sendPromptAsyncCalled) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await engine.injectChatMessage("Stop and replace this response");

    expect(abortCalled).toBe(true);
    expect(disconnectCount).toBe(0);

    await startPromise;

    expect(engine.state.status).toBe("completed");
    expect(connectCount).toBe(1);
    expect(promptSessionIds).toEqual(["session-1", "session-1"]);
    expect(engine.state.session?.id).toBe("session-1");
    expect(sentPrompts).toHaveLength(2);
    const secondPromptText = sentPrompts[1]?.parts[0]?.type === "text"
      ? sentPrompts[1].parts[0].text
      : "";
    expect(secondPromptText).toContain("Stop and replace this response");
  }, 10000);

  test("injectChatMessage continues into the replacement turn when the active stream is closed early", async () => {
    const loop = createChatLoop();

    let connectCount = 0;
    let disconnectCount = 0;
    let abortCalled = false;
    let eventStreamCount = 0;
    let sendPromptAsyncCalled = false;
    const sentPrompts: PromptInput[] = [];

    const baseMock = createMockBackend([]);
    mockBackend = {
      ...baseMock,
      async connect(config: BackendConnectionConfig): Promise<void> {
        connectCount += 1;
        await baseMock.connect(config);
      },
      async disconnect(): Promise<void> {
        disconnectCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        await baseMock.disconnect();
      },
      async sendPromptAsync(_sessionId: string, prompt: PromptInput): Promise<void> {
        sentPrompts.push(prompt);
        sendPromptAsyncCalled = true;
      },
      async abortSession(): Promise<void> {
        abortCalled = true;
      },
      async subscribeToEvents(): Promise<EventStream<AgentEvent>> {
        eventStreamCount += 1;

        if (eventStreamCount === 1) {
          const { stream } = createEventStream<AgentEvent>();
          return stream;
        }

        const { stream, push, end } = createEventStream<AgentEvent>();
        push({ type: "message.start", messageId: `msg-${Date.now()}` });
        push({ type: "message.delta", content: "Replacement after closed stream" });
        push({ type: "message.complete", content: "Replacement after closed stream" });
        end();
        return stream;
      },
    };

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });
    const internalEngine = engine as unknown as {
      aborted: boolean;
      injectionPending: boolean;
    };

    const startPromise = engine.start();

    while (!sendPromptAsyncCalled) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await engine.injectChatMessage("Replacement after closed stream");

    expect(abortCalled).toBe(true);
    expect(disconnectCount).toBe(0);

    await startPromise;

    expect(engine.state.status).toBe("completed");
    expect(connectCount).toBe(1);
    expect(sentPrompts).toHaveLength(2);
    expect(internalEngine.aborted).toBe(false);
    expect(internalEngine.injectionPending).toBe(false);
    const secondPromptText = sentPrompts[1]?.parts[0]?.type === "text"
      ? sentPrompts[1].parts[0].text
      : "";
    expect(secondPromptText).toContain("Replacement after closed stream");
  }, 10000);

  test("completed chat follow-up handoff clears injectionPending before the next turn starts", async () => {
    const loop = createChatLoop();
    mockBackend = createMockBackend([]);

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    const internalEngine = engine as unknown as {
      aborted: boolean;
      injectionPending: boolean;
      handleCompletedOutcome: () => Promise<boolean>;
    };

    loop.state.status = "running";
    loop.state.currentIteration = 1;
    loop.state.pendingPrompt = "Follow-up message";
    internalEngine.aborted = true;
    internalEngine.injectionPending = true;

    const shouldExit = await internalEngine.handleCompletedOutcome();

    expect(shouldExit).toBe(false);
    expect(internalEngine.aborted).toBe(false);
    expect(internalEngine.injectionPending).toBe(false);
    expect(loop.state.currentIteration).toBe(0);
    expect(loop.state.completedAt).toBeUndefined();
  });

  test("injectChatMessage while idle starts new chat turn", async () => {
    const loop = createChatLoop();
    const backend = createMockBackend([
      "First response",
      "Second response to follow-up",
    ]);
    mockBackend = backend;

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Run first turn
    await engine.start();
    expect(engine.state.status).toBe("completed");
    expect(engine.state.currentIteration).toBe(1);

    // Now inject a message while idle — this should start a new turn
    await engine.injectChatMessage("Follow-up question");

    // Wait for the new turn to complete (fire-and-forget pattern)
    let attempts = 0;
    while (engine.state.currentIteration < 1 || engine.state.status === "running" || engine.state.status === "starting") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      attempts++;
      if (attempts > 100) {
        throw new Error("Timed out waiting for chat turn to complete");
      }
    }

    // Should have completed the second turn
    expect(engine.state.status).toBe("completed");
    // The turn resets currentIteration, so it should be 1 (one iteration per turn)
    expect(engine.state.currentIteration).toBe(1);

    // The second prompt should contain the follow-up question
    const secondPromptText = backend.sentPrompts[1]?.parts[0]?.type === "text"
      ? backend.sentPrompts[1]?.parts[0]?.text
      : undefined;
    expect(secondPromptText).toContain("Follow-up question");
  }, 10000);

  test("injectChatMessage with model override applies the model", async () => {
    const loop = createChatLoop();
    const backend = createMockBackend([
      "First response",
      "Response with new model",
    ]);
    mockBackend = backend;

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    // Run first turn
    await engine.start();
    expect(engine.state.status).toBe("completed");

    // Inject with model override
    await engine.injectChatMessage("Use a different model", {
      providerID: "openai",
      modelID: "gpt-4o",
    });

    // Wait for turn to complete
    let attempts = 0;
    while (engine.state.status === "running" || engine.state.status === "starting" || engine.state.status === "stopped") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      attempts++;
      if (attempts > 100) {
        throw new Error("Timed out waiting for chat turn to complete");
      }
    }

    expect(engine.state.status).toBe("completed");

    // The second prompt should use the overridden model
    const secondPrompt = backend.sentPrompts[1];
    expect(secondPrompt?.model?.providerID).toBe("openai");
    expect(secondPrompt?.model?.modelID).toBe("gpt-4o");
  }, 10000);

  test("chat mode emits user message for injected chat message", async () => {
    const loop = createChatLoop({ prompt: "Initial message" });
    // Set pendingPrompt to simulate an injected follow-up message
    loop.state.pendingPrompt = "What is TypeScript?";
    mockBackend = createMockBackend(["TypeScript is a typed superset of JavaScript."]);

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.start();

    // Check that a loop.message event with role "user" was emitted
    const userMessageEvents = emittedEvents.filter(
      (e): e is LoopMessageEvent => e.type === "loop.message" && e.message.role === "user"
    );
    expect(userMessageEvents.length).toBeGreaterThanOrEqual(1);
    expect(userMessageEvents[0]!.message.content).toBe("What is TypeScript?");
  });

  test("loop mode still auto-iterates normally (regression check)", async () => {
    // Ensure loop mode behavior is unchanged
    const config: LoopConfig = {
      id: "test-loop-regression",
      name: "test-loop",
      directory: testDir,
      prompt: "Do something",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceId: "test-workspace-id",
      model: { providerID: "test-provider", modelID: "test-model" },
      stopPattern: "<promise>COMPLETE</promise>$",
      git: { branchPrefix: "", commitScope: "" },
      maxIterations: 5,
      maxConsecutiveErrors: 10,
      activityTimeoutSeconds: DEFAULT_LOOP_CONFIG.activityTimeoutSeconds,
      useWorktree: DEFAULT_LOOP_CONFIG.useWorktree,
      clearPlanningFolder: false,
      planMode: false,
      mode: "loop",
    };

    const state: LoopState = {
      id: config.id,
      status: "idle",
      currentIteration: 0,
      recentIterations: [],
      logs: [],
      messages: [],
      toolCalls: [],
    };

    const loop: Loop = { config, state };
    mockBackend = createMockBackend([
      "Working...",
      "Still working...",
      "Done! <promise>COMPLETE</promise>",
    ]);

    const engine = new LoopEngine({
      loop,
      backend: mockBackend,
      gitService,
      eventEmitter: emitter,
    });

    await engine.start();

    // Loop mode should auto-iterate until stop pattern
    expect(engine.state.status).toBe("completed");
    expect(engine.state.currentIteration).toBe(3);
  });
});
