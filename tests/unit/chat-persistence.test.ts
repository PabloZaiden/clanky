import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getWorkspaceChatNameStats, loadChat, loadTaskChat, saveChat } from "../../src/persistence/chats";
import { createInitialChatState, type Chat } from "../../src/types/chat";
import {
  setupTestContext,
  teardownTestContext,
  testModel,
  testWorkspaceId,
  type TestContext,
} from "../setup";

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
});
