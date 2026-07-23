import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getWebAppServer, resetWebAppServerForTests } from "../../src/server";
import {
  getChatTranscriptMeta,
  listChatTranscriptEntries,
  migrateLegacyChatTranscripts,
  saveChat,
} from "../../src/persistence/chats";
import { runWithCurrentUser } from "../../src/core/user-context";
import { createInitialChatState, type Chat } from "../../src/shared";
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
        expect(entries.some((entry) => entry.kind === "tool" && JSON.stringify(entry.payload).includes(`Output for ${chat.config.id}`))).toBe(true);
      }
    });

    expect(migrateLegacyChatTranscripts()).toEqual({
      candidates: 0,
      migratedChats: 0,
      remainingChats: 0,
    });
  });
});
