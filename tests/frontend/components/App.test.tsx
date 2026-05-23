import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { App } from "@/App";
import { PASSKEY_AUTH_REQUIRED_EVENT } from "@/lib/public-path";
import type { Chat } from "@/types";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor, act, within } from "../helpers/render";
import { createTask, createTaskWithStatus, createSshSession, createWorkspace } from "../helpers/factories";
import { expectHamburgerIcon } from "../helpers/icon-assertions";

const api = createMockApi();
const ws = createMockWebSocket();

function resetDocumentTheme() {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  delete document.documentElement.dataset["themePreference"];
  delete document.documentElement.dataset["themeResolved"];
}

function isoNow(): string {
  return new Date().toISOString();
}

function createMatchMediaMock(matches: boolean): typeof window.matchMedia {
  return (query: string) =>
    ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

function createSshServer(overrides?: Partial<{
  id: string;
  name: string;
  address: string;
  username: string;
  repositoriesBasePath: string;
}>) {
  return {
    config: {
      id: overrides?.id ?? "server-1",
      name: overrides?.name ?? "Build host",
      address: overrides?.address ?? "server.example.com",
      username: overrides?.username ?? "ubuntu",
      repositoriesBasePath: overrides?.repositoriesBasePath,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    },
    publicKey: {
      algorithm: "RSA-OAEP-256" as const,
      publicKey: "test-key",
      fingerprint: "fingerprint",
      version: 1,
      createdAt: isoNow(),
    },
  };
}

function createStandaloneSession(serverId: string, overrides?: Partial<{ id: string; name: string }>) {
  return {
    config: {
      id: overrides?.id ?? "standalone-session-1",
      sshServerId: serverId,
      name: overrides?.name ?? "Standalone SSH",
      connectionMode: "dtach" as const,
      remoteSessionName: "clanky-standalone",
      createdAt: isoNow(),
      updatedAt: isoNow(),
    },
    state: {
      status: "ready",
    },
  };
}

function createChat(overrides?: {
  config?: Partial<Chat["config"]>;
  state?: Partial<Chat["state"]>;
}): Chat {
  return {
    config: {
      id: overrides?.config?.id ?? "chat-1",
      name: "Repo pairing",
      workspaceId: overrides?.config?.workspaceId ?? "workspace-1",
      directory: "/workspaces/test-project",
      model: {
        providerID: "github",
        modelID: "gpt-5.4",
        variant: "",
      },
      useWorktree: true,
      baseBranch: "main",
      createdAt: isoNow(),
      updatedAt: isoNow(),
      mode: "chat",
      ...(overrides?.config ?? {}),
      scope: overrides?.config?.scope ?? "workspace",
      taskId: overrides?.config?.taskId,
    },
    state: {
      id: overrides?.state?.id ?? overrides?.config?.id ?? "chat-1",
      status: "idle",
      messages: [],
      logs: [],
      toolCalls: [],
      ...(overrides?.state ?? {}),
    },
  };
}

function setupDefaultApi(options?: {
  tasks?: ReturnType<typeof createTask>[];
  chats?: Chat[];
  workspaces?: ReturnType<typeof createWorkspace>[];
  sshSessions?: ReturnType<typeof createSshSession>[];
  sshServers?: ReturnType<typeof createSshServer>[];
  standaloneSessionsByServerId?: Record<string, ReturnType<typeof createStandaloneSession>[]>;
}) {
  const tasks = options?.tasks ?? [];
  const chats = options?.chats ?? [];
  const workspaces = options?.workspaces ?? [];
  const sshSessions = options?.sshSessions ?? [];
  const sshServers = options?.sshServers ?? [];
  const standaloneSessionsByServerId = options?.standaloneSessionsByServerId ?? {};

  api.get("/api/tasks", () => tasks);
  api.get("/api/chats", () => chats);
  api.get("/api/workspaces", () => workspaces);
  api.get("/api/ssh-sessions", () => sshSessions);
  api.get("/api/ssh-servers", () => sshServers);
  api.get("/api/ssh-servers/:id/sessions", (req) => standaloneSessionsByServerId[req.params["id"]!] ?? []);
  api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/preferences/last-model", () => null);
  api.get("/api/preferences/log-level", () => ({ level: "info" }));
  api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
  api.get("/api/models", () => []);
  api.get("/api/tasks/:id", (req) => {
    return tasks.find((task) => task.config.id === req.params["id"])
      ?? createTask({ config: { id: req.params["id"], name: `Task ${req.params["id"]}` } });
  });
  api.get("/api/chats/:id", (req) => {
    const chatId = req.params["id"]!;
    return chats.find((chat) => chat.config.id === chatId)
      ?? createChat({ config: { id: chatId, name: `Chat ${chatId}` } });
  });
  api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
  api.get("/api/tasks/:id/diff", () => []);
  api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
  api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
  api.get("/api/tasks/:id/pull-request", () => ({
    enabled: false,
    destinationType: "disabled",
    disabledReason: "disabled",
  }));
  api.get("/api/tasks/:id/port-forwards", () => []);
  api.get("/api/ssh-sessions/:id", (req) => {
    return sshSessions.find((session) => session.config.id === req.params["id"])
      ?? createSshSession({ config: { id: req.params["id"]!, name: `SSH ${req.params["id"]!}` } });
  });
  api.get("/api/ssh-server-sessions/:id", (req) => {
    const session = Object.values(standaloneSessionsByServerId).flat().find((item) => item.config.id === req.params["id"]);
    if (!session) {
      throw new Error("Standalone session not found");
    }
    return session;
  });
  api.get("/api/ssh-servers/:id", (req) => {
    return sshServers.find((server) => server.config.id === req.params["id"])
      ?? createSshServer({ id: req.params["id"]! });
  });
}

beforeEach(() => {
  api.reset();
  api.install();
  ws.reset();
  ws.install();
  resetDocumentTheme();
  window.location.hash = "";
  setupDefaultApi();
});

afterEach(() => {
  api.uninstall();
  ws.uninstall();
  resetDocumentTheme();
  window.location.hash = "";
});

describe("App shell", () => {
  test("loads the persisted theme after passkey auth becomes available", async () => {
    let authenticated = false;
    api.get("/api/config", () => ({
      remoteOnly: false,
      passkeyAuth: {
        passkeyConfigured: true,
        passkeyDisabled: false,
        passkeyRequired: true,
        authenticated,
      },
      publicBasePath: null,
    }));
    api.get("/api/preferences/theme", () => ({ theme: "dark" }));

    const { getByRole } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Unlock Clanky" })).toBeTruthy();
      expect(api.calls("/api/preferences/theme", "GET")).toHaveLength(0);
    });

    authenticated = true;
    await act(() => {
      window.dispatchEvent(new Event(PASSKEY_AUTH_REQUIRED_EVENT));
    });

    await waitFor(() => {
      expect(api.calls("/api/preferences/theme", "GET")).toHaveLength(1);
      expect(document.documentElement.dataset["themePreference"]).toBe("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });
  });

  test("renders the shell overview by default without empty active work", async () => {
    const { getByRole, queryByRole, queryByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
      expect(getByRole("heading", { name: "Servers" })).toBeTruthy();
      expect(getByRole("heading", { name: "Workspaces" })).toBeTruthy();
    });

    const serversHeading = getByRole("heading", { name: "Servers" });
    const workspacesHeading = getByRole("heading", { name: "Workspaces" });

    expect(queryByRole("heading", { name: "Active Work" })).toBeNull();
    expect(serversHeading.compareDocumentPosition(workspacesHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(queryByText("Tracked repositories and hosts.")).toBeNull();
    expect(queryByText("Task-oriented Clanky tasks.")).toBeNull();
    expect(queryByText("Interactive conversations.")).toBeNull();
  });

  test("uses one global app event WebSocket across shell routes", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend" });
    const task = createTask({
      config: { id: "task-1", name: "Fix navbar", workspaceId: "workspace-1" },
      state: { id: "task-1", status: "running" },
    });
    const chat = createChat({ config: { id: "chat-1", workspaceId: "workspace-1" } });
    setupDefaultApi({ workspaces: [workspace], tasks: [task], chats: [chat] });

    const { getByRole } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
      expect(ws.getConnections("/api/ws")).toHaveLength(1);
    });

    window.location.hash = "#/task/task-1";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await waitFor(() => {
      expect(getByRole("heading", { name: "Fix navbar" })).toBeTruthy();
    });
    expect(ws.getConnections("/api/ws")).toHaveLength(1);
    expect(ws.getConnections("/api/ws?taskId=task-1")).toHaveLength(0);

    window.location.hash = "#/chat/chat-1";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await waitFor(() => {
      expect(getByRole("heading", { name: "Repo pairing" })).toBeTruthy();
    });
    expect(ws.getConnections("/api/ws")).toHaveLength(1);
    expect(ws.getConnections("/api/ws?chatId=chat-1")).toHaveLength(0);
  });

  test("wraps long server map and active work text inside the shell overview cards", async () => {
    const longServerName = `Server ${"super-long-hostname-".repeat(6)}`;
    const longAddress = `${"edge-node-".repeat(6)}example.internal`;
    const longTaskName = `Task ${"very-long-conversation-title-".repeat(5)}`;
    const longWorkspaceName = `Workspace ${"deeply-nested-project-".repeat(6)}repo`;

    const server = createSshServer({
      id: "server-wrap-1",
      name: longServerName,
      address: longAddress,
      username: "deploy",
    });
    const workspace = createWorkspace({
      id: "workspace-1",
      name: longWorkspaceName,
      directory: "/workspaces/wrap-lab",
    });
    const task = createTask({
      config: {
        id: "task-wrap-1",
        name: longTaskName,
        directory: "/workspaces/wrap-lab",
        workspaceId: workspace.id,
      },
      state: {
        status: "running",
        startedAt: isoNow(),
        currentIteration: 1,
      },
    });

    setupDefaultApi({
      workspaces: [workspace],
      tasks: [task],
      sshServers: [server],
      standaloneSessionsByServerId: {
        [server.config.id]: [createStandaloneSession(server.config.id, { id: "standalone-wrap-1" })],
      },
    });

    const { getAllByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText(longServerName).length).toBeGreaterThan(0);
      expect(getAllByText(longTaskName).length).toBeGreaterThan(0);
    });

    const serverName = getAllByText(longServerName).find((element) =>
      element instanceof HTMLElement && element.className.includes("break-words")
    );
    expect(serverName).toBeTruthy();
    if (!(serverName instanceof HTMLElement)) {
      throw new Error("Expected wrapped server name in the shell overview");
    }
    expect(serverName.className).toContain("[overflow-wrap:anywhere]");
    expect(serverName.className.includes("truncate")).toBe(false);

    const serverTarget = getAllByText(`deploy@${longAddress}`).find((element) =>
      element instanceof HTMLElement && element.className.includes("break-words")
    );
    expect(serverTarget).toBeTruthy();
    if (!(serverTarget instanceof HTMLElement)) {
      throw new Error("Expected wrapped server target in the shell overview");
    }
    expect(serverTarget.className).toContain("[overflow-wrap:anywhere]");
    expect(serverTarget.className.includes("truncate")).toBe(false);

    const taskName = getAllByText(longTaskName).find((element) =>
      element instanceof HTMLElement && element.className.includes("break-words")
    );
    expect(taskName).toBeTruthy();
    if (!(taskName instanceof HTMLElement)) {
      throw new Error("Expected wrapped task name in active work");
    }
    expect(taskName.className).toContain("[overflow-wrap:anywhere]");
    expect(taskName.className.includes("truncate")).toBe(false);

    const taskWorkspace = getAllByText(longWorkspaceName).find((element) =>
      element instanceof HTMLElement && element.className.includes("break-words")
    );
    expect(taskWorkspace).toBeTruthy();
    if (!(taskWorkspace instanceof HTMLElement)) {
      throw new Error("Expected wrapped workspace name in active work");
    }
    expect(taskWorkspace.className).toContain("[overflow-wrap:anywhere]");
    expect(taskWorkspace.className.includes("truncate")).toBe(false);
  });

  test("orders the workspaces section by task count from high to low", async () => {
    const alphaWorkspace = createWorkspace({
      id: "workspace-alpha",
      name: "Project Alpha",
      directory: "/workspaces/alpha",
    });
    const betaWorkspace = createWorkspace({
      id: "workspace-beta",
      name: "Project Beta",
      directory: "/workspaces/beta",
    });
    const gammaWorkspace = createWorkspace({
      id: "workspace-gamma",
      name: "Project Gamma",
      directory: "/workspaces/gamma",
    });

    const tasks = [
      createTaskWithStatus("running", {
        config: { id: "task-beta-1", name: "Beta One", workspaceId: betaWorkspace.id },
      }),
      createTaskWithStatus("planning", {
        config: { id: "task-beta-2", name: "Beta Two", workspaceId: betaWorkspace.id },
      }),
      createTaskWithStatus("completed", {
        config: { id: "task-alpha-1", name: "Alpha One", workspaceId: alphaWorkspace.id },
      }),
    ];

    setupDefaultApi({
      tasks,
      workspaces: [alphaWorkspace, betaWorkspace, gammaWorkspace],
    });

    const { getByRole } = renderWithUser(<App />);

    let workspaceButtons: HTMLElement[] = [];
    await waitFor(() => {
      const workspacesHeading = getByRole("heading", { name: "Workspaces" });
      const workspacesCard = workspacesHeading.parentElement?.parentElement;
      expect(workspacesCard).toBeTruthy();
      if (!(workspacesCard instanceof HTMLElement)) {
        throw new Error("Expected workspaces card to be present");
      }

      workspaceButtons = within(workspacesCard).getAllByRole("button");
      expect(workspaceButtons).toHaveLength(3);
    });

    expect(workspaceButtons.map((button) => button.textContent ?? "")).toEqual([
      expect.stringContaining("Project Beta"),
      expect.stringContaining("Project Alpha"),
      expect.stringContaining("Project Gamma"),
    ]);
  });

  test("renders shell-native workspace composer from the hash route", async () => {
    const { getByRole } = renderWithUser(<App />, { route: "#/new/workspace" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Create a workspace" })).toBeTruthy();
      expect(getByRole("button", { name: "Create Workspace" })).toBeTruthy();
    });
  });

  test("renders settings as a shell route instead of a modal", async () => {
    const { getByRole, getByText, queryByRole } = renderWithUser(<App />, { route: "#/settings" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Settings" })).toBeTruthy();
      expect(getByText("Render Markdown")).toBeTruthy();
    });

    expect(queryByRole("dialog")).toBeNull();
  });

  test("supports global shell hotkeys for primary destinations", async () => {
    setupDefaultApi({
      workspaces: [
        createWorkspace({
          id: "workspace-1",
          name: "Project One",
          directory: "/workspaces/project-one",
        }),
      ],
      sshServers: [createSshServer()],
    });
    const { getByRole } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
    });

    fireEvent.keyDown(window, { key: "l", metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(getByRole("heading", { name: "Start a new task" })).toBeTruthy();
      expect(window.location.hash).toBe("#/new/task");
    });

    fireEvent.keyDown(window, { key: "c", metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(getByRole("heading", { name: "Start a new chat" })).toBeTruthy();
      expect(window.location.hash).toBe("#/new/chat");
    });

    fireEvent.keyDown(window, { key: "s", metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(getByRole("heading", { name: "Create an SSH session" })).toBeTruthy();
      expect(window.location.hash).toBe("#/new/ssh-session");
    });

    fireEvent.keyDown(window, { key: ",", metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(getByRole("heading", { name: "Settings" })).toBeTruthy();
      expect(window.location.hash).toBe("#/settings");
    });

    fireEvent.keyDown(window, { key: "e", metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(getByRole("heading", { name: "Code explorer" })).toBeTruthy();
      expect(window.location.hash).toBe("#/code-explorer");
    });
  });

  test("does not trigger global shell hotkeys while typing in editable controls", async () => {
    const { getByLabelText, getByRole } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
    });

    const searchInput = getByLabelText("Search");
    searchInput.focus();
    fireEvent.keyDown(searchInput, { key: "e", metaKey: true, shiftKey: true });

    expect(window.location.hash).not.toBe("#/code-explorer");
    expect(document.activeElement).toBe(searchInput);
  });

  test("shows the sidebar and focuses search with the global search hotkey", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = createMatchMediaMock(true);
    try {
      const { getByLabelText, getByRole } = renderWithUser(<App />);

      await waitFor(() => {
        expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
      });

      fireEvent.click(getByRole("button", { name: "Hide sidebar" }));
      await waitFor(() => {
        expect(getByRole("button", { name: "Open sidebar" })).toBeTruthy();
      });

      fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });

      await waitFor(() => {
        const searchInput = getByLabelText("Search");
        expect(document.activeElement).toBe(searchInput);
        expect(getByRole("button", { name: "Hide sidebar" })).toBeTruthy();
      });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  test("renders task details inside the shell without a back button", async () => {
    const task = createTask({
      config: { id: "task-1", name: "Shell Task", workspaceId: "workspace-1" },
    });
    setupDefaultApi({ tasks: [task] });
    const { getAllByText, queryByRole } = renderWithUser(<App />, { route: "#/task/task-1" });

    await waitFor(() => {
      expect(getAllByText("Shell Task").length).toBeGreaterThan(0);
    });
    expect(queryByRole("button", { name: /Back/ })).toBeNull();
  });

  test("remounts task details on route switches so stale finalize UI is cleared", async () => {
    const firstTask = createTaskWithStatus("completed", {
      config: { id: "task-1", name: "Task One", workspaceId: "workspace-1" },
      state: { id: "task-1" },
    });
    const secondTask = createTaskWithStatus("completed", {
      config: { id: "task-2", name: "Task Two", workspaceId: "workspace-1" },
      state: { id: "task-2" },
    });
    setupDefaultApi({ tasks: [firstTask, secondTask] });

    const { getAllByText, getByRole, queryByText, user } = renderWithUser(<App />, { route: "#/task/task-1" });

    await waitFor(() => {
      expect(getAllByText("Task One").length).toBeGreaterThan(0);
    });

    await user.click(getByRole("button", { name: /Actions/ }));

    await waitFor(() => {
      const finalizeButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Accept") && button.textContent?.includes("locally or push"),
      );
      expect(finalizeButton).toBeTruthy();
    });

    const finalizeButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Accept") && button.textContent?.includes("locally or push"),
    );
    await user.click(finalizeButton!);

    await waitFor(() => {
      expect(queryByText("Finalize Task")).toBeTruthy();
    });

    await act(async () => {
      window.location.hash = "#/task/task-2";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await waitFor(() => {
      expect(getAllByText("Task Two").length).toBeGreaterThan(0);
      expect(queryByText("Finalize Task")).toBeNull();
    });

    await waitFor(() => {
      const openTaskConnections = ws.connections().filter(
        (connection) => connection.isOpen && connection.url.includes("/api/ws") && !connection.url.includes("?"),
      );
      expect(openTaskConnections).toHaveLength(1);
      expect(openTaskConnections[0]!.url).toContain("/api/ws");
    });
  });

  test("renders workspace and SSH server detail views from dedicated shell routes", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    const server = createSshServer({ id: "server-1", name: "Deploy host" });
    setupDefaultApi({ workspaces: [workspace], sshServers: [server] });

    const workspaceRender = renderWithUser(<App />, { route: "#/workspace/workspace-1" });

    await waitFor(() => {
      expect(workspaceRender.getByRole("heading", { name: "Frontend" })).toBeTruthy();
      expect(workspaceRender.getAllByText("/workspaces/frontend").length).toBeGreaterThan(0);
    });

    workspaceRender.unmount();

    const serverRender = renderWithUser(<App />, { route: "#/server/server-1" });

    await waitFor(() => {
      expect(serverRender.getByRole("heading", { name: "Deploy host" })).toBeTruthy();
      expect(serverRender.getByText("No standalone sessions yet for this SSH server.")).toBeTruthy();
    });
  });

  test("renders chat details from the shell chat route", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    const chat = createChat({
      config: {
        id: "chat-1",
        name: "Repo pairing",
        workspaceId: workspace.id,
        directory: workspace.directory,
      },
      state: {
        id: "chat-1",
        status: "idle",
        worktree: {
          originalBranch: "main",
          workingBranch: "chat-repo-pairing-chat1",
          worktreePath: "/workspaces/frontend/.clanky-worktrees/chat-1",
        },
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            content: "Ready when you are.",
            timestamp: isoNow(),
          },
        ],
        logs: [],
        toolCalls: [],
      },
    });

    setupDefaultApi({ workspaces: [workspace], chats: [chat] });

    const { getByRole, getByText } = renderWithUser(<App />, { route: "#/chat/chat-1" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Repo pairing" })).toBeTruthy();
      expect(getByText("Ready when you are.")).toBeTruthy();
    });

    expect(ws.getConnections("/api/ws")).toHaveLength(1);
    expect(ws.getConnections("/api/ws?chatId=chat-1")).toHaveLength(0);
  });

  test("opens workspace settings from the workspace shell icon action", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    setupDefaultApi({ workspaces: [workspace] });
    api.get("/api/workspaces/:id", () => workspace);
    api.get("/api/workspaces/:id/agents-md", () => ({
      content: "# AGENTS.md",
      fileExists: true,
      analysis: {
        isOptimized: false,
        currentVersion: null,
        updateAvailable: false,
      },
    }));
    api.get("/api/workspaces/:id/server-settings/status", () => ({
      connected: false,
      provider: workspace.serverSettings.agent.provider,
      transport: workspace.serverSettings.agent.transport,
      capabilities: [],
    }));

    const { getByRole, user } = renderWithUser(<App />, { route: "#/workspace/workspace-1" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Frontend" })).toBeTruthy();
    });

    const settingsButton = getByRole("button", { name: "Open workspace settings" });
    const createItemsButton = getByRole("button", { name: "Workspace actions for Frontend" });
    expect(settingsButton.getAttribute("title")).toBe("Workspace Settings");
    expect(settingsButton.textContent?.trim() ?? "").toBe("");
    expect(settingsButton.querySelector("svg")).toBeTruthy();
    expectHamburgerIcon(createItemsButton);

    await user.click(settingsButton);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Workspace Settings" })).toBeTruthy();
    });
  });

  test("lets users delete an SSH server from the shell settings route", async () => {
    const server = createSshServer({ id: "server-1", name: "Deploy host" });
    setupDefaultApi({ sshServers: [server] });
    localStorage.setItem("clanky.sshServerCredential.server-1", JSON.stringify({
      encryptedCredential: {
        algorithm: server.publicKey.algorithm,
        fingerprint: server.publicKey.fingerprint,
        version: server.publicKey.version,
        ciphertext: "saved",
      },
      storedAt: isoNow(),
    }));
    api.delete("/api/ssh-servers/:id", (req) => {
      expect(req.params["id"]).toBe("server-1");
      return { success: true };
    });

    const { getByRole, getByText, queryByRole, user } = renderWithUser(<App />, { route: "#/server/server-1" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Deploy host" })).toBeTruthy();
      expect(getByRole("button", { name: "Open SSH server settings" })).toBeTruthy();
      expect(getByRole("button", { name: "SSH server actions for Deploy host" })).toBeTruthy();
      expect(queryByRole("button", { name: "Delete Server" })).toBeNull();
    });

    await user.click(getByRole("button", { name: "Open SSH server settings" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/server-settings/server-1");
      expect(getByRole("heading", { name: "SSH Server Settings" })).toBeTruthy();
      expect(getByRole("button", { name: "Delete SSH Server" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Delete SSH Server" }));

    await waitFor(() => {
      expect(getByRole("dialog")).toBeTruthy();
      expect(getByText('Delete "Deploy host"? This removes the saved SSH server metadata from Clanky and any saved browser credential for this server.')).toBeTruthy();
    });

    const deleteDialog = getByRole("dialog");
    await user.click(within(deleteDialog).getByRole("button", { name: "Delete Server" }));

    await waitFor(() => {
      expect(api.calls("/api/ssh-servers/:id", "DELETE")).toHaveLength(1);
      expect(window.location.hash).toBe("#/");
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
      expect(localStorage.getItem("clanky.sshServerCredential.server-1")).toBeNull();
      expect(queryByRole("dialog")).toBeNull();
    });
  });

  test("navigates to a task when a sidebar item is clicked", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    const task = createTask({
      config: { id: "task-1", name: "Sidebar Task", workspaceId: workspace.id },
      state: { status: "running", startedAt: isoNow(), currentIteration: 1 },
    });
    setupDefaultApi({ workspaces: [workspace], tasks: [task] });

    const { getAllByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Sidebar Task").length).toBeGreaterThan(0);
    });

    await user.click(getAllByText("Sidebar Task")[0]!);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/task/task-1");
    });
  });

  test("opens a sidebar task in a new tab on cmd-click", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    const task = createTask({
      config: { id: "task-1", name: "Sidebar Task", workspaceId: workspace.id },
      state: { status: "running", startedAt: isoNow(), currentIteration: 1 },
    });
    setupDefaultApi({ workspaces: [workspace], tasks: [task] });

    const openCalls: Array<{ url: string | URL | undefined; target: string | undefined; features: string | undefined }> = [];
    const originalWindowOpen = window.open;
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      openCalls.push({ url, target, features });
      return null;
    }) as typeof window.open;

    try {
      const { getAllByText } = renderWithUser(<App />);

      await waitFor(() => {
        expect(getAllByText("Sidebar Task").length).toBeGreaterThan(0);
      });

      fireEvent.click(getAllByText("Sidebar Task")[0]!, { metaKey: true });

      expect(openCalls).toEqual([
        {
          url: "http://localhost:3000/#/task/task-1",
          target: "_blank",
          features: "noopener,noreferrer",
        },
      ]);
      expect(window.location.hash).not.toBe("#/task/task-1");
    } finally {
      window.open = originalWindowOpen;
    }
  });

  test("opens a sidebar task in a new tab on ctrl-click", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    const task = createTask({
      config: { id: "task-1", name: "Sidebar Task", workspaceId: workspace.id },
      state: { status: "running", startedAt: isoNow(), currentIteration: 1 },
    });
    setupDefaultApi({ workspaces: [workspace], tasks: [task] });

    const openCalls: Array<{ url: string | URL | undefined; target: string | undefined; features: string | undefined }> = [];
    const originalWindowOpen = window.open;
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      openCalls.push({ url, target, features });
      return null;
    }) as typeof window.open;

    try {
      const { getAllByText } = renderWithUser(<App />);

      await waitFor(() => {
        expect(getAllByText("Sidebar Task").length).toBeGreaterThan(0);
      });

      fireEvent.click(getAllByText("Sidebar Task")[0]!, { ctrlKey: true });

      expect(openCalls).toEqual([
        {
          url: "http://localhost:3000/#/task/task-1",
          target: "_blank",
          features: "noopener,noreferrer",
        },
      ]);
      expect(window.location.hash).not.toBe("#/task/task-1");
    } finally {
      window.open = originalWindowOpen;
    }
  });

  test("shows 'Plan Ready' for ready planning tasks in the sidebar", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    const readyPlanningTask = createTaskWithStatus("planning", {
      config: { id: "task-plan-ready", name: "Plan Ready Task", workspaceId: workspace.id },
      state: {
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: true,
        },
      },
    });

    setupDefaultApi({ workspaces: [workspace], tasks: [readyPlanningTask] });

    const { getByRole } = renderWithUser(<App />);

    await waitFor(() => {
      const sidebar = document.querySelector("aside");
      expect(sidebar).toBeTruthy();
      expect(within(sidebar as HTMLElement).getAllByText("Plan Ready Task").length).toBeGreaterThan(0);
      expect(within(sidebar as HTMLElement).getAllByText("Plan Ready").length).toBeGreaterThan(0);
    });

    expect(getByRole("button", { name: /Collapse Workspaces section/ })).toBeTruthy();
  });

  test("keeps non-ready planning tasks labeled 'Planning' in the sidebar", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    const planningTask = createTaskWithStatus("planning", {
      config: { id: "task-planning", name: "Planning Task", workspaceId: workspace.id },
      state: {
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: false,
        },
      },
    });
    const runningTask = createTaskWithStatus("running", {
      config: { id: "task-running", name: "Running Task", workspaceId: workspace.id },
    });

    setupDefaultApi({ workspaces: [workspace], tasks: [planningTask, runningTask] });

    renderWithUser(<App />);

    await waitFor(() => {
      const sidebar = document.querySelector("aside");
      expect(sidebar).toBeTruthy();
      expect(within(sidebar as HTMLElement).getAllByText("Planning Task").length).toBeGreaterThan(0);
      expect(within(sidebar as HTMLElement).getAllByText("Planning").length).toBeGreaterThan(0);
      expect(within(sidebar as HTMLElement).getAllByText("Running").length).toBeGreaterThan(0);
    });
  });

  test("reacts to hash changes with the new shell routes", async () => {
    const { getByRole } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
    });

    await act(async () => {
      window.location.hash = "/new/ssh-server";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Register a standalone SSH server" })).toBeTruthy();
    });
  });

  test("lets users collapse and expand sidebar sections", async () => {
    const { getByRole, queryByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Collapse Workspaces section" })).toBeTruthy();
      expect(queryByText("Active")).toBeNull();
      expect(queryByText("All")).toBeNull();
    });

    const collapseButton = getByRole("button", { name: "Collapse Workspaces section" });
    expect(collapseButton).toHaveAttribute("aria-expanded", "true");

    await user.click(collapseButton);

    await waitFor(() => {
      expect(getByRole("button", { name: "Expand Workspaces section" })).toBeTruthy();
      expect(queryByText("No workspaces yet.")).toBeNull();
    });

    await user.click(getByRole("button", { name: "Expand Workspaces section" }));

    await waitFor(() => {
      expect(getByRole("button", { name: "Collapse Workspaces section" })).toBeTruthy();
      expect(queryByText("Active")).toBeNull();
      expect(queryByText("All")).toBeNull();
      expect(window.localStorage.getItem("clanky.sidebarSectionCollapseState")).toBeNull();
    });
  });

  test("restores collapsed sidebar sections from browser storage", async () => {
    const firstRender = renderWithUser(<App />);

    await waitFor(() => {
      expect(firstRender.getByRole("button", { name: "Collapse Workspaces section" })).toBeTruthy();
    });

    await firstRender.user.click(firstRender.getByRole("button", { name: "Collapse Workspaces section" }));

    await waitFor(() => {
      expect(firstRender.getByRole("button", { name: "Expand Workspaces section" })).toBeTruthy();
      expect(firstRender.queryByText("Active")).toBeNull();
      expect(firstRender.queryByText("All")).toBeNull();
    });

    firstRender.unmount();

    const secondRender = renderWithUser(<App />);

    await waitFor(() => {
      expect(secondRender.getByRole("button", { name: "Expand Workspaces section" })).toBeTruthy();
      expect(secondRender.queryByText("Active")).toBeNull();
      expect(secondRender.queryByText("All")).toBeNull();
    });
  });

  test("drops stale and expanded sidebar keys from browser storage", async () => {
    window.localStorage.setItem("clanky.sidebarSectionCollapseState", JSON.stringify({
      workspaces: true,
      drafts: true,
      tasks: false,
    }));

    const { getByRole } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Expand Workspaces section" })).toBeTruthy();
    });

    await waitFor(() => {
      const persistedState = JSON.parse(window.localStorage.getItem("clanky.sidebarSectionCollapseState") ?? "{}") as Record<string, boolean>;
      expect(persistedState["workspaces"]).toBe(true);
      expect("tasks" in persistedState).toBe(false);
      expect("drafts" in persistedState).toBe(false);
    });
  });

  test("shows draft tasks under workspace sections without reviving legacy draft buckets", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    const draftTask = createTaskWithStatus("draft", {
      config: { id: "task-draft", name: "Sprint Draft", workspaceId: workspace.id },
    });
    const runningTask = createTaskWithStatus("running", {
      config: { id: "task-running", name: "Shipping Task", workspaceId: workspace.id },
    });
    setupDefaultApi({ workspaces: [workspace], tasks: [draftTask, runningTask] });

    const { getAllByText, getByRole, queryByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Collapse Workspaces section" })).toBeTruthy();
      expect(getAllByText("Sprint Draft").length).toBeGreaterThan(0);
      expect(getAllByText("Shipping Task").length).toBeGreaterThan(0);
    });

    expect(queryByText("Drafts")).toBeNull();
    expect(getAllByText("Draft").length).toBeGreaterThan(0);

    expect(getAllByText("Frontend").length).toBeGreaterThan(0);
  });

  test("hides and reopens the sidebar with header icon controls", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = createMatchMediaMock(true);

    try {
      const { getByLabelText, user } = renderWithUser(<App />);

      await waitFor(() => {
        expect(getByLabelText("Hide sidebar")).toBeTruthy();
      });

      const sidebar = document.querySelector("aside");
      expect(sidebar).toBeTruthy();
      if (!(sidebar instanceof HTMLElement)) {
        throw new Error("Expected sidebar element to exist");
      }

      await user.click(getByLabelText("Hide sidebar"));

      await waitFor(() => {
        expect(sidebar).toHaveAttribute("hidden");
        expect(getByLabelText("Open sidebar")).toBeTruthy();
      });

      await user.click(getByLabelText("Open sidebar"));

      await waitFor(() => {
        expect(sidebar).not.toHaveAttribute("hidden");
        expect(getByLabelText("Hide sidebar")).toBeTruthy();
      });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  test("toggles the desktop sidebar with Cmd+B and Ctrl+B shortcuts", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = createMatchMediaMock(true);

    try {
      const { getByLabelText, user } = renderWithUser(<App />);

      await waitFor(() => {
        expect(getByLabelText("Hide sidebar")).toBeTruthy();
      });

      const sidebar = document.querySelector("aside");
      expect(sidebar).toBeTruthy();
      if (!(sidebar instanceof HTMLElement)) {
        throw new Error("Expected sidebar element to exist");
      }

      await user.keyboard("{Meta>}b{/Meta}");

      await waitFor(() => {
        expect(sidebar.hasAttribute("hidden")).toBe(true);
        expect(getByLabelText("Open sidebar")).toBeTruthy();
      });

      await user.keyboard("{Control>}b{/Control}");

      await waitFor(() => {
        expect(sidebar.hasAttribute("hidden")).toBe(false);
        expect(getByLabelText("Hide sidebar")).toBeTruthy();
      });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  test("labels the narrow sidebar toggle by its current action", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = createMatchMediaMock(false);

    try {
      const { getByLabelText, queryByLabelText, user } = renderWithUser(<App />);

      await waitFor(() => {
        expect(getByLabelText("Open sidebar")).toBeTruthy();
      });

      await user.click(getByLabelText("Open sidebar"));

      await waitFor(() => {
        expect(getByLabelText("Close sidebar")).toBeTruthy();
        expect(queryByLabelText("Hide sidebar")).toBeNull();
      });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  test("does not toggle the sidebar shortcut from editable fields", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = createMatchMediaMock(true);

    try {
      const { getByLabelText } = renderWithUser(<App />);

      await waitFor(() => {
        expect(getByLabelText("Hide sidebar")).toBeTruthy();
      });

      const sidebar = document.querySelector("aside");
      expect(sidebar).toBeTruthy();
      if (!(sidebar instanceof HTMLElement)) {
        throw new Error("Expected sidebar element to exist");
      }

      fireEvent.keyDown(getByLabelText("Search"), { key: "b", metaKey: true });

      expect(sidebar).not.toHaveAttribute("hidden");
      expect(getByLabelText("Hide sidebar")).toBeTruthy();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  test("settings button navigates to the shell settings view", async () => {
    const { getByLabelText, getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
    });

    await user.click(getByLabelText("Open settings"));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/settings");
      expect(getByRole("heading", { name: "Settings" })).toBeTruthy();
    });
  });

  test("header brand returns to the overview route", async () => {
    const { getByRole, user } = renderWithUser(<App />, { route: "#/settings" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Settings" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: /clanky/i }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/");
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
    });
  });

  test("renders rebuild-workspace view from hash route", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
      sourceDirectory: "/workspaces/frontend-source",
    });
    setupDefaultApi({ workspaces: [workspace] });
    api.get("/api/workspaces/:id", () => workspace);

    const { getByRole } = renderWithUser(<App />, { route: "#/rebuild-workspace/workspace-1" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Rebuild Frontend" })).toBeTruthy();
    });
  });

  test("renders restart-workspace view from hash route", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
      sourceDirectory: "/workspaces/frontend-source",
    });
    setupDefaultApi({ workspaces: [workspace] });
    api.get("/api/workspaces/:id", () => workspace);

    const { getByRole } = renderWithUser(<App />, { route: "#/restart-workspace/workspace-1" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Restart Frontend" })).toBeTruthy();
    });
  });

  test("navigating to rebuild-workspace via hash change renders the view", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
      sourceDirectory: "/workspaces/frontend-source",
    });
    setupDefaultApi({ workspaces: [workspace] });
    api.get("/api/workspaces/:id", () => workspace);

    const { getByRole } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
    });

    await act(() => {
      window.location.hash = "/rebuild-workspace/workspace-1";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await waitFor(() => {
      expect(window.location.hash).toBe("#/rebuild-workspace/workspace-1");
      expect(getByRole("heading", { name: "Rebuild Frontend" })).toBeTruthy();
    });
  });

  test("navigating to restart-workspace via hash change renders the view", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
      sourceDirectory: "/workspaces/frontend-source",
    });
    setupDefaultApi({ workspaces: [workspace] });
    api.get("/api/workspaces/:id", () => workspace);

    const { getByRole } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
    });

    await act(() => {
      window.location.hash = "/restart-workspace/workspace-1";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await waitFor(() => {
      expect(window.location.hash).toBe("#/restart-workspace/workspace-1");
      expect(getByRole("heading", { name: "Restart Frontend" })).toBeTruthy();
    });
  });

  test("shows restart and rebuild in workspace settings for auto-provisioned workspaces", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
      sourceDirectory: "/workspaces/frontend-source",
    });
    setupDefaultApi({ workspaces: [workspace] });
    api.get("/api/workspaces/:id", () => workspace);

    const { getByRole, user } = renderWithUser(<App />, { route: "#/workspace/workspace-1" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Frontend" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Open workspace settings" }));

    await waitFor(() => {
      expect(getByRole("button", { name: "Restart" })).toBeTruthy();
      expect(getByRole("button", { name: "Rebuild" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Restart" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/restart-workspace/workspace-1");
      expect(getByRole("heading", { name: "Restart Frontend" })).toBeTruthy();
    });
  });

  test("shows Arise in SSH server settings instead of the server overview and navigates to the server-level flow", async () => {
    const server = createSshServer({
      id: "server-1",
      repositoriesBasePath: "/workspaces",
    });
    setupDefaultApi({ sshServers: [server] });

    const { getByRole, queryByRole, user } = renderWithUser(<App />, { route: "#/server/server-1" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Build host" })).toBeTruthy();
      expect(queryByRole("button", { name: "Arise" })).toBeNull();
      expect(getByRole("button", { name: "Open SSH server settings" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Open SSH server settings" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/server-settings/server-1");
      expect(getByRole("heading", { name: "SSH Server Settings" })).toBeTruthy();
      expect(getByRole("button", { name: "Arise" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Arise" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/server-arise/server-1");
      expect(getByRole("heading", { name: "Arise Build host" })).toBeTruthy();
      expect(getByRole("button", { name: "Run devbox arise" })).toBeTruthy();
      expect(getByRole("button", { name: "Cancel" })).toBeTruthy();
    });
  });
});
