import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { AppEventsProvider } from "@/hooks";
import { useChats } from "@/hooks/useChats";
import { DEFAULT_CHAT_INTERRUPT_REASON, type Chat } from "@/types";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";

const api = createMockApi();
const ws = createMockWebSocket();
const CHAT_ID = "chat-1";

function createChat(overrides?: Partial<Chat>): Chat {
  return {
    config: {
      id: CHAT_ID,
      name: "Repo pairing",
      workspaceId: "workspace-1",
      directory: "/workspace/repo",
      model: {
        providerID: "github",
        modelID: "gpt-5.4",
        variant: "",
      },
      useWorktree: true,
      baseBranch: "main",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      mode: "chat",
      ...(overrides?.config ?? {}),
      scope: overrides?.config?.scope ?? "workspace",
      loopId: overrides?.config?.loopId,
    },
    state: {
      id: CHAT_ID,
      status: "idle",
      messages: [],
      logs: [],
      toolCalls: [],
      ...(overrides?.state ?? {}),
    },
  };
}

beforeEach(() => {
  api.reset();
  api.install();
  ws.reset();
  ws.install();
});

afterEach(() => {
  api.uninstall();
  ws.uninstall();
});

describe("useChats", () => {
  test("merges stale chat.updated snapshots without overwriting newer state", async () => {
    const baseChat = createChat();
    const currentChat = createChat({
      config: {
        ...baseChat.config,
        updatedAt: "2025-01-01T00:00:03.000Z",
      },
      state: {
        ...baseChat.state,
        id: CHAT_ID,
        status: "streaming",
        lastActivityAt: "2025-01-01T00:00:05.000Z",
        messages: [
          {
            id: "assistant-2",
            role: "assistant",
            content: "Fresh transcript content",
            timestamp: "2025-01-01T00:00:05.000Z",
          },
        ],
        logs: [],
        toolCalls: [],
      },
    });

    api.get("/api/chats", () => [
      currentChat,
    ]);

    const { result } = renderHook(() => useChats(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.chats).toHaveLength(1);

    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    act(() => {
      ws.sendEvent({
        type: "chat.updated",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:06.000Z",
        chat: createChat({
          config: {
            ...baseChat.config,
            name: "Renamed pairing",
            updatedAt: "2025-01-01T00:00:06.000Z",
          },
          state: {
            ...baseChat.state,
            id: CHAT_ID,
            status: "idle",
            lastActivityAt: "2025-01-01T00:00:04.000Z",
            messages: [
              {
                id: "assistant-1",
                role: "assistant",
                content: "Stale transcript content",
                timestamp: "2025-01-01T00:00:04.000Z",
              },
            ],
            logs: [],
            toolCalls: [],
          },
        }),
      });
    });

    await waitFor(() => {
      expect(result.current.chats[0]?.config.name).toBe("Renamed pairing");
    });

    expect(result.current.chats[0]?.state.lastActivityAt).toBe("2025-01-01T00:00:05.000Z");
    expect(result.current.chats[0]?.state.messages).toEqual([
      {
        id: "assistant-2",
        role: "assistant",
        content: "Fresh transcript content",
        timestamp: "2025-01-01T00:00:05.000Z",
      },
    ]);
  });

  test("sends the default interrupt reason when callers omit one", async () => {
    const baseChat = createChat();
    const interruptedChat = createChat({
      state: {
        ...baseChat.state,
        status: "interrupting",
      },
    });

    api.get("/api/chats", () => [baseChat]);
    api.post("/api/chats/:id/interrupt", () => interruptedChat, 200);

    const { result } = renderHook(() => useChats(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.interruptChat(CHAT_ID);
    });

    const interruptCalls = api.calls("/api/chats/:id/interrupt", "POST");
    expect(interruptCalls).toHaveLength(1);
    expect(interruptCalls[0]?.body).toEqual({ reason: DEFAULT_CHAT_INTERRUPT_REASON });
  });

  test("applies event-driven status updates without fetching full chat history", async () => {
    const workspaceChat = createChat({
      state: {
        ...createChat().state,
        status: "failed",
        error: {
          message: "Previous failure",
          timestamp: "2025-01-01T00:00:01.000Z",
        },
      },
    });

    api.get("/api/chats", () => [workspaceChat]);

    const { result } = renderHook(() => useChats(), { wrapper: AppEventsProvider });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await waitFor(() => {
      expect(ws.connections().length).toBeGreaterThan(0);
    });

    act(() => {
      ws.sendEvent({
        type: "chat.status",
        chatId: workspaceChat.config.id,
        scope: "workspace",
        status: "streaming",
        timestamp: "2025-01-01T00:00:03.000Z",
      });
    });

    await waitFor(() => {
      expect(result.current.chats[0]?.state.status).toBe("streaming");
    });
    expect(result.current.chats[0]?.state.error).toBeUndefined();
    expect(result.current.chats[0]?.config.name).toBe("Repo pairing");
    expect(api.calls("/api/chats/:id", "GET")).toHaveLength(0);
  });
});
