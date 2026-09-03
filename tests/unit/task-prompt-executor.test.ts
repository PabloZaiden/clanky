import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../../src/backends/types";
import { AgentEventTranscriptInterpreter } from "../../src/core/agent-event-transcript-interpreter";
import { TaskPersistenceCoordinator } from "../../src/core/engine/engine-persistence";
import { TaskPromptExecutorImpl } from "../../src/core/engine/engine-prompt-executor";
import type {
  IterationContext,
  TaskSessionLifecycle,
} from "../../src/core/engine/engine-types";
import { DEFAULT_TASK_CONFIG, type TaskConfig, type TaskState } from "@/shared/task";
import { NeverCompletingMockBackend } from "../mocks/mock-backend";

function createTaskConfig(): TaskConfig {
  const now = new Date().toISOString();
  return {
    ...DEFAULT_TASK_CONFIG,
    id: "inactivity-task",
    name: "Inactivity task",
    directory: "/tmp/inactivity-task",
    prompt: "Wait for the response",
    workspaceId: "workspace-1",
    model: {
      providerID: "test-provider",
      modelID: "test-model",
      variant: "",
    },
    activityTimeoutSeconds: 0,
    createdAt: now,
    updatedAt: now,
    mode: "task",
  };
}

function createTaskState(): TaskState {
  const timestamp = new Date().toISOString();
  return {
    id: "inactivity-task",
    status: "running",
    currentIteration: 1,
    messages: [],
    logs: [],
    toolCalls: [
      {
        id: "pending-tool",
        name: "Read",
        input: { filePath: "pending.txt" },
        status: "pending",
        timestamp,
      },
      {
        id: "running-tool",
        name: "Write",
        input: { filePath: "running.txt" },
        status: "running",
        timestamp,
      },
      {
        id: "completed-tool",
        name: "Read",
        status: "completed",
        output: "already complete",
        timestamp,
      },
      {
        id: "failed-tool",
        name: "Write",
        status: "failed",
        output: "already failed",
        timestamp,
      },
    ],
    recentIterations: [],
  };
}

function createSession(): TaskSessionLifecycle {
  return {
    sessionId: "session-1",
    isConnected: () => true,
    waitForInterrupt: async () => {},
    setup: async () => "session-1",
    reconnect: async () => ({
      sessionId: "session-1",
      reusedExisting: true,
      createdNew: false,
    }),
    ensureSession: async () => {},
    recreateAfterLoss: async () => "session-1",
    handlePendingModelChange: async () => {},
    consumeSessionRecovery: () => false,
    interruptSession: async () => {},
  };
}

function createIterationContext(): IterationContext {
  return {
    iteration: 2,
    transcript: new AgentEventTranscriptInterpreter(),
    outcome: "continue",
    error: undefined,
    errorCode: undefined,
  };
}

describe("TaskPromptExecutor inactivity", () => {
  test("treats an inactive ACP stream as a completed prompt turn", async () => {
    const state = createTaskState();
    const logs: string[] = [];
    const persistedToolCallSnapshots: TaskState["toolCalls"][] = [];
    let retryResetCount = 0;
    const persistence = new TaskPersistenceCoordinator({
      state,
      onPersistState: async (nextState) => {
        persistedToolCallSnapshots.push(nextState.toolCalls.map((toolCall) => ({ ...toolCall })));
      },
    });
    const executor = new TaskPromptExecutorImpl({
      backend: new NeverCompletingMockBackend(),
      session: createSession(),
      config: createTaskConfig(),
      state,
      getWorkingDirectory: () => "/tmp/inactivity-task",
      emitLog: (_level, message) => {
        logs.push(message);
        return `log-${logs.length}`;
      },
      updateState: (update) => Object.assign(state, update),
      processAgentEvent: async (event: AgentEvent) => ({
        event,
        timestamp: new Date().toISOString(),
        flushedBlocks: [],
        checkpointRequested: false,
      }),
      finalizeInFlightToolCalls: persistence.finalizeInFlightToolCalls.bind(persistence),
      triggerPersistence: persistence.trigger.bind(persistence),
      isAborted: () => false,
      isInjectionPending: () => false,
      resetIterationContextForRetry: () => {
        retryResetCount += 1;
      },
    });

    const result = await executor.execute(createIterationContext(), {
      buildPrompt: () => ({
        prompt: { parts: [{ type: "text", text: "hello" }] },
        promptMode: "engine_context",
      }),
    });

    expect(result.prompt.parts).toEqual([{ type: "text", text: "hello" }]);
    expect(logs).toContain("AI response stream ended after inactivity; treating the turn as complete");
    expect(retryResetCount).toBe(0);
    expect(state.error).toBeUndefined();
    expect([...state.toolCalls]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "pending-tool",
        status: "failed",
        output: "AI response stream ended after inactivity.",
      }),
      expect.objectContaining({
        id: "running-tool",
        status: "failed",
        output: "AI response stream ended after inactivity.",
      }),
      expect.objectContaining({
        id: "completed-tool",
        status: "completed",
        output: "already complete",
      }),
      expect.objectContaining({
        id: "failed-tool",
        status: "failed",
        output: "already failed",
      }),
    ]));
    expect(persistedToolCallSnapshots.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "pending-tool",
        status: "failed",
        output: "AI response stream ended after inactivity.",
      }),
      expect.objectContaining({
        id: "running-tool",
        status: "failed",
        output: "AI response stream ended after inactivity.",
      }),
    ]));
  });
});
