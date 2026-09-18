import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createTranscriptChangeSet,
  DEFAULT_TASK_CONFIG,
  mergeTranscriptSnapshot,
  type Task,
  type TaskLogEntry,
  type PersistedMessage,
  type PersistedToolCall,
} from "@/shared";

import { TaskEngine } from "../../src/core/task-engine";
import {
  loadTask,
  saveTask,
  updateTaskState,
} from "../../src/persistence/tasks";
import {
  getTranscriptMeta,
  listTranscriptEntriesPage,
  TranscriptCursorError,
} from "../../src/persistence/transcripts/store";
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

  test("pages task history by assistant responses while retaining turn context and tool summaries", async () => {
    const task = createTask(context);
    const messages: PersistedMessage[] = [];
    const toolCalls: PersistedToolCall[] = [];
    for (let index = 0; index < 105; index += 1) {
      const timestamp = new Date(Date.UTC(2024, 0, 1, 0, index)).toISOString();
      messages.push({
        id: `user-${index}`,
        role: "user",
        content: `Question ${index}`,
        timestamp,
      });
      messages.push({
        id: `assistant-${index}`,
        role: "assistant",
        content: `Answer ${index}`,
        timestamp,
      });
      toolCalls.push({
        id: `tool-${index}`,
        name: "read_file",
        input: { path: `file-${index}.txt` },
        output: `private output ${index}`,
        status: "completed",
        timestamp,
      });
    }
    task.config.id = "paged-task";
    task.state.id = task.config.id;
    task.state.messages = messages;
    task.state.logs = [];
    task.state.toolCalls = toolCalls;

    await runWithCurrentUser(testOwnerUser, async () => {
      await saveTask(task);

      const latestPage = listTranscriptEntriesPage("task", task.config.id);
      expect(latestPage.totalResponses).toBe(105);
      expect(latestPage.loadedResponses).toBe(100);
      expect(latestPage.hasOlder).toBe(true);
      expect(latestPage.nextCursor).toBeString();

      const latestResponseIds = latestPage.entries
        .filter((entry) => entry.kind === "message")
        .map((entry) => (entry.payload as PersistedMessage).id)
        .filter((id) => id.startsWith("assistant-"));
      expect(latestResponseIds).toHaveLength(100);
      expect(latestResponseIds).toContain("assistant-104");
      expect(latestResponseIds).not.toContain("assistant-4");
      expect(latestPage.entries.some((entry) => entry.id === "user-5")).toBe(true);

      const latestTool = latestPage.entries.find((entry) => entry.kind === "tool");
      expect(latestTool?.tool?.output).toBeUndefined();
      expect(latestTool?.toolHasOutput).toBe(true);

      const olderPage = listTranscriptEntriesPage("task", task.config.id, {
        before: latestPage.nextCursor,
      });
      expect(olderPage.totalResponses).toBe(105);
      expect(olderPage.loadedResponses).toBe(5);
      expect(olderPage.hasOlder).toBe(false);
      const olderResponseIds = olderPage.entries
        .filter((entry) => entry.kind === "message")
        .map((entry) => (entry.payload as PersistedMessage).id)
        .filter((id) => id.startsWith("assistant-"));
      expect(olderResponseIds).toEqual([
        "assistant-0",
        "assistant-1",
        "assistant-2",
        "assistant-3",
        "assistant-4",
      ]);
      expect(new Set([...latestResponseIds, ...olderResponseIds]).size).toBe(105);

      const fullPage = listTranscriptEntriesPage("task", task.config.id, { full: true });
      expect(fullPage.loadedResponses).toBe(105);
      expect(fullPage.hasOlder).toBe(false);
      expect(fullPage.nextCursor).toBeUndefined();

      expect(() => listTranscriptEntriesPage("task", task.config.id, {
        full: true,
        before: latestPage.nextCursor,
      })).toThrow(TranscriptCursorError);
    });
  });

  test("does not downgrade a complete transcript when a later snapshot is partial", () => {
    const fullTranscript = {
      messages: [
        { id: "old", role: "assistant" as const, content: "old", timestamp: "2024-01-01T00:00:00.000Z" },
        { id: "new", role: "assistant" as const, content: "new", timestamp: "2024-01-01T00:01:00.000Z" },
      ],
      logs: [],
      toolCalls: [],
      revision: "full",
      totalEntries: 2,
      isPartial: false,
      loadedResponses: 2,
      totalResponses: 2,
      hasOlder: false,
    };
    const partialTranscript = {
      ...fullTranscript,
      messages: [fullTranscript.messages[1]!],
      revision: "partial",
      totalEntries: 2,
      isPartial: true,
      loadedResponses: 1,
      totalResponses: 2,
      hasOlder: true,
      nextCursor: "cursor",
    };

    const merged = mergeTranscriptSnapshot(fullTranscript, partialTranscript);
    expect(merged.messages.map((message) => message.id)).toEqual(["old", "new"]);
    expect(merged.isPartial).toBe(false);
    expect(merged.hasOlder).toBe(false);
    expect(merged.nextCursor).toBeUndefined();
  });

  test("hydrates a partial snapshot into an empty transcript state", () => {
    const incoming = {
      messages: [
        { id: "latest", role: "assistant" as const, content: "latest", timestamp: "2024-01-01T00:00:00.000Z" },
      ],
      logs: [],
      toolCalls: [],
      revision: "revision",
      totalEntries: 1,
      isPartial: true,
      loadedResponses: 1,
      totalResponses: 101,
      hasOlder: true,
      nextCursor: "cursor",
    };
    const merged = mergeTranscriptSnapshot({
      messages: [],
      logs: [],
      toolCalls: [],
      revision: "",
      totalEntries: 0,
      isPartial: false,
      loadedResponses: 0,
      totalResponses: 0,
      hasOlder: false,
    }, incoming);
    expect(merged).toEqual(incoming);
  });

});
