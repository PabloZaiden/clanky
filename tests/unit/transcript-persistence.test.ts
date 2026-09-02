import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createTranscriptChangeSet,
  DEFAULT_TASK_CONFIG,
  type Task,
  type TaskLogEntry,
  type PersistedMessage,
  type PersistedToolCall,
} from "@/shared";

import { TaskEngine } from "../../src/core/task-engine";
import { TranscriptMemoryIndex } from "../../src/core/transcript-memory-index";
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

});
