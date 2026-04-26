/**
 * E2E Scenario: Workspace Management
 *
 * Tests shell-native workspace workflows: composing workspaces in the main
 * panel, using registered SSH servers, and navigating workspace detail views.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor, within } from "../helpers/render";
import {
  createLoopWithStatus,
  createSshSession,
  createWorkspace,
  createModelInfo,
} from "../helpers/factories";
import { App } from "@/App";
import type { Chat, SshServer } from "@/types";

const api = createMockApi();
const ws = createMockWebSocket();

const WORKSPACE = createWorkspace({
  id: "ws-1",
  name: "Existing Project",
  directory: "/workspaces/existing",
});

function setupBaseApi() {
  api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/preferences/last-model", () => null);
  api.get("/api/preferences/log-level", () => ({ level: "info" }));
  api.get("/api/preferences/last-directory", () => null);
  api.get("/api/models", () => [createModelInfo({ connected: true })]);
  api.get("/api/ssh-sessions", () => []);
  api.get("/api/ssh-servers", () => []);
  api.get("/api/ssh-servers/:id/sessions", () => []);
  api.get("/api/workspaces/:id/server-settings/status", () => ({
    connected: false,
    provider: "opencode",
    transport: "stdio",
    capabilities: [],
  }));
  api.get("/api/workspaces/:id/agents-md", () => ({
    content: "# AGENTS.md",
    fileExists: true,
    analysis: {
      isOptimized: false,
      currentVersion: null,
      updateAvailable: false,
    },
  }));
}

function getSectionActionButton(sectionTitle: string, actionLabel = "New"): HTMLButtonElement | undefined {
  const section = Array.from(document.querySelectorAll("section")).find((candidate) =>
    candidate.textContent?.includes(sectionTitle)
  );
  if (!section) {
    return undefined;
  }

  return Array.from(section.querySelectorAll("button")).find((button) =>
    button.textContent?.trim() === actionLabel
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  api.reset();
  api.install();
  ws.reset();
  ws.install();
  window.location.hash = "";
});

afterEach(() => {
  api.uninstall();
  ws.uninstall();
  window.location.hash = "";
});

// ─── Workspace management scenarios ──────────────────────────────────────────

describe("workspace management scenario", () => {
  test("clicking New Workspace opens the shell composer", async () => {
    setupBaseApi();
    api.get("/api/loops", () => []);
    api.get("/api/workspaces", () => []);

    const { getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
    });

    const workspacesNewButton = getSectionActionButton("Workspaces");
    expect(workspacesNewButton).toBeTruthy();
    await user.click(workspacesNewButton!);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Create a workspace" })).toBeTruthy();
    });

    expect(document.querySelector("#workspace-name")).toBeTruthy();
    expect(document.querySelector("#workspace-directory")).toBeTruthy();
  });

  test("create workspace flow: fill form and submit", async () => {
    setupBaseApi();
    api.get("/api/loops", () => []);
    api.get("/api/workspaces", () => []);
    api.post("/api/workspaces", () => ({
      id: "ws-new",
      name: "New Project",
      directory: "/workspaces/new-project",
      serverSettings: {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "localhost",
          port: 22,
        },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    api.get("/api/workspaces", () => [{
      id: "ws-new",
      name: "New Project",
      directory: "/workspaces/new-project",
      serverSettings: {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "localhost",
          port: 22,
        },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }]);

    const { getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
    });

    const workspacesNewButton = getSectionActionButton("Workspaces");
    expect(workspacesNewButton).toBeTruthy();
    await user.click(workspacesNewButton!);
    await waitFor(() => {
      expect(getByRole("heading", { name: "Create a workspace" })).toBeTruthy();
    });

      const providerSelect = document.querySelector("#agent-provider") as HTMLSelectElement;
      const transportSelect = document.querySelector("#agent-transport") as HTMLSelectElement;
      expect(providerSelect.value).toBe("copilot");
      expect(transportSelect.value).toBe("ssh");

    // Fill name
    const nameInput = document.querySelector("#workspace-name") as HTMLInputElement;
    await user.type(nameInput, "X");

    // Fill directory
    const dirInput = document.querySelector("#workspace-directory") as HTMLInputElement;
    await user.type(dirInput, "/");

    await user.click(getByRole("button", { name: "Create Workspace" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/workspace/ws-new");
      expect(getByRole("heading", { name: "New Project" })).toBeTruthy();
    });

    const postCalls = api.calls("/api/workspaces", "POST");
    expect(postCalls.length).toBeGreaterThan(0);
      expect(postCalls[0]?.body).toEqual({
        name: "X",
        directory: "/",
        serverSettings: {
          agent: {
            provider: "copilot",
            transport: "ssh",
            hostname: "localhost",
            port: 22,
          },
        },
      });
  });

  test("create workspace can use a registered SSH server selection", async () => {
    setupBaseApi();
    api.get("/api/loops", () => []);
    api.get("/api/workspaces", () => []);
    api.get("/api/ssh-servers", () => [{
      config: {
        id: "server-1",
        name: "Build Box",
        address: "10.0.0.5",
        username: "vscode",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      publicKey: {
        algorithm: "RSA-OAEP-256",
        publicKey: "public-key",
        fingerprint: "fingerprint",
        version: 1,
        createdAt: new Date().toISOString(),
      },
    }]);
    api.get("/api/ssh-servers/:id/sessions", () => []);
    api.post("/api/workspaces", () => ({
      id: "ws-new",
      name: "Build Workspace",
      directory: "/workspaces/build",
      serverSettings: {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "10.0.0.5",
          port: 22,
        },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    api.get("/api/workspaces", () => [{
      id: "ws-new",
      name: "Build Workspace",
      directory: "/workspaces/build",
      serverSettings: {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "10.0.0.5",
          port: 22,
        },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }]);

    const { getByRole, queryByLabelText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
    });

    const workspacesNewButton = getSectionActionButton("Workspaces");
    expect(workspacesNewButton).toBeTruthy();
    await user.click(workspacesNewButton!);
    await waitFor(() => {
      expect(getByRole("heading", { name: "Create a workspace" })).toBeTruthy();
    });

    const transportSelect = document.querySelector("#agent-transport") as HTMLSelectElement;
    expect(transportSelect).toBeTruthy();
    await user.selectOptions(transportSelect, "ssh");

    const serverSelect = document.querySelector("#agent-registered-ssh-server") as HTMLSelectElement;
    expect(serverSelect).toBeTruthy();
    expect(serverSelect.value).toBe("__other__");

    await user.selectOptions(serverSelect, "server-1");

    expect(queryByLabelText("Hostname")).toBeNull();

    const nameInput = document.querySelector("#workspace-name") as HTMLInputElement;
    await user.type(nameInput, "Build Workspace");

    const dirInput = document.querySelector("#workspace-directory") as HTMLInputElement;
    await user.type(dirInput, "/workspaces/build");

    await user.click(getByRole("button", { name: "Create Workspace" }));

    await waitFor(() => {
      const postCalls = api.calls("/api/workspaces", "POST");
      expect(postCalls.length).toBeGreaterThan(0);
    });

    const postCalls = api.calls("/api/workspaces", "POST");
    expect(postCalls[0]?.body).toEqual({
      name: "Build Workspace",
      directory: "/workspaces/build",
      serverSettings: {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "10.0.0.5",
          port: 22,
        },
      },
    });
  });

  test("shell composer keeps create controls working when switching to automatic mode", async () => {
    setupBaseApi();
    api.get("/api/loops", () => []);
    api.get("/api/workspaces", () => []);
    api.get("/api/ssh-servers", () => [{
      config: {
        id: "server-1",
        name: "Build Box",
        address: "10.0.0.5",
        username: "vscode",
        repositoriesBasePath: "/srv/workspaces",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      publicKey: {
        algorithm: "RSA-OAEP-256",
        publicKey: "public-key",
        fingerprint: "fingerprint",
        version: 1,
        createdAt: new Date().toISOString(),
      },
    }]);
    const startedSnapshot = {
      job: {
        config: {
          id: "job-1",
          name: "Provisioned Workspace",
          sshServerId: "server-1",
          repoUrl: "git@github.com:owner/repo.git",
          basePath: "/srv/workspaces",
          provider: "copilot",
          createdAt: new Date().toISOString(),
        },
        state: {
          status: "running",
          currentStep: "clone_repo",
          updatedAt: new Date().toISOString(),
        },
      },
      logs: [],
    };
    api.post("/api/provisioning-jobs", () => startedSnapshot);
    api.get("/api/provisioning-jobs/:id", () => startedSnapshot);

    const { getByRole, queryByLabelText, queryByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
    });

    const workspacesNewButton = getSectionActionButton("Workspaces");
    expect(workspacesNewButton).toBeTruthy();
    await user.click(workspacesNewButton!);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Create a workspace" })).toBeTruthy();
      expect(getByRole("button", { name: "Create Workspace" })).toBeTruthy();
      expect(queryByRole("button", { name: "Cancel" })).toBeNull();
    });

    await user.click(getByRole("button", { name: "Automatic" }));

    await waitFor(() => {
      expect(queryByLabelText("Directory *")).toBeNull();
      expect(getByRole("button", { name: "Start Provisioning" })).toBeTruthy();
      expect(queryByRole("button", { name: "Cancel" })).toBeNull();
    });

    const nameInput = document.querySelector("#workspace-name") as HTMLInputElement | null;
    const serverSelect = document.querySelector("#automatic-ssh-server") as HTMLSelectElement | null;
    const repoInput = document.querySelector("#automatic-repo-url") as HTMLInputElement | null;

    expect(nameInput).toBeTruthy();
    expect(serverSelect).toBeTruthy();
    expect(repoInput).toBeTruthy();

    await user.type(nameInput!, "Provisioned Workspace");
    await user.selectOptions(serverSelect!, "server-1");
    await user.type(repoInput!, "git@github.com:owner/repo.git");

    const basePathInput = document.querySelector("#automatic-base-path") as HTMLInputElement | null;
    expect(basePathInput).toBeTruthy();
    expect(basePathInput?.value).toBe("/srv/workspaces");

    await user.click(getByRole("button", { name: "Start Provisioning" }));

    await waitFor(() => {
      expect(api.calls("/api/provisioning-jobs", "POST")).toHaveLength(1);
      expect(getByRole("heading", { name: "Create a workspace" })).toBeTruthy();
      expect(getByRole("button", { name: "Cancel Job" })).toBeTruthy();
      expect(getByRole("heading", { name: "Provisioning log" })).toBeTruthy();
    });
  });

  test("workspace map includes empty workspaces and navigates to workspace details", async () => {
    setupBaseApi();
    api.get("/api/loops", () => []);
    api.get("/api/workspaces", () => [WORKSPACE]);

    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByText("Workspaces map")).toBeTruthy();
    });

    await user.click(getAllByText("Existing Project")[0]!);
    await waitFor(() => {
      expect(window.location.hash).toBe("#/workspace/ws-1");
      expect(getByRole("heading", { name: "Existing Project" })).toBeTruthy();
    });
    expect(getByRole("heading", { name: "Activity" })).toBeTruthy();
    expect(getByText("No active items in this workspace right now.")).toBeTruthy();
  });

  test("workspace route splits active items from workspace history", async () => {
    setupBaseApi();

    const loop = createLoopWithStatus("running", {
      config: { id: "ws-loop-1", name: "In Workspace", directory: "/workspaces/existing", workspaceId: "ws-1" },
    });
    const mergedLoop = createLoopWithStatus("merged", {
      config: { id: "ws-loop-2", name: "Merged Workspace Loop", directory: "/workspaces/existing", workspaceId: "ws-1" },
    });
    const deletedLoop = createLoopWithStatus("deleted", {
      config: { id: "ws-loop-3", name: "Deleted Workspace Loop", directory: "/workspaces/existing", workspaceId: "ws-1" },
    });
    const chat: Chat = {
      config: {
        id: "ws-chat-1",
        name: "Workspace Chat",
        workspaceId: "ws-1",
        directory: "/workspaces/existing",
        model: {
          providerID: "github",
          modelID: "gpt-5.4",
          variant: "",
        },
        useWorktree: true,
        baseBranch: "main",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        mode: "chat",
      },
      state: {
        id: "ws-chat-1",
        status: "idle",
        messages: [],
        logs: [],
        toolCalls: [],
      },
    };
    const session = createSshSession({
      config: {
        id: "ws-session-1",
        name: "Workspace SSH",
        workspaceId: "ws-1",
      },
    });
    const server: SshServer = {
      config: {
        id: "server-1",
        name: "Build host",
        address: "server.example.com",
        username: "ubuntu",
        repositoriesBasePath: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      publicKey: {
        algorithm: "RSA-OAEP-256",
        publicKey: "test-key",
        fingerprint: "fingerprint",
        version: 1,
        createdAt: new Date().toISOString(),
      },
    };
    const sshWorkspace = createWorkspace({
      ...WORKSPACE,
      serverSettings: {
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "server.example.com",
          port: 22,
        },
      },
    });

    api.get("/api/loops", () => [loop, mergedLoop, deletedLoop]);
    api.get("/api/chats", () => [chat]);
    api.get("/api/ssh-sessions", () => [session]);
    api.get("/api/ssh-servers", () => [server]);
    api.get("/api/ssh-servers/:id/sessions", () => []);
    api.get("/api/workspaces", () => [sshWorkspace]);
    api.get("/api/workspaces/:id", () => sshWorkspace);

    const { getAllByText, getByRole, queryByRole, queryByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Existing Project").length).toBeGreaterThan(0);
    });

    await user.click(getAllByText("Existing Project")[0]!);
    await waitFor(() => {
      expect(getByRole("heading", { name: "Existing Project" })).toBeTruthy();
    });

    const activityHeading = getByRole("heading", { name: "Activity" });
    const activityCard = activityHeading.closest("div.rounded-2xl") as HTMLElement | null;
    expect(activityCard).toBeTruthy();
    expect(within(activityCard!).getByText("Active loops, chats, and SSH sessions in this workspace.")).toBeTruthy();
    expect(
      getAllByText((content) => content === "Build host" || content === "server.example.com").length
    ).toBeGreaterThan(0);
    expect(document.body.textContent?.includes("Connection")).toBe(false);
    expect(queryByText("Workspace activity")).toBeNull();
    expect(queryByRole("heading", { name: "Loops" })).toBeNull();
    expect(queryByRole("heading", { name: "Chats" })).toBeNull();
    expect(queryByRole("heading", { name: "SSH sessions" })).toBeNull();
    expect(within(activityCard!).getByText("In Workspace")).toBeTruthy();
    expect(within(activityCard!).queryByText("Merged Workspace Loop")).toBeNull();
    expect(within(activityCard!).queryByText("Deleted Workspace Loop")).toBeNull();
    expect(getAllByText("Workspace Chat").length).toBeGreaterThan(0);
    expect(getAllByText("Workspace SSH").length).toBeGreaterThan(0);

    const historyHeading = getByRole("heading", { name: "History" });
    const historyCard = historyHeading.closest("div.rounded-2xl") as HTMLElement | null;
    expect(historyCard).toBeTruthy();
    expect(within(historyCard!).getByText("Merged and deleted loops from this workspace.")).toBeTruthy();
    expect(within(historyCard!).getByText("Merged Workspace Loop")).toBeTruthy();
    expect(within(historyCard!).getByText("Deleted Workspace Loop")).toBeTruthy();
    expect(within(historyCard!).queryByText("In Workspace")).toBeNull();
  });

  test("workspace route shows stdio in the header for local workspaces", async () => {
    setupBaseApi();
    api.get("/api/loops", () => []);
    api.get("/api/chats", () => []);
    api.get("/api/ssh-sessions", () => []);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.get("/api/workspaces/:id", () => WORKSPACE);

    const { getAllByText, getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Existing Project").length).toBeGreaterThan(0);
    });

    await user.click(getAllByText("Existing Project")[0]!);
    await waitFor(() => {
      expect(getByRole("heading", { name: "Existing Project" })).toBeTruthy();
    });

    expect(getAllByText("stdio").length).toBeGreaterThan(0);
  });

  test("workspace menu owns pull latest while settings keep restart and rebuild actions", async () => {
    setupBaseApi();

    const provisionedWorkspace = createWorkspace({
      ...WORKSPACE,
      sourceDirectory: "/workspaces/existing",
      sshServerId: "server-1",
    });

    api.get("/api/loops", () => []);
    api.get("/api/chats", () => []);
    api.get("/api/ssh-sessions", () => []);
    api.get("/api/workspaces", () => [provisionedWorkspace]);
    api.get("/api/workspaces/:id", () => provisionedWorkspace);
    api.post("/api/workspaces/:id/pull-latest-changes", () => ({
      success: true,
      defaultBranch: "main",
      currentBranch: "main",
    }), 200);

    const { getAllByText, getByRole, queryByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Existing Project").length).toBeGreaterThan(0);
    });

    await user.click(getAllByText("Existing Project")[0]!);
    await waitFor(() => {
      expect(getByRole("heading", { name: "Existing Project" })).toBeTruthy();
    });

    expect(queryByRole("button", { name: "Restart" })).toBeNull();
    expect(queryByRole("button", { name: "Rebuild" })).toBeNull();

    await user.click(getByRole("button", { name: "Workspace actions for Existing Project" }));
    await waitFor(() => {
      expect(getByRole("menuitem", { name: "Pull Latest Changes" })).toBeTruthy();
    });

    await user.click(getByRole("menuitem", { name: "Pull Latest Changes" }));

    await waitFor(() => {
      expect(api.calls("/api/workspaces/:id/pull-latest-changes", "POST")).toHaveLength(1);
    });

    await user.click(getByRole("button", { name: "Open workspace settings" }));
    await waitFor(() => {
      expect(getByRole("button", { name: "Restart" })).toBeTruthy();
    });

    expect(getByRole("button", { name: "Rebuild" })).toBeTruthy();
    expect(queryByRole("button", { name: "Pull Latest Changes" })).toBeNull();
  });

  test("workspace activity card keeps SSH copy clear when legacy sessions exist on stdio workspaces", async () => {
    setupBaseApi();

    const legacySession = createSshSession({
      config: {
        id: "ws-session-legacy",
        name: "Legacy SSH",
        workspaceId: WORKSPACE.id,
      },
    });

    api.get("/api/loops", () => []);
    api.get("/api/chats", () => []);
    api.get("/api/ssh-sessions", () => [legacySession]);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.get("/api/workspaces/:id", () => WORKSPACE);

    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Existing Project").length).toBeGreaterThan(0);
    });

    await user.click(getAllByText("Existing Project")[0]!);
    await waitFor(() => {
      expect(getByRole("heading", { name: "Activity" })).toBeTruthy();
    });

    expect(getByText("Active loops and chats in this workspace. Legacy SSH sessions may also appear here for non-SSH workspaces.")).toBeTruthy();
    expect(getAllByText("Legacy SSH").length).toBeGreaterThan(0);
    expect(document.body.textContent?.includes("stay at 0")).toBe(false);
  });

  test("workspace detail rows keep long loop and session names shrinkable on mobile", async () => {
    setupBaseApi();

    const longLoopName = "Loop name that is intentionally extremely long to verify mobile truncation stays inside the workspace detail card";
    const longSessionName = "SSH session name that is intentionally extremely long to verify mobile truncation stays inside the workspace detail card";
    const loop = createLoopWithStatus("running", {
      config: { id: "ws-loop-long", name: longLoopName, directory: "/workspaces/existing", workspaceId: "ws-1" },
    });
    const session = createSshSession({
      config: {
        id: "ws-session-long",
        name: longSessionName,
        workspaceId: "ws-1",
      },
      state: { status: "connected" },
    });

    api.get("/api/loops", () => [loop]);
    api.get("/api/ssh-sessions", () => [session]);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.get("/api/workspaces/:id", () => WORKSPACE);

    const { getAllByText, getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Existing Project").length).toBeGreaterThan(0);
    });

    await user.click(getAllByText("Existing Project")[0]!);
    await waitFor(() => {
      expect(getByRole("heading", { name: "Existing Project" })).toBeTruthy();
    });

    const activityCard = document.querySelector('[data-testid="workspace-activity-card"]');

    const loopRow = Array.from(activityCard?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes(longLoopName)
    );
    const sessionRow = Array.from(activityCard?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes(longSessionName)
    );

    expect(loopRow?.className).toContain("min-w-0");
    expect(loopRow?.querySelector("span.flex-1")?.className).toContain("min-w-0");
    expect(loopRow?.querySelector("span.shrink-0")).toBeTruthy();

    expect(sessionRow?.className).toContain("min-w-0");
    expect(sessionRow?.querySelector("span.flex-1")?.className).toContain("min-w-0");
    expect(sessionRow?.querySelector("span.shrink-0")).toBeTruthy();
  });
});
