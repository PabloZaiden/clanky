import { describe, expect, test } from "bun:test";
import type { Chat } from "../../src/types";
import { mergeChatSnapshot, mergeChatSummarySnapshot } from "../../src/utils/chat-snapshot";

const timestamp = "2025-01-01T00:00:00.000Z";

function createChat(overrides?: Partial<Chat>): Chat {
  return {
    config: {
      id: "chat-1",
      name: "Repo pairing",
      workspaceId: "workspace-1",
      scope: "workspace",
      directory: "/workspace/repo",
      model: {
        providerID: "github",
        modelID: "gpt-5.4",
        variant: "",
      },
      useWorktree: true,
      baseBranch: "main",
      createdAt: timestamp,
      updatedAt: timestamp,
      mode: "chat",
      ...(overrides?.config ?? {}),
    },
    state: {
      id: "chat-1",
      status: "idle",
      messages: [],
      logs: [],
      toolCalls: [],
      ...(overrides?.state ?? {}),
    },
  };
}

describe("chat snapshot merging", () => {
  test("full empty detail payloads clear stale transcript details", () => {
    const current = createChat({
      state: {
        id: "chat-1",
        status: "idle",
        lastActivityAt: "2025-01-01T00:00:01.000Z",
        messages: [{
          id: "message-1",
          role: "assistant",
          content: "Stale transcript",
          timestamp,
        }],
        logs: [{
          id: "log-1",
          level: "agent",
          message: "Stale log",
          timestamp,
        }],
        toolCalls: [{
          id: "tool-1",
          name: "Read",
          input: {},
          output: { content: "Stale output" },
          status: "completed",
          timestamp,
        }],
      },
    });
    const incoming = createChat({
      state: {
        id: "chat-1",
        status: "idle",
        lastActivityAt: "2025-01-01T00:00:02.000Z",
        messages: [],
        logs: [],
        toolCalls: [],
      },
    });

    const merged = mergeChatSnapshot(current, incoming);

    expect(merged.state.messages).toEqual([]);
    expect(merged.state.logs).toEqual([]);
    expect(merged.state.toolCalls).toEqual([]);
  });

  test("summary empty detail payloads preserve hydrated transcript details", () => {
    const current = createChat({
      state: {
        id: "chat-1",
        status: "idle",
        lastActivityAt: "2025-01-01T00:00:01.000Z",
        messages: [{
          id: "message-1",
          role: "assistant",
          content: "Hydrated transcript",
          timestamp,
        }],
        logs: [{
          id: "log-1",
          level: "agent",
          message: "Hydrated log",
          timestamp,
        }],
        toolCalls: [{
          id: "tool-1",
          name: "Read",
          input: {},
          output: { content: "Hydrated output" },
          status: "completed",
          timestamp,
        }],
      },
    });
    const incoming = createChat({
      state: {
        id: "chat-1",
        status: "idle",
        lastActivityAt: "2025-01-01T00:00:02.000Z",
        messages: [],
        logs: [],
        toolCalls: [],
      },
    });

    const merged = mergeChatSummarySnapshot(current, incoming);

    expect(merged.state.messages).toEqual(current.state.messages);
    expect(merged.state.logs).toEqual(current.state.logs);
    expect(merged.state.toolCalls).toEqual(current.state.toolCalls);
  });
});
