import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppEventsProvider, useToast } from "@/hooks";
import { ChatTab } from "@/components/task-details/chat-tab";
import type { Chat } from "@/types";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";

const api = createMockApi();
const ws = createMockWebSocket();

function createTaskChat(): Chat {
  return {
    config: {
      id: "task-chat-1",
      name: "Task Chat",
      workspaceId: "workspace-1",
      directory: "/workspace/repo/.clanky-worktrees/task-1",
      model: {
        providerID: "github",
        modelID: "gpt-5.4",
        variant: "",
      },
      useWorktree: false,
      baseBranch: "main",
      createdAt: "2026-04-28T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:00.000Z",
      mode: "chat",
      scope: "task",
      taskId: "task-1",
    },
    state: {
      id: "task-chat-1",
      status: "idle",
      messages: [],
      logs: [],
      toolCalls: [],
    },
  };
}

function ToastTrigger() {
  const { error } = useToast();

  return (
    <button type="button" onClick={() => error("Trigger toast rerender")}>
      Trigger toast
    </button>
  );
}

describe("ChatTab", () => {
  beforeEach(() => {
    api.reset();
    api.install();
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/models", () => []);
    api.get("/api/chats/:id", () => createTaskChat());
    api.post("/api/tasks/:id/chat", () => createTaskChat(), 201);
    ws.reset();
    ws.install();
  });

  afterEach(() => {
    api.uninstall();
    ws.uninstall();
  });

  test("does not recreate the task chat when unrelated toast updates rerender the provider", async () => {
    const { getByRole, getByText, user } = renderWithUser(
      <>
        <ToastTrigger />
        <AppEventsProvider>
          <ChatTab taskId="task-1" />
        </AppEventsProvider>
      </>,
    );

    await waitFor(() => {
      expect(getByText("No messages yet")).toBeTruthy();
    });
    expect(api.calls("/api/tasks/:id/chat", "POST")).toHaveLength(1);

    await user.click(getByRole("button", { name: "Trigger toast" }));

    await waitFor(() => {
      expect(api.calls("/api/tasks/:id/chat", "POST")).toHaveLength(1);
    });
  });
});
