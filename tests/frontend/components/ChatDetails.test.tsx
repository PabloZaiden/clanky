import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Chat } from "@/types";
import { ChatDetails } from "@/components/ChatDetails";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { act, renderWithUser, waitFor } from "../helpers/render";
import { createLoop } from "../helpers/factories";

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
    const composer = getByLabelText("Message") as HTMLTextAreaElement;
    expect(composer.tagName).toBe("TEXTAREA");
    expect(composer.getAttribute("rows")).toBe("1");
    expect(composer.placeholder).toBe("");
    expect(composer.className).toContain("min-h-[38px]");
    expect(queryByText("Assistant")).toBeNull();
    expect(queryByText("You")).toBeNull();
    expect(queryByText("Enter adds a new line. Press Ctrl+Enter or Cmd+Enter to send.")).toBeNull();

    await user.type(composer, "Please summarize the risk.");
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

  test("renames the chat from the header actions", async () => {
    const initialChat = createChat();
    const renamedChat = createChat({
      config: {
        ...initialChat.config,
        name: "Renamed pairing",
        updatedAt: "2025-01-01T00:00:02.000Z",
      },
    });

    api.get("/api/chats/:id", () => initialChat);
    api.patch("/api/chats/:id", () => renamedChat, 200);

    const { getByRole, getByLabelText, getByText, user } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByText("Repo pairing")).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Chat actions" }));
    await user.click(getByRole("menuitem", { name: "Rename" }));

    const input = await waitFor(() => getByLabelText("Chat Name")) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Renamed pairing");
    await user.click(getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(getByText("Renamed pairing")).toBeTruthy();
      expect(api.calls("/api/chats/:id", "PATCH")).toHaveLength(1);
    });

    expect(api.calls("/api/chats/:id", "PATCH")[0]?.body).toMatchObject({
      name: "Renamed pairing",
    });
  });

  test("spawns a loop from the current chat transcript", async () => {
    const initialChat = createChat();
    const spawnedLoop = createLoop({
      config: {
        id: "loop-1",
        name: "Plan from Repo pairing",
        workspaceId: initialChat.config.workspaceId,
        prompt: "Use the following chat transcript as background context for this loop.",
        planMode: true,
      },
      state: {
        status: "planning",
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: false,
        },
      },
    });
    let openedLoopId: string | null = null;

    api.get("/api/chats/:id", () => initialChat);
    api.post("/api/chats/:id/spawn-loop", () => spawnedLoop);

    const { getByRole, user } = renderWithUser(
      <ChatDetails
        chatId={CHAT_ID}
        onOpenLoop={(loopId) => {
          openedLoopId = loopId;
        }}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: "Chat actions" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Chat actions" }));
    await user.click(getByRole("menuitem", { name: "Spawn Loop" }));

    await waitFor(() => {
      expect(openedLoopId).toBe("loop-1");
    });

    expect(api.calls("/api/chats/:id/spawn-loop", "POST")).toHaveLength(1);
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

  test("inserts a newline instead of submitting on plain Enter", async () => {
    const initialChat = createChat();
    api.get("/api/chats/:id", () => initialChat);
    api.post("/api/chats/:id/messages", () => initialChat, 200);

    const { getByLabelText, user } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    const composer = await waitFor(() => getByLabelText("Message")) as HTMLTextAreaElement;
    expect(composer.getAttribute("rows")).toBe("1");

    await user.type(composer, "First line{enter}Second line");

    expect(composer.value).toBe("First line\nSecond line");
    expect(composer.getAttribute("rows")).toBe("2");
    expect(composer.className).toContain("min-h-[58px]");
    expect(api.calls("/api/chats/:id/messages", "POST")).toHaveLength(0);
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

  test("does not request reconnect while the chat websocket is healthy", async () => {
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
    api.post("/api/chats/:id/reconnect", () => createChat(), 200);

    renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(ws.connections().find((item) => item.queryParams["chatId"] === CHAT_ID)).toBeTruthy();
    });

    expect(api.calls("/api/chats/:id/reconnect", "POST")).toHaveLength(0);
  });

  test("updates a streamed assistant message in place from websocket message events", async () => {
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
        type: "chat.message",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:02.000Z",
        message: {
          id: "assistant-streaming",
          role: "assistant",
          content: "Partial answer",
          timestamp: "2025-01-01T00:00:02.000Z",
        },
      });
      ws.sendEventTo(connection!, {
        type: "chat.message",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:03.000Z",
        message: {
          id: "assistant-streaming",
          role: "assistant",
          content: "Partial answer completed",
          timestamp: "2025-01-01T00:00:03.000Z",
        },
      });
    });

    await waitFor(() => {
      expect(getByText("Partial answer completed")).toBeTruthy();
    });

    expect(queryByText("Partial answer")).toBeNull();
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

  test("ignores stale interrupt websocket events after newer chat activity", async () => {
    api.get("/api/chats/:id", () => createChat({
      state: {
        id: CHAT_ID,
        status: "idle",
        lastActivityAt: "2025-01-01T00:00:10.000Z",
        messages: [],
        logs: [],
        toolCalls: [],
      },
    }));

    const { getByText } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByText("Idle")).toBeTruthy();
    });

    const connection = ws.connections().find((item) => item.queryParams["chatId"] === CHAT_ID);
    expect(connection).toBeTruthy();

    await act(async () => {
      ws.sendEventTo(connection!, {
        type: "chat.status",
        chatId: CHAT_ID,
        status: "streaming",
        timestamp: "2025-01-01T00:00:05.000Z",
      });
      ws.sendEventTo(connection!, {
        type: "chat.interrupted",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:05.500Z",
      });
    });

    expect(getByText("Idle")).toBeTruthy();
  });

  test("ignores stale cancellation errors after newer chat activity", async () => {
    api.get("/api/chats/:id", () => createChat({
      state: {
        id: CHAT_ID,
        status: "idle",
        lastActivityAt: "2025-01-01T00:00:10.000Z",
        messages: [],
        logs: [],
        toolCalls: [],
      },
    }));

    const { getByText, queryByText } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByText("Idle")).toBeTruthy();
    });

    const connection = ws.connections().find((item) => item.queryParams["chatId"] === CHAT_ID);
    expect(connection).toBeTruthy();

    await act(async () => {
      ws.sendEventTo(connection!, {
        type: "chat.error",
        chatId: CHAT_ID,
        message: "Operation cancelled by user",
        timestamp: "2025-01-01T00:00:05.000Z",
      });
    });

    expect(queryByText("Operation cancelled by user")).toBeNull();
    expect(getByText("Idle")).toBeTruthy();
  });

  test("does not render response logs in chat mode when websocket events stream response log updates", async () => {
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
      expect(getByText("Repo pairing")).toBeTruthy();
    });

    expect(queryByText("Alpha chunk")).toBeNull();
    expect(queryByText("Bravo final chunk")).toBeNull();
  });

  test("keeps reasoning between separate assistant response blocks during websocket updates", async () => {
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

    const { container, getByText, queryByText } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByText("Repo pairing")).toBeTruthy();
    });

    const connection = ws.connections().find((item) => item.queryParams["chatId"] === CHAT_ID);
    expect(connection).toBeTruthy();

    await act(async () => {
      ws.sendEventTo(connection!, {
        type: "chat.message",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:02.000Z",
        message: {
          id: "assistant-part-1",
          role: "assistant",
          content: "Alpha response",
          timestamp: "2025-01-01T00:00:02.000Z",
        },
      });
      ws.sendEventTo(connection!, {
        type: "chat.log",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:03.000Z",
        log: {
          id: "reasoning-1",
          level: "agent",
          message: "AI reasoning...",
          details: {
            logKind: "reasoning",
            responseContent: "Need more context.",
          },
          timestamp: "2025-01-01T00:00:03.000Z",
        },
      });
      ws.sendEventTo(connection!, {
        type: "chat.message",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:04.000Z",
        message: {
          id: "assistant-part-2",
          role: "assistant",
          content: "Beta after reasoning",
          timestamp: "2025-01-01T00:00:04.000Z",
        },
      });
      ws.sendEventTo(connection!, {
        type: "chat.log",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:05.000Z",
        log: {
          id: "reasoning-1",
          level: "agent",
          message: "AI reasoning...",
          details: {
            logKind: "reasoning",
            responseContent: "Need more context, refined.",
          },
          timestamp: "2025-01-01T00:00:03.000Z",
        },
      });
    });

    await waitFor(() => {
      expect(getByText("Alpha response")).toBeTruthy();
      expect(getByText("Need more context, refined.")).toBeTruthy();
      expect(getByText("Beta after reasoning")).toBeTruthy();
    });

    expect(queryByText("Need more context.")).toBeNull();

    const transcript = container.querySelector("#chat-transcript");
    const text = transcript?.textContent ?? "";
    expect(text.indexOf("Alpha response")).toBeLessThan(text.indexOf("Need more context, refined."));
    expect(text.indexOf("Need more context, refined.")).toBeLessThan(text.indexOf("Beta after reasoning"));
  });

  test("keeps a tool entry between separate assistant response blocks during websocket updates", async () => {
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

    const { container, getByText } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByText("Repo pairing")).toBeTruthy();
    });

    const connection = ws.connections().find((item) => item.queryParams["chatId"] === CHAT_ID);
    expect(connection).toBeTruthy();

    await act(async () => {
      ws.sendEventTo(connection!, {
        type: "chat.message",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:02.000Z",
        message: {
          id: "assistant-part-1",
          role: "assistant",
          content: "Alpha before tool",
          timestamp: "2025-01-01T00:00:02.000Z",
        },
      });
      ws.sendEventTo(connection!, {
        type: "chat.tool_call",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:03.000Z",
        tool: {
          id: "tool-1",
          name: "read",
          input: { path: "/workspace/repo/README.md" },
          output: { content: "README contents" },
          status: "completed",
          timestamp: "2025-01-01T00:00:03.000Z",
        },
      });
      ws.sendEventTo(connection!, {
        type: "chat.message",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:04.000Z",
        message: {
          id: "assistant-part-2",
          role: "assistant",
          content: "Beta after tool",
          timestamp: "2025-01-01T00:00:04.000Z",
        },
      });
    });

    await waitFor(() => {
      expect(getByText("Alpha before tool")).toBeTruthy();
      expect(getByText("Read /workspace/repo/README.md")).toBeTruthy();
      expect(getByText("Beta after tool")).toBeTruthy();
    });

    const transcript = container.querySelector("#chat-transcript");
    const text = transcript?.textContent ?? "";
    expect(text.indexOf("Alpha before tool")).toBeLessThan(text.indexOf("Read /workspace/repo/README.md"));
    expect(text.indexOf("Read /workspace/repo/README.md")).toBeLessThan(text.indexOf("Beta after tool"));
  });

  test("preserves newer local state when chat.updated carries a stale snapshot", async () => {
    const currentChat = createChat({
      config: {
        ...createChat().config,
        id: CHAT_ID,
        name: "Repo pairing",
        updatedAt: "2025-01-01T00:00:03.000Z",
      },
      state: {
        ...createChat().state,
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
    api.get("/api/chats/:id", () => currentChat);

    const { getByText, queryByText } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByText("Repo pairing")).toBeTruthy();
      expect(getByText("Fresh transcript content")).toBeTruthy();
    });

    const connection = ws.connections().find((item) => item.queryParams["chatId"] === CHAT_ID);
    expect(connection).toBeTruthy();

    await act(async () => {
      ws.sendEventTo(connection!, {
        type: "chat.updated",
        chatId: CHAT_ID,
        timestamp: "2025-01-01T00:00:06.000Z",
        chat: createChat({
          config: {
            ...currentChat.config,
            id: CHAT_ID,
            name: "Renamed pairing",
            updatedAt: "2025-01-01T00:00:06.000Z",
          },
          state: {
            ...currentChat.state,
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
      expect(getByText("Renamed pairing")).toBeTruthy();
      expect(getByText("Fresh transcript content")).toBeTruthy();
    });

    expect(queryByText("Stale transcript content")).toBeNull();
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

    await user.click(getByRole("button", { name: "Chat actions" }));
    await user.click(getByRole("menuitem", { name: "Delete" }));
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

  test("opens the code explorer for the chat context", async () => {
    api.get("/api/chats/:id", () => createChat());
    let openedChatId = "";

    const { getByRole, user } = renderWithUser(
      <ChatDetails
        chatId={CHAT_ID}
        onOpenCodeExplorer={(chatId: string) => {
          openedChatId = chatId;
        }}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: "Chat actions" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Chat actions" }));
    await user.click(getByRole("menuitem", { name: "Code explorer" }));

    expect(openedChatId).toBe(CHAT_ID);
  });

  test("renders chat header actions in a single plus menu while keeping focus mode separate", async () => {
    const baseChat = createChat();
    const longChat = createChat({
      config: {
        ...baseChat.config,
        name: "Repo pairing with a very long mobile title that should stay compact",
        directory: "/workspaces/retailstoreagent",
      },
      state: {
        ...baseChat.state,
        worktree: {
          worktreePath: "/workspaces/retailstoreagent/.ralph-worktrees/96635141-fc99-4798-8cbb-7b94e3dfc905",
          workingBranch: "chat-ltimos-cambios-en-prompts-96635141",
          originalBranch: "main",
        },
      },
    });

    api.get("/api/chats/:id", () => longChat);

    const { getByRole, getByText, queryByRole, user } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    const heading = await waitFor(() => getByText(longChat.config.name));
    expect(heading.className).toContain("truncate");

    const transcriptMetadata = getByText(`${longChat.config.directory} · ${longChat.state.worktree?.worktreePath}`);
    expect(transcriptMetadata.className).toContain("truncate");

    const branchMetadata = getByText(longChat.state.worktree?.workingBranch ?? "");
    expect(branchMetadata.className).toContain("truncate");

    expect(getByRole("button", { name: "Enter focus mode" })).toBeTruthy();
    expect(getByRole("button", { name: "Chat actions" })).toBeTruthy();
    expect(queryByRole("button", { name: "Spawn loop" })).toBeNull();
    expect(queryByRole("button", { name: "Delete chat" })).toBeNull();
    expect(queryByRole("button", { name: "Code explorer" })).toBeNull();
    expect(queryByRole("button", { name: "Rename" })).toBeNull();

    await user.click(getByRole("button", { name: "Chat actions" }));

    expect(getByRole("menuitem", { name: "Spawn Loop" })).toBeTruthy();
    expect(getByRole("menuitem", { name: "Code explorer" })).toBeTruthy();
    expect(getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  test("opens rename from the header action menu", async () => {
    api.get("/api/chats/:id", () => createChat());

    const { getByRole, getByLabelText, user } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Chat actions" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Chat actions" }));
    await user.click(getByRole("menuitem", { name: "Rename" }));

    expect(await waitFor(() => getByLabelText("Chat Name"))).toBeTruthy();
  });

  test("disables code explorer actions when no code explorer handler is provided", async () => {
    api.get("/api/chats/:id", () => createChat());

    const { getByRole, user } = renderWithUser(<ChatDetails chatId={CHAT_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Chat actions" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Chat actions" }));

    const codeExplorerItem = getByRole("menuitem", { name: "Code explorer" }) as HTMLButtonElement;
    expect(codeExplorerItem.disabled).toBe(true);
  });
});
