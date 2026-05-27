import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getWorkspaceChatNameStats,
  listChatSummariesBySshServer,
  loadChat,
  loadTaskChat,
  saveChat,
} from "../../src/persistence/chats";
import { createInitialChatState, type Chat } from "../../src/types/chat";
import {
  setupTestContext,
  teardownTestContext,
  testModel,
  testWorkspaceId,
  type TestContext,
} from "../setup";
import { getDatabase } from "../../src/persistence/database";
import { rowToChat } from "../../src/persistence/chats/helpers";

let context: TestContext;

function createChat(overrides?: {
  id?: string;
  name?: string;
  scope?: Chat["config"]["scope"];
  taskId?: string;
}): Chat {
  const id = overrides?.id ?? "chat-1";
  const now = "2026-04-28T00:00:00.000Z";

  return {
    config: {
      id,
      name: overrides?.name ?? `Chat ${id}`,
      workspaceId: testWorkspaceId,
      source: {
        kind: "workspace",
        workspaceId: testWorkspaceId,
      },
      scope: overrides?.scope ?? "workspace",
      taskId: overrides?.taskId,
      directory: context.workDir,
      model: testModel,
      useWorktree: false,
      baseBranch: "main",
      createdAt: now,
      updatedAt: now,
      mode: "chat",
    },
    state: createInitialChatState(id),
  };
}

describe("chat persistence", () => {
  beforeEach(async () => {
    context = await setupTestContext();
  });

  afterEach(async () => {
    await teardownTestContext(context);
  });

  test("loadTaskChat ignores workspace-scoped rows even when task_id matches", async () => {
    await saveChat(createChat({
      id: "workspace-chat",
      scope: "workspace",
      taskId: "task-1",
    }));

    await expect(loadTaskChat("task-1")).resolves.toBeNull();
  });

  test("loadTaskChat returns task-scoped rows", async () => {
    await saveChat(createChat({
      id: "task-chat",
      scope: "task",
      taskId: "task-1",
    }));

    await expect(loadTaskChat("task-1")).resolves.toMatchObject({
      config: {
        id: "task-chat",
        scope: "task",
        taskId: "task-1",
      },
    });
  });

  test("getWorkspaceChatNameStats returns count and maximum generated suffix without loading chats", async () => {
    await saveChat(createChat({
      id: "generated-1",
      name: "Test Workspace - 1",
    }));
    await saveChat(createChat({
      id: "generated-4",
      name: "Test Workspace - 4",
    }));
    await saveChat(createChat({
      id: "explicit",
      name: "Explicit Chat",
    }));
    await saveChat(createChat({
      id: "other-prefix",
      name: "Other Workspace - 9",
    }));
    await saveChat(createChat({
      id: "task-chat",
      name: "Test Workspace - 10",
      scope: "task",
      taskId: "task-1",
    }));

    await expect(getWorkspaceChatNameStats(testWorkspaceId, "Test Workspace")).resolves.toEqual({
      standaloneChatCount: 4,
      maxGeneratedSuffix: 4,
    });
  });

  test("persists skipBaseBranchSync on chat config", async () => {
    const chat = createChat({ id: "skip-sync-chat" });
    chat.config.skipBaseBranchSync = true;

    await saveChat(chat);

    const loaded = await loadChat("skip-sync-chat");
    expect(loaded?.config.skipBaseBranchSync).toBe(true);
  });

  test("persists ssh-server chat source and connection status", async () => {
    const now = "2026-04-28T00:00:00.000Z";
    getDatabase().prepare(`
      INSERT INTO ssh_servers (id, name, address, username, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("ssh-server-1", "Remote", "remote.example", "user", now, now);
    getDatabase().prepare(`
      INSERT INTO ssh_server_sessions (
        id, ssh_server_id, name, remote_session_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run("ssh-session-1", "ssh-server-1", "Chat transport", "clanky-chat", now, now);

    const chat = createChat({ id: "remote-chat" });
    chat.config.workspaceId = "";
    chat.config.source = {
      kind: "ssh_server",
      sshServerId: "ssh-server-1",
      sshServerSessionId: "ssh-session-1",
      directory: "/remote/repo",
    };
    chat.config.directory = "/remote/repo";
    chat.state.connectionStatus = "needs_credentials";

    await saveChat(chat);

    const loaded = await loadChat("remote-chat");
    expect(loaded?.config.source).toEqual({
      kind: "ssh_server",
      sshServerId: "ssh-server-1",
      sshServerSessionId: "ssh-session-1",
      directory: "/remote/repo",
    });
    expect(loaded?.config.workspaceId).toBe("");
    expect(loaded?.state.connectionStatus).toBe("needs_credentials");
    await expect(listChatSummariesBySshServer("ssh-server-1")).resolves.toHaveLength(1);

    getDatabase().prepare("DELETE FROM ssh_server_sessions WHERE id = ?").run("ssh-session-1");

    await expect(loadChat("remote-chat")).resolves.toBeNull();
    await expect(listChatSummariesBySshServer("ssh-server-1")).resolves.toHaveLength(0);
  });

  test("rejects malformed ssh-server chat source rows before mapping", () => {
    expect(() => rowToChat({
      id: "remote-chat",
      name: "Remote chat",
      source_kind: "ssh_server",
      workspace_id: null,
      ssh_server_id: "ssh-server-1",
      ssh_server_session_id: null,
      scope: "workspace",
      directory: "/remote/repo",
      created_at: "2026-04-28T00:00:00.000Z",
      updated_at: "2026-04-28T00:00:00.000Z",
      model_provider_id: "copilot",
      model_model_id: "gpt-5.5",
      mode: "chat",
      status: "idle",
    })).toThrow("ssh_server_session_id is required");
  });
});
