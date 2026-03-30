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

    const { getByText, getByLabelText, getByRole, queryByText, user } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByText("Repo pairing")).toBeTruthy();
    });
    expect(getByText("Sure, let me take a look.")).toBeTruthy();
    expect((getByLabelText("Message") as HTMLInputElement).tagName).toBe("INPUT");
    expect(queryByText("Assistant")).toBeNull();
    expect(queryByText("You")).toBeNull();

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
      expect(getByRole("button", { name: "Send" })).toBeTruthy();
    });

    expect(api.calls("/api/chats/:id/interrupt", "POST")).toHaveLength(1);
  });

  test("submits the composer with Ctrl+Enter", async () => {
    const initialChat = createChat();
    const updatedChat = createChat({
      state: {
        ...initialChat.state,
        status: "streaming",
        messages: [
          ...initialChat.state.messages,
          {
            id: "user-2",
            role: "user",
            content: "Send on shortcut",
            timestamp: "2025-01-01T00:00:02.000Z",
          },
        ],
      },
    });

    api.get("/api/chats/:id", () => initialChat);
    api.post("/api/chats/:id/messages", () => updatedChat, 200);

    const { getByLabelText, user } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByLabelText("Message")).toBeTruthy();
    });

    await user.type(getByLabelText("Message"), "Send on shortcut");
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => {
      expect(api.calls("/api/chats/:id/messages", "POST")).toHaveLength(1);
    });
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

  test("treats interrupt websocket events as returning to idle", async () => {
    api.get("/api/chats/:id", () => createChat({
      state: {
        id: CHAT_ID,
        status: "streaming",
        session: { id: "session-1" },
        messages: [],
        logs: [],
        toolCalls: [],
      },
    }));

    const { getByText } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByText("Streaming")).toBeTruthy();
    });

    const connection = ws.connections().find((item) => item.queryParams["chatId"] === CHAT_ID);
    expect(connection).toBeTruthy();

    await act(async () => {
      ws.sendEventTo(connection!, {
        type: "chat.interrupted",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:05.000Z",
      });
    });

    await waitFor(() => {
      expect(getByText("Idle")).toBeTruthy();
    });
  });

  test("updates streaming logs in place when websocket events reuse the same log id", async () => {
    api.get("/api/chats/:id", () => createChat({
      state: {
        id: CHAT_ID,
        status: "streaming",
        session: { id: "session-1" },
        messages: [],
        logs: [],
        toolCalls: [],
      },
    }));

    const { getByText, queryByText } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByText("Repo pairing")).toBeTruthy();
    });

    const connection = ws.connections().find((item) => item.queryParams["chatId"] === CHAT_ID);
    expect(connection).toBeTruthy();

    await act(async () => {
      ws.sendEventTo(connection!, {
        type: "chat.log",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:02.000Z",
        log: {
          id: "log-1",
          level: "agent",
          message: "AI generating response...",
          details: {
            logKind: "response",
            responseContent: "Alpha chunk",
          },
          timestamp: "2025-01-01T00:00:02.000Z",
        },
      });
      ws.sendEventTo(connection!, {
        type: "chat.log",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:03.000Z",
        log: {
          id: "log-1",
          level: "agent",
          message: "AI generating response...",
          details: {
            logKind: "response",
            responseContent: "Bravo final chunk",
          },
          timestamp: "2025-01-01T00:00:03.000Z",
        },
      });
    });

    await waitFor(() => {
      expect(getByText("Bravo final chunk")).toBeTruthy();
    });

    expect(queryByText("Alpha chunk")).toBeNull();
  });

  test("deletes the chat from the UI with confirmation", async () => {
    api.get("/api/chats/:id", () => createChat());
    api.delete("/api/chats/:id", () => ({ ok: true }), 200);
    let navigatedBack = false;

    const { getByRole, getByText, user } = renderWithUser(
      <ChatDetails chatId={CHAT_ID} onBack={() => {
        navigatedBack = true;
      }}
      />,
    );

    await waitFor(() => {
      expect(getByText("Repo pairing")).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Delete chat" }));
    await user.click(getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(api.calls("/api/chats/:id", "DELETE")).toHaveLength(1);
    });
    expect(navigatedBack).toBe(true);
  });

  test("supports focus mode for chat", async () => {
    api.get("/api/chats/:id", () => createChat());

    const { getByRole, queryByText, user } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Enter focus mode" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Enter focus mode" }));

    await waitFor(() => {
      expect(getByRole("button", { name: "Exit focus mode" })).toBeTruthy();
    });
    expect(queryByText("Repo pairing")).toBeNull();
  });
});
