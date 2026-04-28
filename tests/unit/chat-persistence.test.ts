import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadLoopChat, saveChat } from "../../src/persistence/chats";
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
  scope?: Chat["config"]["scope"];
  loopId?: string;
}): Chat {
  const id = overrides?.id ?? "chat-1";
  const now = "2026-04-28T00:00:00.000Z";

  return {
    config: {
      id,
      name: `Chat ${id}`,
      workspaceId: testWorkspaceId,
      scope: overrides?.scope ?? "workspace",
      loopId: overrides?.loopId,
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

  test("loadLoopChat ignores workspace-scoped rows even when loop_id matches", async () => {
    await saveChat(createChat({
      id: "workspace-chat",
      scope: "workspace",
      loopId: "loop-1",
    }));

    await expect(loadLoopChat("loop-1")).resolves.toBeNull();
  });

  test("loadLoopChat returns loop-scoped rows", async () => {
    await saveChat(createChat({
      id: "loop-chat",
      scope: "loop",
      loopId: "loop-1",
    }));

    await expect(loadLoopChat("loop-1")).resolves.toMatchObject({
      config: {
        id: "loop-chat",
        scope: "loop",
        loopId: "loop-1",
      },
    });
  });
});
