import { describe, expect, test } from "bun:test";
import type { Chat } from "../../src/shared";
import {
  applyChatStatusEvent,
  mergeChatSnapshot,
  mergeChatSummarySnapshot,
} from "../../src/utils/chat-snapshot";

const CURRENT_ACTIVITY = "2026-07-18T01:00:02.000Z";

function createChat(
  status: Chat["state"]["status"],
  lastActivityAt: string | undefined,
  state: Partial<Chat["state"]> = {},
): Chat {
  return {
    config: {
      id: "chat-1",
      name: "Snapshot test chat",
      workspaceId: "workspace-1",
      scope: "workspace",
      directory: "/tmp/chat-snapshot-test",
      model: {
        providerID: "provider",
        modelID: "model",
        variant: "",
      },
      useWorktree: false,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
      mode: "chat",
    },
    state: {
      id: "state-1",
      status,
      lastActivityAt,
      messages: [],
      logs: [],
      toolCalls: [],
      ...state,
    },
  };
}

describe("chat snapshot merging", () => {
  test("applies a terminal status event and clears active response state", () => {
    const current = createChat("streaming", "2026-07-18T01:00:01.000Z", {
      activeMessageId: "message-1",
      interruptRequested: true,
    });

    const updated = applyChatStatusEvent(current, "idle", "2026-07-18T01:00:02.000Z");

    expect(updated.state.status).toBe("idle");
    expect(updated.state.lastActivityAt).toBe("2026-07-18T01:00:02.000Z");
    expect(updated.state.activeMessageId).toBeUndefined();
    expect(updated.state.interruptRequested).toBe(false);
  });

  test("ignores a stale terminal status event", () => {
    const current = createChat("streaming", CURRENT_ACTIVITY, {
      activeMessageId: "message-1",
    });

    const updated = applyChatStatusEvent(current, "idle", "2026-07-18T01:00:01.000Z");

    expect(updated).toBe(current);
    expect(updated.state.status).toBe("streaming");
    expect(updated.state.activeMessageId).toBe("message-1");
  });

  test("applies a newer terminal snapshot over stale streaming state", () => {
    const current = createChat("streaming", "2026-07-18T01:00:01.000Z", {
      messages: [{
        id: "message-1",
        role: "assistant",
        content: "partial",
        timestamp: "2026-07-18T01:00:01.000Z",
      }],
    });
    const incoming = createChat("idle", "2026-07-18T01:00:02.000Z", {
      messages: [{
        id: "message-1",
        role: "assistant",
        content: "complete",
        timestamp: "2026-07-18T01:00:02.000Z",
      }],
    });

    const merged = mergeChatSnapshot(current, incoming);

    expect(merged.state.status).toBe("idle");
    expect(merged.state.messages).toEqual(incoming.state.messages);
  });

  test("does not let an equal-timestamp busy snapshot downgrade terminal state", () => {
    const current = createChat("idle", CURRENT_ACTIVITY);
    const incoming = createChat("streaming", CURRENT_ACTIVITY);

    const merged = mergeChatSnapshot(current, incoming);

    expect(merged.state.status).toBe("idle");
  });

  test("allows a genuinely newer busy transition after an idle snapshot", () => {
    const current = createChat("idle", CURRENT_ACTIVITY);
    const incoming = createChat("starting", "2026-07-18T01:00:03.000Z");

    const merged = mergeChatSnapshot(current, incoming);

    expect(merged.state.status).toBe("starting");
  });

  test("preserves summary data accumulated from the incremental stream", () => {
    const messages = [{
      id: "message-1",
      role: "assistant" as const,
      content: "complete",
      timestamp: CURRENT_ACTIVITY,
    }];
    const logs = [{
      id: "log-1",
      level: "info" as const,
      message: "response",
      timestamp: CURRENT_ACTIVITY,
    }];
    const toolCalls = [{
      id: "tool-1",
      name: "read",
      input: { path: "README.md" },
      status: "completed" as const,
      timestamp: CURRENT_ACTIVITY,
    }];
    const current = createChat("streaming", CURRENT_ACTIVITY, {
      messages,
      logs,
      toolCalls,
    });
    const incoming = createChat("idle", "2026-07-18T01:00:03.000Z");

    const merged = mergeChatSummarySnapshot(current, incoming);

    expect(merged.state.status).toBe("idle");
    expect(merged.state.messages).toEqual(messages);
    expect(merged.state.logs).toEqual(logs);
    expect(merged.state.toolCalls).toEqual(toolCalls);
  });
});
