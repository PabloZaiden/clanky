import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getWebAppServer, resetWebAppServerForTests } from "../../src/server";
import {
  getChatTranscriptMeta,
  listChatTranscriptEntries,
  migrateLegacyChatTranscripts,
  saveChat,
  getChatToolCallFromTranscript,
} from "../../src/persistence/chats";
import { saveTask } from "../../src/persistence/tasks";
import { saveAgent, saveAgentRun } from "../../src/persistence/agents";
import {
  getTranscriptMeta,
  getTranscriptToolCall,
  listTranscriptEntries,
} from "../../src/persistence/transcripts/store";
import { runWithCurrentUser } from "../../src/core/user-context";
import { getDatabase } from "../../src/persistence/database";
import { migrations } from "../../src/persistence/migrations";
import {
  createInitialAgentState,
  createInitialChatState,
  createInitialState,
  DEFAULT_TASK_CONFIG,
  type Agent,
  type AgentRun,
  type Chat,
  type Task,
} from "../../src/shared";
import {
  setupTestContext,
  teardownTestContext,
  testOwnerUser,
  testWorkspaceId,
  type TestContext,
} from "../setup";

function createLegacyChat(id: string, workDir: string, workspaceId: string, timestamp: string): Chat {
  const state = createInitialChatState(id);
  state.messages = [{
    id: `${id}-message`,
    role: "user",
    content: `Message for ${id}`,
    timestamp,
  }];
  state.toolCalls = [{
    id: `${id}-tool`,
    name: "read",
    input: { filePath: "legacy.ts" },
    output: { content: `Output for ${id}` },
    status: "completed",
    timestamp,
  }];

  return {
    config: {
      id,
      name: `Legacy ${id}`,
      workspaceId,
      scope: "workspace",
      directory: workDir,
      model: {
        providerID: "test-provider",
        modelID: "test-model",
        variant: "",
      },
      useWorktree: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      mode: "chat",
    },
    state,
  };
}

function createLegacyTask(id: string, workDir: string, workspaceId: string, timestamp: string): Task {
  const state = createInitialState(id);
  state.status = "completed";
  state.currentIteration = 1;
  state.startedAt = timestamp;
  state.completedAt = timestamp;
  state.messages = [{
    id: `${id}-message`,
    role: "user",
    content: `Message for ${id}`,
    timestamp,
  }];
  state.toolCalls = [{
    id: `${id}-tool`,
    name: "read",
    input: { filePath: "task.ts" },
    output: { content: `Output for ${id}` },
    status: "completed",
    timestamp,
  }];

  return {
    config: {
      ...DEFAULT_TASK_CONFIG,
      id,
      name: `Task ${id}`,
      directory: workDir,
      prompt: `Prompt for ${id}`,
      createdAt: timestamp,
      updatedAt: timestamp,
      workspaceId,
      model: {
        providerID: "test-provider",
        modelID: "test-model",
        variant: "",
      },
      git: DEFAULT_TASK_CONFIG.git,
    },
    state,
  };
}

