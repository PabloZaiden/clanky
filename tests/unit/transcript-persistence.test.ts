import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createTranscriptChangeSet,
  DEFAULT_TASK_CONFIG,
  type Task,
  type TaskLogEntry,
  type PersistedMessage,
  type PersistedToolCall,
  type Agent,
  type AgentRun,
  type Chat,
  createInitialChatState,
  DEFAULT_CHAT_CONFIG,
} from "@/shared";
import { AgentRunStreamPersistence } from "../../src/core/agent-run-stream-persistence";
import { TaskEngine } from "../../src/core/task-engine";
import { TranscriptMemoryIndex } from "../../src/core/transcript-memory-index";
import { loadAgentRun, saveAgent, saveAgentRun } from "../../src/persistence/agents";
import {
  loadTask,
  saveTask,
  updateTaskState,
} from "../../src/persistence/tasks";
import { getTranscriptMeta } from "../../src/persistence/transcripts/store";
import { runWithCurrentUser } from "../../src/core/user-context";
import {
  setupTestContext,
  teardownTestContext,
  testModel,
  testOwnerUser,
  testWorkspaceId,
  type TestContext,
} from "../setup";

function createTask(context: TestContext): Task {
  const now = new Date().toISOString();
  const message: PersistedMessage = {
    id: "message-1",
    role: "assistant",
    content: "unchanged message",
    timestamp: now,
  };
  const log: TaskLogEntry = {
    id: "log-1",
    level: "agent",
    message: "unchanged log",
    timestamp: now,
  };
  const tool: PersistedToolCall = {
    id: "tool-1",
    name: "read_file",
    input: { path: "README.md" },
    output: "before",
    status: "completed",
    timestamp: now,
  };

  return {
    config: {
      ...DEFAULT_TASK_CONFIG,
      id: "incremental-task",
      name: "Incremental task",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      prompt: "Run the task",
      model: testModel,
      createdAt: now,
      updatedAt: now,
    },
    state: {
      id: "incremental-task",
      status: "running",
      currentIteration: 1,
      recentIterations: [],
      messages: [message],
      logs: [log],
      toolCalls: [tool],
    },
  };
}

