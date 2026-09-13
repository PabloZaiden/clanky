import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, ChatStatus } from "@/shared";
import { createInitialChatState } from "@/shared/chat";
import { loadChat, resetStaleChats, saveChat } from "../../src/persistence/chats";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import {
  ensureExecutionHost,
  toExecutionHostBinding,
} from "../../src/persistence/execution-hosts";
import { runWithCurrentUser } from "../../src/core/user-context";
import { testOwnerUser } from "../setup";

describe("chat persistence recovery", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-chat-recovery-"));
    closeDatabase();
    process.env["CLANKY_DATA_DIR"] = dataDir;
    await initializeDatabase();
  });

  afterEach(async () => {
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
  });

  test("resets every stale status and is idempotent", async () => {
    const staleStatuses: ChatStatus[] = ["starting", "streaming", "interrupting", "reconnecting"];
    const executionHostBinding = await runWithCurrentUser(testOwnerUser, async () => (
      toExecutionHostBinding(ensureExecutionHost(
        testOwnerUser.id,
        { kind: "local", nodeId: "test-local" },
        "test-local",
      ))
    ));
    const chats = staleStatuses.map((status): Chat => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      return {
        config: {
          id,
          name: `Stale chat ${status}`,
          workspaceId: crypto.randomUUID(),
          executionHostBinding,
          source: {
            kind: "execution_host",
            executionHost: executionHostBinding,
            directory: `/workspaces/${id}`,
          },
          scope: "workspace",
          directory: `/workspaces/${id}`,
          model: { providerID: "copilot", modelID: "test-model", variant: "" },
          useWorktree: false,
          mode: "chat",
          createdAt: now,
          updatedAt: now,
        },
        state: {
          ...createInitialChatState(id),
          status,
          completedAt: undefined,
          pendingPermissionRequests: [{
            requestId: "permission-1",
            sessionId: "session-1",
            permission: "read",
            patterns: ["*"],
            status: "pending",
            createdAt: now,
          }],
          queuedMessages: [{
            id: "queued-1",
            content: "Keep this message",
            createdAt: now,
          }],
          activeMessageId: "message-1",
          interruptRequested: true,
          connectionStatus: "connecting",
          startupStage: "connecting_provider",
        },
      };
    });

    await runWithCurrentUser(testOwnerUser, async () => {
      for (const chat of chats) {
        await saveChat(chat);
      }

      expect(await resetStaleChats()).toBe(staleStatuses.length);
      for (const chat of chats) {
        const recovered = await loadChat(chat.config.id);
        expect(recovered?.state).toMatchObject({
          status: "stopped",
          error: { message: "Forcefully stopped by connection reset" },
          connectionStatus: "disconnected",
        });
        expect(recovered?.state.interruptRequested).toBeFalsy();
        expect(recovered?.state.completedAt).toBeDefined();
        expect(recovered?.state.activeMessageId).toBeUndefined();
        expect(recovered?.state.pendingPermissionRequests).toEqual([]);
        expect(recovered?.state.startupStage).toBeUndefined();
        expect(recovered?.state.queuedMessages).toEqual([expect.objectContaining({
          id: "queued-1",
          content: "Keep this message",
        })]);
      }

      expect(await resetStaleChats()).toBe(0);
    });
  });
});
