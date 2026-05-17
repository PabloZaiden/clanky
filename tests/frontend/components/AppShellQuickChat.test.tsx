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
  api.get("/api/models", () => [
    {
      providerID: "copilot",
      providerName: "Copilot",
      modelID: "gpt-5.5",
      modelName: "GPT-5.5",
      connected: true,
      variants: [""],
    },
  ]);
  api.get("/api/git/default-branch", () => ({ defaultBranch: "main" }));
  api.get("/api/git/branches", () => ({
    currentBranch: "feature",
    branches: [{ name: "feature", current: true }],
  }));
}

describe("AppShell quick chat", () => {
  beforeEach(() => {
    api.reset();
    api.install();
  });

  afterEach(() => {
    api.uninstall();
  });

  test("creates a quick chat with configured workspace, model, and worktree", async () => {
    installSuccessfulQuickChatApi();
    api.post("/api/chats", (req) => ({
      config: {
        id: "chat-created",
        name: "Quick Chat",
        workspaceId: "workspace-quick",
        directory: "/workspaces/quick",
        model: (req.body as { model: unknown }).model,
        useWorktree: true,
        autoApprovePermissions: true,
        baseBranch: "main",
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
      baseBranch: "main",
    });
  });

  test("fails gracefully without creating a chat when quick chat workspace is missing", async () => {
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

    const { findByText, getByRole, user } = renderWithUser(
      <AppEventsProvider>
        <AppShell route={{ view: "home" }} onNavigate={navigate} passkeyAuth={passkeyAuth} />
      </AppEventsProvider>,
    );

    await user.click(await waitFor(() => getByRole("button", { name: "Start quick chat" })));

    expect(await findByText("The selected quick chat workspace no longer exists")).toBeInTheDocument();
    expect(api.calls("/api/chats", "POST")).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
  });
});