function createAgentRun(): AgentRun {
  const now = new Date().toISOString();
  return {
    id: "incremental-agent-run",
    agentId: "incremental-agent",
    status: "running",
    trigger: "manual",
    scheduledFor: now,
    startedAt: now,
    messages: [],
    logs: [],
    toolCalls: [],
    pendingPermissionRequests: [],
    configSnapshot: {
      name: "Incremental agent",
      workspaceId: testWorkspaceId,
      directory: "/tmp",
      prompt: "Run the agent",
      model: testModel,
      useWorktree: false,
      schedule: {
        startAtLocal: now.slice(0, 16),
        timezone: "UTC",
        interval: { value: 1, unit: "hours" },
        nextRunAt: now,
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

function createAgent(): Agent {
  const now = new Date().toISOString();
  return {
    config: {
      id: "incremental-agent",
      name: "Incremental agent",
      workspaceId: testWorkspaceId,
      directory: "/tmp",
      prompt: "Run the agent",
      model: testModel,
      useWorktree: false,
      schedule: {
        startAtLocal: now.slice(0, 16),
        timezone: "UTC",
        interval: { value: 1, unit: "hours" },
        nextRunAt: now,
      },
      enabled: true,
      createdAt: now,
      updatedAt: now,
      mode: "agent",
    },
    state: {
      id: "incremental-agent",
      status: "enabled",
    },
  };
}

describe("incremental transcript persistence", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestContext();
  });

  afterEach(async () => {
    await teardownTestContext(context);
  });

  test("updates one task entry without rebuilding the other transcript entries", async () => {
    const task = createTask(context);
    await runWithCurrentUser(testOwnerUser, async () => {
      await saveTask(task);

      const loaded = await loadTask(task.config.id);
      if (!loaded) {
        throw new Error("Expected task to load");
      }
      const originalTool = loaded.state.toolCalls[0];
      if (!originalTool) {
        throw new Error("Expected task tool call");
      }
      const updatedTool: PersistedToolCall = {
        ...originalTool,
        output: "after",
      };
      const nextState = {
        ...loaded.state,
        toolCalls: [updatedTool],
      };

      await updateTaskState(task.config.id, nextState, {
        transcriptChanges: createTranscriptChangeSet(nextState, [{
          id: updatedTool.id,
          kind: "tool",
          timestamp: updatedTool.timestamp,
          payload: updatedTool,
        }]),
      });

      const persisted = await loadTask(task.config.id);
      expect(persisted?.state.messages).toEqual(loaded.state.messages);
      expect(persisted?.state.logs).toEqual(loaded.state.logs);
      expect(persisted?.state.toolCalls[0]?.output).toBe("after");
      expect(getTranscriptMeta("task", task.config.id)?.entryCount).toBe(3);
    });
  });

  test("syncs transcript changes for legacy state updates without explicit change sets", async () => {
    const task = createTask(context);
    await runWithCurrentUser(testOwnerUser, async () => {
      await saveTask(task);
      const loaded = await loadTask(task.config.id);
      if (!loaded) {
        throw new Error("Expected task to load");
      }

      const newMessage: PersistedMessage = {
        id: "message-2",
        role: "user",
        content: "legacy state update",
        timestamp: new Date().toISOString(),
      };
      await updateTaskState(task.config.id, {
        ...loaded.state,
        messages: [...loaded.state.messages, newMessage],
      });

      const persisted = await loadTask(task.config.id);
      expect(persisted?.state.messages).toContainEqual(newMessage);
      expect(getTranscriptMeta("task", task.config.id)?.entryCount).toBe(4);
    });
  });

  test("evicts bounded transcript entries without changing their logical order", () => {
    const index = new TranscriptMemoryIndex([
      { id: "entry-1" },
      { id: "entry-2" },
    ], 2);

    index.upsert({ id: "entry-3" });
    index.upsert({ id: "entry-4" });

    expect(index.values.map((entry) => entry.id)).toEqual(["entry-3", "entry-4"]);
    expect(JSON.stringify(index.values)).toBe('[{"id":"entry-3"},{"id":"entry-4"}]');
    expect(index.get("entry-1")).toBeUndefined();
    expect(index.get("entry-4")?.id).toBe("entry-4");
  });

  test("checkpoints agent-run deltas without waiting for stream completion", async () => {
    const run = createAgentRun();
    await runWithCurrentUser(testOwnerUser, async () => {
      await saveAgent(createAgent());
      await saveAgentRun(run, {
        transcriptChanges: {
          ...createTranscriptChangeSet(run),
          revision: `${run.updatedAt}:0`,
        },
      });
      const persistence = new AgentRunStreamPersistence(run);
      persistence.handleChatEvent({
        type: "chat.message.delta",
        chatId: "agent-chat",
        scope: "agent",
        messageId: "assistant-1",
        role: "assistant",
        delta: "checkpointed",
        baseLength: 0,
        contentLength: 11,
        messageTimestamp: run.updatedAt,
        timestamp: run.updatedAt,
      });
      await persistence.persist();

      const persisted = await loadAgentRun(run.id);
      expect(persisted?.messages).toEqual([{
        id: "assistant-1",
        role: "assistant",
        content: "checkpointed",
        timestamp: run.updatedAt,
      }]);
      expect(getTranscriptMeta("agent_run", run.id)?.entryCount).toBe(1);
    });
  });

  test("persists pending permissions from associated agent chat updates", async () => {
    const run = createAgentRun();
    const now = new Date().toISOString();
    const permission = {
      requestId: "permission-1",
      sessionId: "session-1",
      permission: "shell",
      patterns: ["git status"],
      status: "pending" as const,
      createdAt: now,
    };
    const chatState = createInitialChatState("agent-chat");
    chatState.status = "streaming";
    chatState.pendingPermissionRequests = [permission];
    const chat: Chat = {
      config: {
        ...DEFAULT_CHAT_CONFIG,
        id: "agent-chat",
        name: "Agent chat",
        workspaceId: testWorkspaceId,
        directory: "/tmp",
        model: testModel,
        scope: "agent",
        createdAt: now,
        updatedAt: now,
      },
      state: chatState,
    };

    await runWithCurrentUser(testOwnerUser, async () => {
      await saveAgent(createAgent());
      await saveAgentRun(run, {
        transcriptChanges: {
          ...createTranscriptChangeSet(run),
          revision: `${run.updatedAt}:0`,
        },
      });
      const persistence = new AgentRunStreamPersistence(run);
      persistence.handleChatEvent({
        type: "chat.updated",
        chatId: chat.config.id,
        chat,
        timestamp: now,
      });
      await persistence.persist();

      const persisted = await loadAgentRun(run.id);
      expect(persisted?.pendingPermissionRequests).toEqual([permission]);
    });
  });

  test("flushes task transcript changes before disabling persistence on stop", async () => {
    const task = createTask(context);
    await runWithCurrentUser(testOwnerUser, async () => {
      await saveTask(task);
      if (!context.mockBackend) {
        throw new Error("Expected mock backend");
      }

      const engine = new TaskEngine({
        task,
        backend: context.mockBackend,
        gitService: context.git,
        onPersistState: async (state, options) => {
          await updateTaskState(task.config.id, state, options);
        },
      });

      await engine.stop("checkpoint regression");

      const persisted = await loadTask(task.config.id);
      expect(persisted?.state.status).toBe("stopped");
      expect(persisted?.state.logs.some((entry) => entry.message === "Task stopped")).toBe(true);
    });
  });

  test("persists task startup failures", async () => {
    const task = createTask(context);
    task.state.status = "idle";
    task.config.useWorktree = false;
    await runWithCurrentUser(testOwnerUser, async () => {
      await saveTask(task);
      if (!context.mockBackend) {
        throw new Error("Expected mock backend");
      }
      context.mockBackend.connect = async () => {
        throw new Error("startup connection failed");
      };

      const engine = new TaskEngine({
        task,
        backend: context.mockBackend,
        gitService: context.git,
        skipGitSetup: true,
        onPersistState: async (state, options) => {
          await updateTaskState(task.config.id, state, options);
        },
      });

      await engine.start();

      const persisted = await loadTask(task.config.id);
      expect(persisted?.state.status).toBe("failed");
      expect(persisted?.state.error?.message).toContain("startup connection failed");
    });
  });

  test("preserves operational updates that arrive during a task checkpoint", async () => {
    const task = createTask(context);
    await runWithCurrentUser(testOwnerUser, async () => {
      await saveTask(task);
      if (!context.mockBackend) {
        throw new Error("Expected mock backend");
      }

      let engine: TaskEngine;
      let persistCalls = 0;
      engine = new TaskEngine({
        task,
        backend: context.mockBackend,
        gitService: context.git,
        onPersistState: async (state, options) => {
          persistCalls += 1;
          await updateTaskState(task.config.id, state, options);
          if (persistCalls === 1) {
            const internals = engine as unknown as { isTaskRunning: boolean };
            internals.isTaskRunning = true;
            await engine.injectPendingNow({ message: "arrived during checkpoint" });
            internals.isTaskRunning = false;
          }
        },
      });

      await engine.stop("operational checkpoint regression");

      const persisted = await loadTask(task.config.id);
      expect(persisted?.state.pendingPrompt).toBe("arrived during checkpoint");
      expect(persistCalls).toBe(2);
    });
  });
});
