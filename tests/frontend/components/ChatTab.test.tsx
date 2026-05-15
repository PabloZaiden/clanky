import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppEventsProvider, useToast } from "@/hooks";
import { ChatTab } from "@/components/loop-details/chat-tab";
import type { Chat } from "@/types";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";

const api = createMockApi();
const ws = createMockWebSocket();

function createLoopChat(): Chat {
  return {
    config: {
      id: "loop-chat-1",
      name: "Loop Chat",
      workspaceId: "workspace-1",
      directory: "/workspace/repo/.ralph-worktrees/loop-1",
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
      scope: "loop",
      loopId: "loop-1",
    },
    state: {
      id: "loop-chat-1",
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
    api.get("/api/chats/:id", () => createLoopChat());
    api.post("/api/loops/:id/chat", () => createLoopChat(), 201);
    ws.reset();
    ws.install();
  });

  afterEach(() => {
    api.uninstall();
    ws.uninstall();
  });

  test("does not recreate the loop chat when unrelated toast updates rerender the provider", async () => {
    const { getByRole, getByText, user } = renderWithUser(
      <>
        <ToastTrigger />
        <AppEventsProvider>
          <ChatTab loopId="loop-1" />
        </AppEventsProvider>
      </>,
    );

    await waitFor(() => {
      expect(getByText("No messages yet")).toBeTruthy();
    });
    expect(api.calls("/api/loops/:id/chat", "POST")).toHaveLength(1);

    await user.click(getByRole("button", { name: "Trigger toast" }));

    await waitFor(() => {
      expect(api.calls("/api/loops/:id/chat", "POST")).toHaveLength(1);
    });
  });
});
