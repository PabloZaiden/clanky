import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AppShell } from "@/components/AppShell";
import type { ShellRoute } from "@/components/AppShell";
import { AppEventsProvider, type UsePasskeyAuthResult } from "@/hooks";
import { createWorkspace } from "../helpers/factories";
import { createMockApi } from "../helpers/mock-api";
import { renderWithUser, waitFor } from "../helpers/render";

const api = createMockApi();

const passkeyAuth: UsePasskeyAuthResult = {
  status: {
    passkeyConfigured: false,
    passkeyDisabled: false,
    passkeyRequired: false,
    authenticated: false,
  },
  loading: false,
  refreshing: false,
  authenticating: false,
  registering: false,
  loggingOut: false,
  removingPasskey: false,
  error: null,
  clearError: mock(() => {}),
  refreshStatus: mock(async () => {}),
  loginWithPasskey: mock(async () => true),
  registerPasskey: mock(async () => true),
  logout: mock(async () => true),
  removePasskey: mock(async () => true),
};

function installSuccessfulQuickChatApi() {
  api.get("/api/workspaces", () => [
    createWorkspace({
      id: "workspace-quick",
      name: "Quick Workspace",
      directory: "/workspaces/quick",
    }),
  ]);
  api.get("/api/preferences/quick-chat", () => ({
    workspaceId: "workspace-quick",
    model: {
      providerID: "copilot",
      modelID: "gpt-5.5",
      variant: "",
    },
  }));
}

function installUnexpectedQuickChatPreflightApi() {
  const unexpectedPreflight = (endpoint: string) => () => {
    throw new Error(`Quick chat should not call ${endpoint} before creating the chat`);
  };

  api.get("/api/models", unexpectedPreflight("/api/models"));
  api.get("/api/git/default-branch", unexpectedPreflight("/api/git/default-branch"));
  api.get("/api/git/branches", unexpectedPreflight("/api/git/branches"));
}

describe("AppShell quick chat", () => {
  beforeEach(() => {
    api.reset();
    api.install();
  });

  afterEach(() => {
    api.uninstall();
  });

  test("creates a quick chat with configured workspace, model, and worktree without waiting for preflight", async () => {
    installSuccessfulQuickChatApi();
    installUnexpectedQuickChatPreflightApi();
    api.post("/api/chats", (req) => ({
      config: {
        id: "chat-created",
        name: "Quick Chat",
        workspaceId: "workspace-quick",
        directory: "/workspaces/quick",
        model: (req.body as { model: unknown }).model,
        useWorktree: true,
        autoApprovePermissions: true,
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
        mode: "chat",
        scope: "workspace",
      },
      state: {
        id: "chat-created",
        status: "idle",
        messages: [],
        logs: [],
        toolCalls: [],
      },
    }));
    const navigate = mock((_route: ShellRoute) => {});

    const { getByRole, user } = renderWithUser(
      <AppEventsProvider>
        <AppShell route={{ view: "home" }} onNavigate={navigate} passkeyAuth={passkeyAuth} />
      </AppEventsProvider>,
    );

    await user.click(await waitFor(() => getByRole("button", { name: "Start quick chat" })));

    await waitFor(() => {
      expect(api.calls("/api/chats", "POST")).toHaveLength(1);
      expect(navigate).toHaveBeenCalledWith({ view: "chat", chatId: "chat-created" });
    });
    expect(api.calls("/api/chats", "POST")[0]?.body).toEqual({
      workspaceId: "workspace-quick",
      model: {
        providerID: "copilot",
        modelID: "gpt-5.5",
        variant: "",
      },
      useWorktree: true,
      autoApprovePermissions: true,
    });
    expect(api.calls("/api/models", "GET")).toHaveLength(0);
    expect(api.calls("/api/git/default-branch", "GET")).toHaveLength(0);
    expect(api.calls("/api/git/branches", "GET")).toHaveLength(0);
  });

  test("opens settings without creating a chat when quick chat workspace is missing", async () => {
    api.get("/api/workspaces", () => []);
    api.get("/api/preferences/quick-chat", () => ({
      workspaceId: "missing-workspace",
      model: {
        providerID: "copilot",
        modelID: "gpt-5.5",
        variant: "",
      },
    }));
    const navigate = mock((_route: ShellRoute) => {});

    const { getByRole, user } = renderWithUser(
      <AppEventsProvider>
        <AppShell route={{ view: "home" }} onNavigate={navigate} passkeyAuth={passkeyAuth} />
      </AppEventsProvider>,
    );

    await user.click(await waitFor(() => getByRole("button", { name: "Configure quick chat" })));

    expect(api.calls("/api/chats", "POST")).toHaveLength(0);
    expect(navigate).toHaveBeenCalledWith({ view: "settings" });
  });
});
