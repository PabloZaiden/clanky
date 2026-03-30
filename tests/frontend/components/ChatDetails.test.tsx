import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Chat } from "@/types";
import { ChatDetails } from "@/components/ChatDetails";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { act, renderWithUser, waitFor } from "../helpers/render";

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
    },
    state: {
      id: CHAT_ID,
      status: "idle",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Help me inspect the diff",
          timestamp: "2025-01-01T00:00:00.000Z",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Sure, let me take a look.",
          timestamp: "2025-01-01T00:00:01.000Z",
        },
      ],
      logs: [],
      toolCalls: [],
      ...(overrides?.state ?? {}),
    },
  };
}

beforeEach(() => {
  api.reset();
  api.install();
  api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
  ws.reset();
  ws.install();
});

afterEach(() => {
  api.uninstall();
  ws.uninstall();
});

describe("ChatDetails", () => {
  test("renders the transcript and sends a new message", async () => {
    const initialChat = createChat();
    const updatedChat = createChat({
      config: {
        ...initialChat.config,
        updatedAt: "2025-01-01T00:00:02.000Z",
      },
      state: {
        ...initialChat.state,
        status: "streaming",
        messages: [
          ...initialChat.state.messages,
          {
            id: "user-2",
            role: "user",
            content: "Please summarize the risk.",
            timestamp: "2025-01-01T00:00:02.000Z",
          },
        ],
      },
    });

    api.get("/api/chats/:id", () => initialChat);
    api.post("/api/chats/:id/messages", () => updatedChat, 200);

    const { getByText, getByLabelText, getByRole, user } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByText("Repo pairing")).toBeTruthy();
    });
    expect(getByText("Sure, let me take a look.")).toBeTruthy();

    await user.type(getByLabelText("Message"), "Please summarize the risk.");
    await user.click(getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(getByText("Please summarize the risk.")).toBeTruthy();
    });

    const sendCalls = api.calls("/api/chats/:id/messages", "POST");
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.body).toMatchObject({
      message: "Please summarize the risk.",
    });
  });

  test("shows interrupt while active and posts interrupt requests", async () => {
    const streamingChat = createChat({
      state: {
        id: CHAT_ID,
        status: "streaming",
        session: { id: "session-1" },
        messages: [],
        logs: [],
        toolCalls: [],
      },
    });
    const interruptedChat = createChat({
      state: {
        ...streamingChat.state,
        status: "stopped",
      },
    });

    api.get("/api/chats/:id", () => streamingChat);
    api.post("/api/chats/:id/interrupt", () => interruptedChat, 200);

    const { getByRole, user } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Interrupt" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Interrupt" }));

    await waitFor(() => {
      expect(getByRole("button", { name: "Reconnect" })).toBeTruthy();
    });

    expect(api.calls("/api/chats/:id/interrupt", "POST")).toHaveLength(1);
  });

  test("applies chat-scoped websocket message updates", async () => {
    api.get("/api/chats/:id", () => createChat({
      state: {
        id: CHAT_ID,
        status: "idle",
        messages: [],
        logs: [],
        toolCalls: [],
      },
    }));

    const { getByText } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByText("Repo pairing")).toBeTruthy();
    });

    const connection = ws.connections().find((item) => item.queryParams["chatId"] === CHAT_ID);
    expect(connection).toBeTruthy();

    await act(async () => {
      ws.sendEventTo(connection!, {
        type: "chat.message",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:03.000Z",
        message: {
          id: "assistant-2",
          role: "assistant",
          content: "The main risk is the missing reconnect guard.",
          timestamp: "2025-01-01T00:00:03.000Z",
        },
      });
    });

    await waitFor(() => {
      expect(getByText("The main risk is the missing reconnect guard.")).toBeTruthy();
    });
  });
});
