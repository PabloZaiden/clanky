import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applyTranscriptStreamEvent,
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
  deleteTask,
  loadTask,
  saveTask,
  updateTaskState,
} from "../../src/persistence/tasks";
import { getDatabase } from "../../src/persistence/database";
import { taskTranscriptStore } from "../../src/persistence/transcripts/task-store";
import { decodeTranscriptCursor, encodeTranscriptCursor, TranscriptCursorError } from "../../src/persistence/transcripts/cursor";
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
      expect(taskTranscriptStore.getMeta(task.config.id)?.entryCount).toBe(3);
    });
  });

  test("validates cursor bindings before accepting a continuation", () => {
    const cursor = encodeTranscriptCursor(
      "task",
      "cursor-task",
      testOwnerUser.id,
      {
        entry_id: "message:assistant-1",
        timestamp: "2024-01-01T00:00:00.000Z",
        sequence: 4,
      },
    );

    expect(decodeTranscriptCursor("task", "cursor-task", testOwnerUser.id, cursor)).toEqual({
      version: 1,
      resource: "task",
      resourceId: "cursor-task",
      userId: testOwnerUser.id,
      entryId: "message:assistant-1",
      timestamp: "2024-01-01T00:00:00.000Z",
      sequence: 4,
    });
    expect(() => decodeTranscriptCursor("task", "other-task", testOwnerUser.id, cursor))
      .toThrow(TranscriptCursorError);
    expect(() => decodeTranscriptCursor("task", "cursor-task", "other-user", cursor))
      .toThrow(TranscriptCursorError);
    expect(() => decodeTranscriptCursor("chat", "cursor-task", testOwnerUser.id, cursor))
      .toThrow(TranscriptCursorError);
  });

  test("omits malformed persisted payloads while retaining normalized and legacy tool data", async () => {
    const task = createTask(context);
    task.config.id = "malformed-payload-task";
    task.state.id = task.config.id;
    const legacyTool: PersistedToolCall = {
      id: "legacy-tool",
      name: "write_file",
      input: { path: "legacy.txt" },
      output: "legacy output",
      status: "completed",
      timestamp: new Date(Date.now() + 1).toISOString(),
    };
    task.state.toolCalls = [...task.state.toolCalls, legacyTool];

    await runWithCurrentUser(testOwnerUser, async () => {
      await saveTask(task);
      const db = getDatabase();
      db.prepare(`
        UPDATE task_transcript_entries
        SET payload = ?
        WHERE task_id = ? AND entry_id = ?
      `).run("{malformed", task.config.id, "message:message-1");
      db.prepare(`
        UPDATE task_transcript_entries
        SET payload = ?
        WHERE task_id = ? AND entry_id = ?
      `).run("{malformed", task.config.id, "log:log-1");
      db.prepare(`
        UPDATE task_transcript_entries
        SET tool_input = ?, tool_output = ?, tool_extras = ?
        WHERE task_id = ? AND entry_id = ?
      `).run(
        "{malformed",
        "[malformed",
        "not-json",
        task.config.id,
        "tool:tool-1",
      );
      db.prepare(`
        UPDATE task_transcript_entries
        SET payload = ?, tool_name = NULL, tool_status = NULL,
          tool_input = NULL, tool_output = NULL, tool_extras = NULL
        WHERE task_id = ? AND entry_id = ?
      `).run(
        JSON.stringify(legacyTool),
        task.config.id,
        "tool:legacy-tool",
      );

      const loaded = await loadTask(task.config.id);
      expect(loaded?.state.messages).toEqual([]);
      expect(loaded?.state.logs).toEqual([]);
      expect(loaded?.state.toolCalls).toEqual([
        {
          id: "tool-1",
          name: "read_file",
          status: "completed",
          timestamp: task.state.toolCalls[0]!.timestamp,
        },
        legacyTool,
      ]);
    });
  });

  test("keeps transcript reads isolated to the owning user", async () => {
    const task = createTask(context);
    task.config.id = "owned-transcript-task";
    task.state.id = task.config.id;

    await runWithCurrentUser(testOwnerUser, async () => {
      await saveTask(task);

      expect(taskTranscriptStore.getMetaForUser(task.config.id, testOwnerUser.id)).not.toBeNull();
      expect(taskTranscriptStore.listForUser(task.config.id, testOwnerUser.id)).toHaveLength(3);
      expect(taskTranscriptStore.getMetaForUser(task.config.id, "different-user")).toBeNull();
      expect(taskTranscriptStore.listForUser(task.config.id, "different-user")).toEqual([]);
      expect(
        taskTranscriptStore.getToolCallForUser(task.config.id, "different-user", "tool-1"),
      ).toBeNull();
    });
  });

  test("cascades transcript rows and metadata when a task is deleted", async () => {
    const task = createTask(context);
    task.config.id = "cascade-transcript-task";
    task.state.id = task.config.id;

    await runWithCurrentUser(testOwnerUser, async () => {
      await saveTask(task);
      const db = getDatabase();
      expect(
        (db.query("SELECT COUNT(*) AS count FROM task_transcript_entries WHERE task_id = ?")
          .get(task.config.id) as { count: number }).count,
      ).toBe(3);
      expect(
        (db.query("SELECT COUNT(*) AS count FROM task_transcript_meta WHERE task_id = ?")
          .get(task.config.id) as { count: number }).count,
      ).toBe(1);

      expect(await deleteTask(task.config.id)).toBe(true);
      expect(
        (db.query("SELECT COUNT(*) AS count FROM task_transcript_entries WHERE task_id = ?")
          .get(task.config.id) as { count: number }).count,
      ).toBe(0);
      expect(
        (db.query("SELECT COUNT(*) AS count FROM task_transcript_meta WHERE task_id = ?")
          .get(task.config.id) as { count: number }).count,
      ).toBe(0);
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

      const latestPage = taskTranscriptStore.listPage(task.config.id);
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

      const olderPage = taskTranscriptStore.listPage(task.config.id, {
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

      const fullPage = taskTranscriptStore.listPage(task.config.id, { full: true });
      expect(fullPage.loadedResponses).toBe(105);
      expect(fullPage.hasOlder).toBe(false);
      expect(fullPage.nextCursor).toBeUndefined();

      expect(() => taskTranscriptStore.listPage(task.config.id, {
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

  test("advances the cursor when merging consecutive older transcript pages", () => {
    const createPage = (
      start: number,
      count: number,
      nextCursor: string | undefined,
    ) => ({
      messages: Array.from({ length: count }, (_, offset) => ({
        id: `assistant-${start + offset}`,
        role: "assistant" as const,
        content: `Answer ${start + offset}`,
        timestamp: `2024-01-01T00:${String(start + offset).padStart(2, "0")}:00.000Z`,
      })),
      logs: [],
      toolCalls: [],
      revision: `page-${start}`,
      totalEntries: count,
      isPartial: true,
      loadedResponses: count,
      totalResponses: 250,
      hasOlder: Boolean(nextCursor),
      ...(nextCursor ? { nextCursor } : {}),
    });

    const latestPage = createPage(150, 100, "before-150");
    const firstOlderPage = createPage(50, 100, "before-50");
    const finalOlderPage = createPage(0, 50, undefined);

    const afterFirstOlderPage = mergeTranscriptSnapshot(
      latestPage,
      firstOlderPage,
      { direction: "older" },
    );
    expect(afterFirstOlderPage.nextCursor).toBe("before-50");
    expect(afterFirstOlderPage.hasOlder).toBe(true);

    const afterFinalOlderPage = mergeTranscriptSnapshot(
      afterFirstOlderPage,
      finalOlderPage,
      { direction: "older" },
    );
    expect(afterFinalOlderPage.nextCursor).toBeUndefined();
    expect(afterFinalOlderPage.hasOlder).toBe(false);
    expect(afterFinalOlderPage.loadedResponses).toBe(250);
    expect(afterFinalOlderPage.messages).toHaveLength(250);
  });

  // Delta recovery is a protocol/lifecycle contract: stale snapshots must not
  // overwrite events that arrived while a request was in flight.
  test("reconciles transcript snapshots according to stream freshness", () => {
    const current = {
      messages: [
        {
          id: "older",
          role: "assistant" as const,
          content: "Earlier response",
          timestamp: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "streaming",
          role: "assistant" as const,
          content: "Hel",
          timestamp: "2024-01-01T00:01:00.000Z",
        },
      ],
      logs: [],
      toolCalls: [],
      revision: "current",
      totalEntries: 2,
      isPartial: true,
      loadedResponses: 2,
      totalResponses: 3,
      hasOlder: true,
      nextCursor: "cursor",
    };
    const incoming = {
      ...current,
      messages: [{
        ...current.messages[1]!,
        content: "Hello",
      }],
      revision: "incoming",
      loadedResponses: 1,
    };

    const recovered = mergeTranscriptSnapshot(current, incoming, {
      preferIncoming: true,
    });
    expect(recovered.messages.map((message) => message.content)).toEqual([
      "Earlier response",
      "Hello",
    ]);

    const liveWins = mergeTranscriptSnapshot(current, incoming, {
      preferIncoming: false,
    });
    expect(liveWins.messages.find((message) => message.id === "streaming")?.content).toBe("Hel");
  });

  // Message delta identity and base lengths are a stable realtime protocol
  // boundary; a mismatch must trigger authoritative recovery without mutation.
  test("upserts message deltas and reports sequence gaps", () => {
    const emptyTranscript = {
      messages: [],
      logs: [],
      toolCalls: [],
      revision: "",
      totalEntries: 0,
      isPartial: false,
      loadedResponses: 0,
      totalResponses: 0,
      hasOlder: false,
    };
    const first = applyTranscriptStreamEvent(emptyTranscript, {
      type: "transcript.message.delta",
      messageId: "assistant-1",
      role: "assistant",
      delta: "Hel",
      baseLength: 0,
      messageTimestamp: "2024-01-01T00:00:00.000Z",
    });
    const second = applyTranscriptStreamEvent(first.transcript, {
      type: "transcript.message.delta",
      messageId: "assistant-1",
      role: "assistant",
      delta: "lo",
      baseLength: 3,
      messageTimestamp: "2024-01-01T00:00:00.000Z",
    });

    expect(second.gapDetected).toBe(false);
    expect(second.transcript.messages).toEqual([
      expect.objectContaining({ id: "assistant-1", content: "Hello" }),
    ]);
    expect(second.transcript.totalEntries).toBe(1);
    expect(second.transcript.totalResponses).toBe(1);

    const gap = applyTranscriptStreamEvent(second.transcript, {
      type: "transcript.message.delta",
      messageId: "assistant-1",
      role: "assistant",
      delta: "!",
      baseLength: 4,
      messageTimestamp: "2024-01-01T00:00:00.000Z",
    });
    expect(gap.gapDetected).toBe(true);
    expect(gap.transcript).toBe(second.transcript);
  });

});