function createLegacyAgentRun(
  agentId: string,
  runId: string,
  workDir: string,
  workspaceId: string,
  timestamp: string,
): { agent: Agent; run: AgentRun } {
  const configSnapshot = {
    name: `Agent ${agentId}`,
    workspaceId,
    directory: workDir,
    prompt: `Prompt for ${agentId}`,
    model: {
      providerID: "test-provider",
      modelID: "test-model",
      variant: "",
    },
    useWorktree: false,
    schedule: {
      startAtLocal: timestamp,
      timezone: "UTC",
      interval: { value: 1, unit: "hours" as const },
      nextRunAt: timestamp,
    },
  };
  const agent: Agent = {
    config: {
      ...configSnapshot,
      id: agentId,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      mode: "agent",
    },
    state: createInitialAgentState(agentId),
  };
  const run: AgentRun = {
    id: runId,
    agentId,
    status: "completed",
    trigger: "manual",
    scheduledFor: timestamp,
    completedAt: timestamp,
    messages: [{
      id: `${runId}-message`,
      role: "user",
      content: `Message for ${runId}`,
      timestamp,
    }],
    logs: [],
    toolCalls: [{
      id: `${runId}-tool`,
      name: "fetch",
      input: { url: "https://example.com" },
      output: { content: `Output for ${runId}` },
      status: "completed",
      timestamp,
    }],
    configSnapshot,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { agent, run };
}

describe("chat transcript startup migration", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestContext();
  });

  afterEach(async () => {
    resetWebAppServerForTests();
    await teardownTestContext(context);
  });

  test("backfills every legacy chat before returning the web app server", async () => {
    const legacyChats = [
      createLegacyChat("legacy-startup-1", context.workDir, testWorkspaceId, "2025-02-01T00:00:00.000Z"),
      createLegacyChat("legacy-startup-2", context.workDir, testWorkspaceId, "2025-02-02T00:00:00.000Z"),
    ];

    await runWithCurrentUser(testOwnerUser, async () => {
      for (const chat of legacyChats) {
        await saveChat(chat);
      }
    });

    const db = getDatabase();
    db.run("ALTER TABLE chats ADD COLUMN messages TEXT");
    db.run("ALTER TABLE chats ADD COLUMN logs TEXT");
    db.run("ALTER TABLE chats ADD COLUMN tool_calls TEXT");
    for (const chat of legacyChats) {
      db.prepare("DELETE FROM chat_transcript_entries WHERE chat_id = ? AND user_id = ?").run(chat.config.id, testOwnerUser.id);
      db.prepare("DELETE FROM chat_transcript_meta WHERE chat_id = ? AND user_id = ?").run(chat.config.id, testOwnerUser.id);
      db.prepare(`
        UPDATE chats
        SET messages = ?, logs = ?, tool_calls = ?
        WHERE id = ? AND user_id = ?
      `).run(
        JSON.stringify(chat.state.messages),
        JSON.stringify(chat.state.logs),
        JSON.stringify(chat.state.toolCalls),
        chat.config.id,
        testOwnerUser.id,
      );
    }

    await runWithCurrentUser(testOwnerUser, () => {
      expect(getChatTranscriptMeta(legacyChats[0]!.config.id)).toBeNull();
    });

    await getWebAppServer();

    await runWithCurrentUser(testOwnerUser, () => {
      for (const chat of legacyChats) {
        const meta = getChatTranscriptMeta(chat.config.id);
        expect(meta?.entryCount).toBe(2);
        const entries = listChatTranscriptEntries(chat.config.id, undefined, 10);
        expect(entries).toHaveLength(2);
        expect(getChatToolCallFromTranscript(chat.config.id, `${chat.config.id}-tool`)?.output).toEqual({
          content: `Output for ${chat.config.id}`,
        });
      }
    });

    const remainingColumns = (db.query("PRAGMA table_info(chats)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(remainingColumns).not.toContain("messages");
    expect(remainingColumns).not.toContain("logs");
    expect(remainingColumns).not.toContain("tool_calls");

    expect(migrateLegacyChatTranscripts()).toEqual({
      candidates: 0,
      migratedChats: 0,
      remainingChats: 0,
    });
  });

  test("backfills legacy task and agent-run transcripts before startup completes", async () => {
    const task = createLegacyTask(
      "legacy-startup-task",
      context.workDir,
      testWorkspaceId,
      "2025-03-01T00:00:00.000Z",
    );
    const { agent, run } = createLegacyAgentRun(
      "legacy-startup-agent",
      "legacy-startup-run",
      context.workDir,
      testWorkspaceId,
      "2025-03-02T00:00:00.000Z",
    );

    await runWithCurrentUser(testOwnerUser, async () => {
      await saveTask(task);
      await saveAgent(agent);
      await saveAgentRun(run);
    });

    const db = getDatabase();
    db.run("ALTER TABLE tasks ADD COLUMN messages TEXT");
    db.run("ALTER TABLE tasks ADD COLUMN logs TEXT");
    db.run("ALTER TABLE tasks ADD COLUMN tool_calls TEXT");
    db.run("ALTER TABLE agent_runs ADD COLUMN messages TEXT");
    db.run("ALTER TABLE agent_runs ADD COLUMN logs TEXT");
    db.run("ALTER TABLE agent_runs ADD COLUMN tool_calls TEXT");
    db.prepare("DELETE FROM task_transcript_entries WHERE task_id = ? AND user_id = ?").run(task.config.id, testOwnerUser.id);
    db.prepare("DELETE FROM task_transcript_meta WHERE task_id = ? AND user_id = ?").run(task.config.id, testOwnerUser.id);
    db.prepare("DELETE FROM agent_run_transcript_entries WHERE agent_run_id = ? AND user_id = ?").run(run.id, testOwnerUser.id);
    db.prepare("DELETE FROM agent_run_transcript_meta WHERE agent_run_id = ? AND user_id = ?").run(run.id, testOwnerUser.id);
    db.prepare(`
      UPDATE tasks
      SET messages = ?, logs = ?, tool_calls = ?
      WHERE id = ? AND user_id = ?
    `).run(
      JSON.stringify(task.state.messages),
      JSON.stringify(task.state.logs),
      JSON.stringify(task.state.toolCalls),
      task.config.id,
      testOwnerUser.id,
    );
    db.prepare(`
      UPDATE agent_runs
      SET messages = ?, logs = ?, tool_calls = ?
      WHERE id = ? AND user_id = ?
    `).run(
      JSON.stringify(run.messages),
      JSON.stringify(run.logs),
      JSON.stringify(run.toolCalls),
      run.id,
      testOwnerUser.id,
    );

    await getWebAppServer();

    await runWithCurrentUser(testOwnerUser, () => {
      expect(getTranscriptMeta("task", task.config.id)?.entryCount).toBe(2);
      expect(listTranscriptEntries("task", task.config.id, undefined, 10)).toHaveLength(2);
      expect(getTranscriptToolCall("task", task.config.id, `${task.config.id}-tool`)).toMatchObject({
        output: { content: `Output for ${task.config.id}` },
      });
      expect(getTranscriptMeta("agent_run", run.id)?.entryCount).toBe(2);
      expect(listTranscriptEntries("agent_run", run.id, undefined, 10)).toHaveLength(2);
      expect(getTranscriptToolCall("agent_run", run.id, `${run.id}-tool`)).toMatchObject({
        output: { content: `Output for ${run.id}` },
      });
    });

    for (const table of ["tasks", "agent_runs"]) {
      const columns = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).not.toContain("messages");
      expect(columns).not.toContain("logs");
      expect(columns).not.toContain("tool_calls");
    }
  });

  test("normalizes pre-existing chat tool rows before serving paginated details", async () => {
    const chat = createLegacyChat(
      "legacy-normalized-tool",
      context.workDir,
      testWorkspaceId,
      "2025-04-01T00:00:00.000Z",
    );

    await runWithCurrentUser(testOwnerUser, () => saveChat(chat));

    const db = getDatabase();
    const tool = chat.state.toolCalls[0]!;
    db.prepare(`
      UPDATE chat_transcript_entries
      SET payload = ?, tool_name = NULL, tool_status = NULL, tool_input = NULL, tool_output = NULL, tool_extras = NULL
      WHERE chat_id = ? AND entry_id = ?
    `).run(
      JSON.stringify(tool),
      chat.config.id,
      `tool:${tool.id}`,
    );

    const migration = migrations.find((candidate) => candidate.version === 15);
    if (!migration) {
      throw new Error("Unified transcript migration is missing");
    }
    migration.up(db);

    await runWithCurrentUser(testOwnerUser, () => {
      const entry = listTranscriptEntries("chat", chat.config.id, undefined, 10)
        .find((candidate) => candidate.kind === "tool");
      expect(entry?.tool?.input).toEqual(tool.input);
      expect(entry?.tool?.output).toBeUndefined();
      expect(entry?.toolHasOutput).toBe(true);
      expect(getTranscriptToolCall("chat", chat.config.id, tool.id)?.output).toEqual(tool.output);
    });
  });

  test("repairs normalized chats from legacy logs before dropping legacy columns", async () => {
    const chat = createLegacyChat(
      "legacy-partially-normalized",
      context.workDir,
      testWorkspaceId,
      "2025-05-01T00:00:00.000Z",
    );
    chat.state.logs = [
      {
        id: "legacy-system-log",
        level: "info",
        message: "System log retained by the old normalized writer",
        details: { logKind: "system" },
        timestamp: "2025-05-01T00:00:01.000Z",
      },
      {
        id: "legacy-user-log",
        level: "user",
        message: "User-visible log",
        timestamp: "2025-05-01T00:00:02.000Z",
      },
    ];

    await runWithCurrentUser(testOwnerUser, () => saveChat(chat));

    const db = getDatabase();
    db.run("ALTER TABLE chats ADD COLUMN messages TEXT");
    db.run("ALTER TABLE chats ADD COLUMN logs TEXT");
    db.run("ALTER TABLE chats ADD COLUMN tool_calls TEXT");
    db.prepare(`
      DELETE FROM chat_transcript_entries
      WHERE chat_id = ? AND user_id = ? AND entry_id = ?
    `).run(chat.config.id, testOwnerUser.id, "log:legacy-system-log");
    db.prepare(`
      UPDATE chats
      SET messages = ?, logs = ?, tool_calls = ?
      WHERE id = ? AND user_id = ?
    `).run(
      JSON.stringify(chat.state.messages),
      JSON.stringify(chat.state.logs),
      JSON.stringify(chat.state.toolCalls),
      chat.config.id,
      testOwnerUser.id,
    );

    await getWebAppServer();

    await runWithCurrentUser(testOwnerUser, () => {
      const entries = listTranscriptEntries("chat", chat.config.id, undefined, 10);
      expect(entries.some((entry) => entry.id === "legacy-system-log")).toBe(true);
      expect(entries.some((entry) => entry.id === "legacy-user-log")).toBe(true);
    });
  });
});
