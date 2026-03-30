/**
 * E2E Scenario: Workspace Management
 *
 * Tests shell-native workspace workflows: composing workspaces in the main
 * panel, using registered SSH servers, and navigating workspace detail views.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";
import {
  createLoopWithStatus,
  createSshSession,
  createWorkspace,
  createModelInfo,
} from "../helpers/factories";
import { App } from "@/App";

const api = createMockApi();
const ws = createMockWebSocket();

const WORKSPACE = createWorkspace({
  id: "ws-1",
  name: "Existing Project",
  directory: "/workspaces/existing",
});

function setupBaseApi() {
  api.get("/api/config", () => ({ remoteOnly: false }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/preferences/last-model", () => null);
  api.get("/api/preferences/log-level", () => ({ level: "info" }));
  api.get("/api/preferences/last-directory", () => null);
  api.get("/api/models", () => [createModelInfo({ connected: true })]);
  api.get("/api/ssh-sessions", () => []);
  api.get("/api/ssh-servers", () => []);
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

    const createBtns = Array.from(document.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "Create Workspace",
    );
    const submitBtn = createBtns.find((b) => b.type === "submit");
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn!);

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

    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Create Workspace" && button.type === "submit",
    );
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn!);

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

  test("cancel create workspace returns to the overview", async () => {
    setupBaseApi();
    api.get("/api/loops", () => []);
    api.get("/api/workspaces", () => []);

    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
    });

    const workspacesNewButton = getSectionActionButton("Workspaces");
    expect(workspacesNewButton).toBeTruthy();
    await user.click(workspacesNewButton!);
    await waitFor(() => {
      expect(getByText("Create a workspace")).toBeTruthy();
    });

    const cancelButtons = getAllByText("Cancel");
    await user.click(cancelButtons.at(-1)!);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/");
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
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
    expect(getByText("No loops in this workspace yet.")).toBeTruthy();
  });

  test("workspace route shows summary cards and related loop content", async () => {
    setupBaseApi();

    const loop = createLoopWithStatus("running", {
      config: { id: "ws-loop-1", name: "In Workspace", directory: "/workspaces/existing", workspaceId: "ws-1" },
    });

    api.get("/api/loops", () => [loop]);
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
    expect(getByRole("heading", { name: "Loops" })).toBeTruthy();
    expect(getByRole("heading", { name: "SSH sessions" })).toBeTruthy();
    expect(getAllByText("In Workspace").length).toBeGreaterThan(0);
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

    const loopsCard = getByRole("heading", { name: "Loops" }).parentElement?.parentElement;
    const sshSessionsCard = getByRole("heading", { name: "SSH sessions" }).parentElement?.parentElement;
    expect(loopsCard?.className).toContain("min-w-0");
    expect(sshSessionsCard?.className).toContain("min-w-0");

    const loopRow = Array.from(loopsCard?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes(longLoopName)
    );
    const sessionRow = Array.from(sshSessionsCard?.querySelectorAll("button") ?? []).find((button) =>
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
