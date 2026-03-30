import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "@/App";
import type { Chat } from "@/types";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor, act, within } from "../helpers/render";
import { createLoop, createLoopWithStatus, createSshSession, createWorkspace } from "../helpers/factories";

const api = createMockApi();
const ws = createMockWebSocket();

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
      remoteSessionName: "ralpher-standalone",
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
  loops?: ReturnType<typeof createLoop>[];
  chats?: Chat[];
  workspaces?: ReturnType<typeof createWorkspace>[];
  sshSessions?: ReturnType<typeof createSshSession>[];
  sshServers?: ReturnType<typeof createSshServer>[];
  standaloneSessionsByServerId?: Record<string, ReturnType<typeof createStandaloneSession>[]>;
}) {
  const loops = options?.loops ?? [];
  const chats = options?.chats ?? [];
  const workspaces = options?.workspaces ?? [];
  const sshSessions = options?.sshSessions ?? [];
  const sshServers = options?.sshServers ?? [];
  const standaloneSessionsByServerId = options?.standaloneSessionsByServerId ?? {};

  api.get("/api/loops", () => loops);
  api.get("/api/chats", () => chats);
  api.get("/api/workspaces", () => workspaces);
  api.get("/api/ssh-sessions", () => sshSessions);
  api.get("/api/ssh-servers", () => sshServers);
  api.get("/api/ssh-servers/:id/sessions", (req) => standaloneSessionsByServerId[req.params["id"]!] ?? []);
  api.get("/api/config", () => ({ remoteOnly: false }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/preferences/last-model", () => null);
  api.get("/api/preferences/log-level", () => ({ level: "info" }));
  api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
  api.get("/api/models", () => []);
  api.get("/api/loops/:id", (req) => {
    return loops.find((loop) => loop.config.id === req.params["id"])
      ?? createLoop({ config: { id: req.params["id"], name: `Loop ${req.params["id"]}` } });
  });
  api.get("/api/chats/:id", (req) => {
    const chatId = req.params["id"]!;
    return chats.find((chat) => chat.config.id === chatId)
      ?? createChat({ config: { id: chatId, name: `Chat ${chatId}` } });
  });
  api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
  api.get("/api/loops/:id/diff", () => []);
  api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
  api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
  api.get("/api/loops/:id/pull-request", () => ({
    enabled: false,
    destinationType: "disabled",
    disabledReason: "disabled",
  }));
  api.get("/api/loops/:id/port-forwards", () => []);
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
  window.location.hash = "";
  setupDefaultApi();
});

afterEach(() => {
  api.uninstall();
  ws.uninstall();
  window.location.hash = "";
});

describe("App shell", () => {
  test("renders the shell overview by default", async () => {
    const { getByRole, getByText, queryByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
      expect(getByText("Recent activity")).toBeTruthy();
      expect(getByText("Server maps")).toBeTruthy();
      expect(getByText("Workspaces map")).toBeTruthy();
    });

    const recentActivityHeading = getByRole("heading", { name: "Recent activity" });
    const serverMapsHeading = getByRole("heading", { name: "Server maps" });
    const workspacesMapHeading = getByRole("heading", { name: "Workspaces map" });

    expect(recentActivityHeading.compareDocumentPosition(serverMapsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(serverMapsHeading.compareDocumentPosition(workspacesMapHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(queryByText("Tracked repositories and hosts.")).toBeNull();
    expect(queryByText("Task-oriented Ralph loops.")).toBeNull();
    expect(queryByText("Interactive conversations.")).toBeNull();
  });

  test("wraps long server map and recent activity text inside the shell overview cards", async () => {
    const longServerName = `Server ${"super-long-hostname-".repeat(6)}`;
    const longAddress = `${"edge-node-".repeat(6)}example.internal`;
    const longLoopName = `Loop ${"very-long-conversation-title-".repeat(5)}`;
    const longDirectory = `/workspaces/${"deeply-nested-project-".repeat(6)}repo`;

    const server = createSshServer({
      id: "server-wrap-1",
      name: longServerName,
      address: longAddress,
      username: "deploy",
    });
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Wrap Lab",
      directory: "/workspaces/wrap-lab",
    });
    const loop = createLoop({
      config: {
        id: "loop-wrap-1",
        name: longLoopName,
        directory: longDirectory,
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
      loops: [loop],
      sshServers: [server],
      standaloneSessionsByServerId: {
        [server.config.id]: [createStandaloneSession(server.config.id, { id: "standalone-wrap-1" })],
      },
    });

    const { getAllByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText(longServerName).length).toBeGreaterThan(0);
      expect(getAllByText(longLoopName).length).toBeGreaterThan(0);
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

    const loopName = getAllByText(longLoopName).find((element) =>
      element instanceof HTMLElement && element.className.includes("break-words")
    );
    expect(loopName).toBeTruthy();
    if (!(loopName instanceof HTMLElement)) {
      throw new Error("Expected wrapped loop name in recent activity");
    }
    expect(loopName.className).toContain("[overflow-wrap:anywhere]");
    expect(loopName.className.includes("truncate")).toBe(false);

    const loopDirectory = getAllByText(longDirectory).find((element) =>
      element instanceof HTMLElement && element.className.includes("break-words")
    );
    expect(loopDirectory).toBeTruthy();
    if (!(loopDirectory instanceof HTMLElement)) {
      throw new Error("Expected wrapped loop directory in recent activity");
    }
    expect(loopDirectory.className).toContain("[overflow-wrap:anywhere]");
    expect(loopDirectory.className.includes("truncate")).toBe(false);
  });

  test("orders the workspaces map by loop count from high to low", async () => {
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

    const loops = [
      createLoopWithStatus("running", {
        config: { id: "loop-beta-1", name: "Beta One", workspaceId: betaWorkspace.id },
      }),
      createLoopWithStatus("planning", {
        config: { id: "loop-beta-2", name: "Beta Two", workspaceId: betaWorkspace.id },
      }),
      createLoopWithStatus("completed", {
        config: { id: "loop-alpha-1", name: "Alpha One", workspaceId: alphaWorkspace.id },
      }),
    ];

    setupDefaultApi({
      loops,
      workspaces: [alphaWorkspace, betaWorkspace, gammaWorkspace],
    });

    const { getByRole } = renderWithUser(<App />);

    let workspaceButtons: HTMLElement[] = [];
    await waitFor(() => {
      const workspacesMapHeading = getByRole("heading", { name: "Workspaces map" });
      const workspacesCard = workspacesMapHeading.parentElement?.parentElement;
      expect(workspacesCard).toBeTruthy();
      if (!(workspacesCard instanceof HTMLElement)) {
        throw new Error("Expected workspaces map card to be present");
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

  test("renders loop details inside the shell without a back button", async () => {
    const loop = createLoop({
      config: { id: "loop-1", name: "Shell Loop", workspaceId: "workspace-1" },
    });
    setupDefaultApi({ loops: [loop] });
    const { getAllByText, queryByRole } = renderWithUser(<App />, { route: "#/loop/loop-1" });

    await waitFor(() => {
      expect(getAllByText("Shell Loop").length).toBeGreaterThan(0);
    });
    expect(queryByRole("button", { name: /Back/ })).toBeNull();
  });

  test("remounts loop details on route switches so stale finalize UI is cleared", async () => {
    const firstLoop = createLoopWithStatus("completed", {
      config: { id: "loop-1", name: "Loop One", workspaceId: "workspace-1" },
      state: { id: "loop-1" },
    });
    const secondLoop = createLoopWithStatus("completed", {
      config: { id: "loop-2", name: "Loop Two", workspaceId: "workspace-1" },
      state: { id: "loop-2" },
    });
    setupDefaultApi({ loops: [firstLoop, secondLoop] });

    const { getAllByText, getByRole, queryByText, user } = renderWithUser(<App />, { route: "#/loop/loop-1" });

    await waitFor(() => {
      expect(getAllByText("Loop One").length).toBeGreaterThan(0);
      const renameButton = document.querySelector('button[aria-label="Rename loop"]');
      expect(renameButton).toBeTruthy();
    });

    await user.click(getByRole("button", { name: /Actions/ }));

    await waitFor(() => {
      const finalizeButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Accept") && button.textContent?.includes("merge or push"),
      );
      expect(finalizeButton).toBeTruthy();
    });

    const finalizeButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Accept") && button.textContent?.includes("merge or push"),
    );
    await user.click(finalizeButton!);

    await waitFor(() => {
      expect(queryByText("Finalize Loop")).toBeTruthy();
    });

    await act(async () => {
      window.location.hash = "#/loop/loop-2";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await waitFor(() => {
      expect(getAllByText("Loop Two").length).toBeGreaterThan(0);
      expect(queryByText("Finalize Loop")).toBeNull();
    });

    await waitFor(() => {
      const openLoopConnections = ws.connections().filter(
        (connection) => connection.isOpen && !!connection.queryParams["loopId"],
      );
      expect(openLoopConnections).toHaveLength(1);
      expect(openLoopConnections[0]!.queryParams["loopId"]).toBe("loop-2");
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
          worktreePath: "/workspaces/frontend/.ralph-worktrees/chat-1",
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

    const openChatConnections = ws.connections().filter(
      (connection) => connection.isOpen && connection.queryParams["chatId"] === "chat-1",
    );
    expect(openChatConnections).toHaveLength(1);
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
    expect(settingsButton.getAttribute("title")).toBe("Workspace Settings");
    expect(settingsButton.textContent?.trim() ?? "").toBe("");
    expect(settingsButton.querySelector("svg")).toBeTruthy();

    await user.click(settingsButton);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Workspace Settings" })).toBeTruthy();
    });
  });

  test("lets users delete an SSH server from the shell detail route", async () => {
    const server = createSshServer({ id: "server-1", name: "Deploy host" });
    setupDefaultApi({ sshServers: [server] });
    localStorage.setItem("ralpher.sshServerCredential.server-1", JSON.stringify({
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
      expect(getByRole("button", { name: "Delete Server" })).toBeTruthy();
      expect(getByRole("button", { name: "New Session" })).toBeTruthy();
    });

    const deleteButton = getByRole("button", { name: "Delete Server" });
    const newSessionButton = getByRole("button", { name: "New Session" });
    expect(deleteButton.compareDocumentPosition(newSessionButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);

    await user.click(deleteButton);

    await waitFor(() => {
      expect(getByText('Delete "Deploy host"? This removes the saved SSH server metadata from Ralpher and any saved browser credential for this server.')).toBeTruthy();
    });

    const deleteDialog = getByRole("dialog");
    await user.click(within(deleteDialog).getByRole("button", { name: "Delete Server" }));

    await waitFor(() => {
      expect(api.calls("/api/ssh-servers/:id", "DELETE")).toHaveLength(1);
      expect(window.location.hash).toBe("#/");
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
      expect(getByText('Deleted SSH server "Deploy host"')).toBeTruthy();
      expect(localStorage.getItem("ralpher.sshServerCredential.server-1")).toBeNull();
      expect(queryByRole("dialog")).toBeNull();
    });
  });

  test("navigates to a loop when a sidebar item is clicked", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    const loop = createLoop({
      config: { id: "loop-1", name: "Sidebar Loop", workspaceId: workspace.id },
      state: { status: "running", startedAt: isoNow(), currentIteration: 1 },
    });
    setupDefaultApi({ workspaces: [workspace], loops: [loop] });

    const { getAllByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Sidebar Loop").length).toBeGreaterThan(0);
    });

    await user.click(getAllByText("Sidebar Loop")[0]!);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/loop/loop-1");
    });
  });

  test("shows 'Plan Ready' for ready planning loops in the sidebar", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    const readyPlanningLoop = createLoopWithStatus("planning", {
      config: { id: "loop-plan-ready", name: "Plan Ready Loop", workspaceId: workspace.id },
      state: {
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: true,
        },
      },
    });

    setupDefaultApi({ workspaces: [workspace], loops: [readyPlanningLoop] });

    const { getByRole } = renderWithUser(<App />);

    await waitFor(() => {
      const sidebar = document.querySelector("aside");
      expect(sidebar).toBeTruthy();
      expect(within(sidebar as HTMLElement).getByText("Plan Ready Loop")).toBeTruthy();
      expect(within(sidebar as HTMLElement).getByText("Plan Ready")).toBeTruthy();
    });

    expect(getByRole("button", { name: /Collapse Loops section/ })).toBeTruthy();
  });

  test("keeps non-ready planning loops labeled 'Planning' in the sidebar", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    const planningLoop = createLoopWithStatus("planning", {
      config: { id: "loop-planning", name: "Planning Loop", workspaceId: workspace.id },
      state: {
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: false,
        },
      },
    });
    const runningLoop = createLoopWithStatus("running", {
      config: { id: "loop-running", name: "Running Loop", workspaceId: workspace.id },
    });

    setupDefaultApi({ workspaces: [workspace], loops: [planningLoop, runningLoop] });

    renderWithUser(<App />);

    await waitFor(() => {
      const sidebar = document.querySelector("aside");
      expect(sidebar).toBeTruthy();
      expect(within(sidebar as HTMLElement).getByText("Planning Loop")).toBeTruthy();
      expect(within(sidebar as HTMLElement).getByText("Planning")).toBeTruthy();
      expect(within(sidebar as HTMLElement).getByText("Running")).toBeTruthy();
    });
  });

  test("reacts to hash changes with the new shell routes", async () => {
    const { getByRole } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
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
    const { getByRole, getByText, queryByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Collapse Workspaces section" })).toBeTruthy();
      expect(getByText("No workspaces yet.")).toBeTruthy();
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
      expect(getByText("No workspaces yet.")).toBeTruthy();
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
      expect(firstRender.queryByText("No workspaces yet.")).toBeNull();
    });

    firstRender.unmount();

    const secondRender = renderWithUser(<App />);

    await waitFor(() => {
      expect(secondRender.getByRole("button", { name: "Expand Workspaces section" })).toBeTruthy();
      expect(secondRender.queryByText("No workspaces yet.")).toBeNull();
    });
  });

  test("cleans stale drafts sidebar state from browser storage", async () => {
    window.localStorage.setItem("ralpher.sidebarSectionCollapseState", JSON.stringify({
      workspaces: true,
      drafts: true,
      loops: false,
    }));

    const { getByRole } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Expand Workspaces section" })).toBeTruthy();
    });

    const persistedState = JSON.parse(window.localStorage.getItem("ralpher.sidebarSectionCollapseState") ?? "{}") as Record<string, boolean>;
    expect(persistedState["workspaces"]).toBe(true);
    expect(persistedState["loops"]).toBe(false);
    expect("drafts" in persistedState).toBe(false);
  });

  test("shows draft loops under Loops and removes workspace subgroup counts", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    const draftLoop = createLoopWithStatus("draft", {
      config: { id: "loop-draft", name: "Sprint Draft", workspaceId: workspace.id },
    });
    const runningLoop = createLoopWithStatus("running", {
      config: { id: "loop-running", name: "Shipping Loop", workspaceId: workspace.id },
    });
    setupDefaultApi({ workspaces: [workspace], loops: [draftLoop, runningLoop] });

    const { getAllByText, getByRole, queryByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Collapse Loops section" })).toBeTruthy();
      expect(getAllByText("Sprint Draft").length).toBeGreaterThan(0);
      expect(getAllByText("Shipping Loop").length).toBeGreaterThan(0);
    });

    expect(queryByText("Drafts")).toBeNull();
    expect(getAllByText("Draft").length).toBeGreaterThan(0);

    const workspaceButton = Array.from(document.querySelectorAll("button[aria-expanded]")).find((button) =>
      button.textContent?.includes("Frontend")
    );
    expect(workspaceButton).toBeTruthy();
    expect(workspaceButton?.textContent).not.toContain("2");
  });

  test("hides and reopens the sidebar with header icon controls", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = createMatchMediaMock(true);

    try {
      const { getByLabelText, user } = renderWithUser(<App />);
      const sidebar = document.querySelector("aside");

      expect(sidebar).toBeTruthy();
      expect(getByLabelText("Hide sidebar")).toBeTruthy();

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

  test("settings button navigates to the shell settings view", async () => {
    const { getByLabelText, getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
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

    await user.click(getByRole("button", { name: /ralpher/i }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/");
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
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
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
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
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
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

  test("shows a restart button for auto-provisioned workspaces and navigates to the restart action", async () => {
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
      expect(getByRole("button", { name: "Restart" })).toBeTruthy();
      expect(getByRole("button", { name: "Rebuild" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Restart" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/restart-workspace/workspace-1");
      expect(getByRole("heading", { name: "Restart Frontend" })).toBeTruthy();
    });
  });

  test("shows an Arise action for servers with automatic provisioning and navigates to the server-level flow", async () => {
    const server = createSshServer({
      id: "server-1",
      repositoriesBasePath: "/workspaces",
    });
    setupDefaultApi({ sshServers: [server] });

    const { getByRole, user } = renderWithUser(<App />, { route: "#/server/server-1" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Build host" })).toBeTruthy();
      expect(getByRole("button", { name: "Arise" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Arise" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/server-arise/server-1");
      expect(getByRole("heading", { name: "Arise Build host" })).toBeTruthy();
      expect(getByRole("button", { name: "Run devbox arise" })).toBeTruthy();
    });
  });
});
