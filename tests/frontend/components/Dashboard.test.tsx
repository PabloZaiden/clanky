/**
 * Tests for Dashboard component.
 *
 * Tests task grid rendering grouped by workspace/status, header elements,
 * modal flows, navigation, connection status, and error display.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";
import { createTaskWithStatus, createServerSettings, createSshSession, createWorkspace } from "../helpers/factories";
import { Dashboard } from "@/components/Dashboard";
import { AppEventsProvider, ThemePreferenceProvider } from "@/hooks";

const api = createMockApi();
const ws = createMockWebSocket();

function renderWithAppEvents(
  ui: Parameters<typeof renderWithUser>[0],
  options?: Parameters<typeof renderWithUser>[1],
) {
  return renderWithUser(<AppEventsProvider>{ui}</AppEventsProvider>, options);
}

/** Set up the default API routes Dashboard requires. */
function setupDefaultApi() {
  api.get("/api/tasks", () => []);
  api.get("/api/workspaces", () => []);
  api.get("/api/ssh-sessions", () => []);
  api.get("/api/ssh-servers", () => []);
  api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/preferences/last-model", () => null);
  api.get("/api/preferences/log-level", () => ({ level: "info" }));
  api.get("/api/models", () => []);
  api.get("/api/check-planning-dir", () => ({ warning: null }));
  api.get("/api/git/branches", () => ({ branches: [], currentBranch: "" }));
  api.get("/api/git/default-branch", () => ({ defaultBranch: "main" }));
  // Workspace settings (used by useWorkspaceServerSettings hook)
  api.get("/api/workspaces/:id", () => null);
  api.get("/api/workspaces/:id/status", () => null);
}

beforeEach(() => {
  api.reset();
  api.install();
  ws.reset();
  ws.install();
  globalThis.localStorage?.clear();
  setupDefaultApi();
});

afterEach(() => {
  api.uninstall();
  ws.uninstall();
});

// ─── Connection status ──────────────────────────────────────────────────────
// Connection status indicator was removed from the Dashboard in a prior refactor.
// Connection status is now shown only in workspace-level settings.

describe("ssh section", () => {
  test("lets the user choose the SSH workspace from the header when multiple SSH workspaces exist", async () => {
    const sshWorkspaceOne = createWorkspace({
      id: "ws-1",
      name: "Alpha SSH",
      directory: "/workspaces/alpha",
      serverSettings: createServerSettings({ mode: "connect", hostname: "alpha.example.com" }),
    });
    const sshWorkspaceTwo = createWorkspace({
      id: "ws-2",
      name: "Beta SSH",
      directory: "/workspaces/beta",
      serverSettings: createServerSettings({ mode: "connect", hostname: "beta.example.com" }),
    });

    api.get("/api/workspaces", () => [sshWorkspaceOne, sshWorkspaceTwo]);
    api.post("/api/ssh-sessions", (req) => {
      const body = req.body as { workspaceId: string };
      return createSshSession({
        config: {
          id: "ssh-picked-1",
          workspaceId: body.workspaceId,
          directory: body.workspaceId === "ws-2" ? sshWorkspaceTwo.directory : sshWorkspaceOne.directory,
        },
      });
    });

    const onSelectSshSession: string[] = [];
    const { getByLabelText, getByRole, user } = renderWithAppEvents(
      <Dashboard onSelectSshSession={(sessionId) => onSelectSshSession.push(sessionId)} />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: "New SSH Session" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "New SSH Session" }));

    await waitFor(() => {
      expect(getByRole("heading", { name: "Create SSH Session" })).toBeTruthy();
    });

    await user.selectOptions(getByLabelText(/Workspace/) as HTMLSelectElement, "ws-2");
    await user.click(getByRole("button", { name: "Create SSH Session" }));

    await waitFor(() => {
      expect(onSelectSshSession).toEqual(["ssh-picked-1"]);
    });

    const sessionCreates = api.calls("/api/ssh-sessions", "POST");
    expect(sessionCreates).toHaveLength(1);
    expect(sessionCreates[0]?.body).toEqual({ workspaceId: "ws-2", name: "Beta SSH terminal", connectionMode: "dtach" });
  });

  test("renders a single collapsed SSH section that can reveal workspace sessions", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Project" });
    const task = createTaskWithStatus("running", {
      config: { id: "task-1", name: "Visible Task", workspaceId: "ws-1" },
    });
    const session = createSshSession({
      config: { id: "ssh-1", name: "Remote Shell" },
      state: { status: "connected" },
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/workspaces", () => [workspace]);
    api.get("/api/ssh-sessions", () => [session]);

    const { getByRole, queryByText, user } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByRole("button", { name: /SSH \(1\)/ })).toBeTruthy();
    });

    expect(queryByText("Remote Shell")).toBeNull();
    expect(queryByText("Workspace SSH Sessions")).toBeNull();

    await user.click(getByRole("button", { name: /SSH \(1\)/ }));

    await waitFor(() => {
      expect(queryByText("Remote Shell")).toBeTruthy();
      expect(queryByText("Workspace SSH Sessions")).toBeTruthy();
      expect(queryByText("Visible Task")).toBeTruthy();
    });
  });

  test("can collapse the unified ssh section without hiding tasks", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Project" });
    const task = createTaskWithStatus("running", {
      config: { id: "task-1", name: "Task Still Visible", workspaceId: "ws-1" },
    });
    const session = createSshSession({
      config: { id: "ssh-1", name: "Collapsible SSH" },
      state: { status: "connected" },
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/workspaces", () => [workspace]);
    api.get("/api/ssh-sessions", () => [session]);

    const { getByRole, getByText, queryByText, user } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByRole("button", { name: /SSH \(1\)/ })).toBeTruthy();
    });

    await waitFor(() => {
      expect(getByText("Task Still Visible")).toBeTruthy();
    });

    expect(queryByText("Collapsible SSH")).toBeNull();

    await waitFor(() => {
      expect(getByText("Task Still Visible")).toBeTruthy();
    });

    await user.click(getByRole("button", { name: /SSH \(1\)/ }));

    await waitFor(() => {
      expect(getByText("Collapsible SSH")).toBeTruthy();
    });

    await user.click(getByRole("button", { name: /SSH \(1\)/ }));

    await waitFor(() => {
      expect(queryByText("Collapsible SSH")).toBeNull();
    });

    expect(getByText("Task Still Visible")).toBeTruthy();
  });
 
  test("renders standalone servers and workspace sessions inside the same SSH section", async () => {
    const workspaceSession = createSshSession({
      config: { id: "ssh-1", name: "Workspace shell" },
      state: { status: "connected" },
    });

    api.get("/api/ssh-sessions", () => [workspaceSession]);
    api.get("/api/ssh-servers", () => [{
      config: {
        id: "server-1",
        name: "Shared host",
        address: "ssh.example.com",
        username: "deploy",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      publicKey: {
        algorithm: "RSA-OAEP-256",
        publicKey: "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----",
        fingerprint: "fp-1",
        version: 1,
        createdAt: new Date().toISOString(),
      },
    }]);
    api.get("/api/ssh-servers/:id/sessions", () => [{
      config: {
        id: "server-session-1",
        sshServerId: "server-1",
        name: "Deploy shell",
        connectionMode: "dtach",
        remoteSessionName: "clanky-serversession1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      state: { status: "ready" },
    }]);

    const { getByRole, queryByText, user } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByRole("button", { name: /SSH \(2\)/ })).toBeTruthy();
    });

    expect(queryByText("Shared host")).toBeNull();
    expect(queryByText("Workspace shell")).toBeNull();

    await user.click(getByRole("button", { name: /SSH \(2\)/ }));

    await waitFor(() => {
      expect(queryByText("Standalone SSH Servers")).toBeTruthy();
      expect(queryByText("Workspace SSH Sessions")).toBeTruthy();
      expect(queryByText("Shared host")).toBeTruthy();
      expect(queryByText("Deploy shell")).toBeTruthy();
      expect(queryByText("deploy@ssh.example.com")).toBeTruthy();
      expect(queryByText("Workspace shell")).toBeTruthy();
    });
  });

  test("renames a workspace SSH session from the dashboard section", async () => {
    const session = createSshSession({
      config: { id: "ssh-rename-1", name: "Original Shell" },
      state: { status: "connected" },
    });

    api.get("/api/ssh-sessions", () => [session]);
    api.patch("/api/ssh-sessions/:id", (req) => {
      const body = req.body as { name: string };
      return createSshSession({
        config: {
          ...session.config,
          id: req.params["id"]!,
          name: body.name,
        },
        state: session.state,
      });
    });

    const { getByRole, getAllByLabelText, getByLabelText, getByText, user } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByRole("button", { name: /SSH \(1\)/ })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: /SSH \(1\)/ }));

    await waitFor(() => {
      expect(getByText("Original Shell")).toBeTruthy();
    });

    await user.click(getAllByLabelText("Rename SSH session")[0]!);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Rename SSH Session" })).toBeTruthy();
    });

    const input = getByLabelText("SSH Session Name") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Renamed Shell");
    await user.click(getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(getByText("Renamed Shell")).toBeTruthy();
    });

    const renameCalls = api.calls("/api/ssh-sessions/:id", "PATCH");
    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0]?.params["id"]).toBe("ssh-rename-1");
    expect(renameCalls[0]?.body).toEqual({ name: "Renamed Shell" });
  });
});

describe("standalone ssh servers section", () => {

  test("creates a standalone session using a browser-stored encrypted credential", async () => {
    globalThis.localStorage?.setItem("clanky.sshServerCredential.server-1", JSON.stringify({
      encryptedCredential: {
        algorithm: "RSA-OAEP-256",
        fingerprint: "fp-1",
        version: 1,
        ciphertext: "ciphertext",
      },
      storedAt: new Date().toISOString(),
    }));

    api.get("/api/ssh-servers", () => [{
      config: {
        id: "server-1",
        name: "Shared host",
        address: "ssh.example.com",
        username: "deploy",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      publicKey: {
        algorithm: "RSA-OAEP-256",
        publicKey: "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----",
        fingerprint: "fp-1",
        version: 1,
        createdAt: new Date().toISOString(),
      },
    }]);
    api.get("/api/ssh-servers/:id/sessions", () => []);
    api.post("/api/ssh-servers/:id/sessions", (req) => ({
      config: {
        id: "server-session-1",
        sshServerId: req.params["id"]!,
        name: (req.body as { name?: string }).name ?? "Deploy shell",
        connectionMode: "dtach",
        remoteSessionName: "clanky-serversession1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      state: { status: "ready" },
    }));

    const onSelectSshSession: string[] = [];
    const { getByRole, queryByRole, user } = renderWithAppEvents(
      <Dashboard onSelectSshSession={(sessionId) => onSelectSshSession.push(sessionId)} />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: /SSH \(1\)/ })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: /SSH \(1\)/ }));

    await waitFor(() => {
      expect(getByRole("button", { name: "Delete Server" })).toBeTruthy();
      expect(getByRole("button", { name: "New Session" })).toBeTruthy();
    });

    const deleteButton = getByRole("button", { name: "Delete Server" });
    const newSessionButton = getByRole("button", { name: "New Session" });
    expect(deleteButton.compareDocumentPosition(newSessionButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    expect(queryByRole("button", { name: "Edit" })).toBeNull();

    await user.click(newSessionButton);

    await waitFor(() => {
      expect(onSelectSshSession).toEqual(["server-session-1"]);
    });

    expect(api.calls("/api/ssh-servers/:id/credentials", "POST")).toHaveLength(0);
    expect(api.calls("/api/ssh-servers/:id/sessions", "POST")).toHaveLength(1);
  });
});

// ─── Task grid rendering ────────────────────────────────────────────────────

describe("task grid rendering", () => {
  test("renders tasks grouped by workspace", async () => {
    const ws1 = createWorkspace({ id: "ws-1", name: "Frontend" });
    const ws2 = createWorkspace({ id: "ws-2", name: "Backend" });
    const task1 = createTaskWithStatus("running", {
      config: { id: "l1", name: "Fix UI bug", workspaceId: "ws-1" },
    });
    const task2 = createTaskWithStatus("completed", {
      config: { id: "l2", name: "Add API endpoint", workspaceId: "ws-2" },
    });

    api.get("/api/tasks", () => [task1, task2]);
    api.get("/api/workspaces", () => [ws1, ws2]);

    const { getByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("Frontend")).toBeTruthy();
      expect(getByText("Backend")).toBeTruthy();
    });
    expect(getByText("Fix UI bug")).toBeTruthy();
    expect(getByText("Add API endpoint")).toBeTruthy();
  });

  test("renders workspace directory and task count", async () => {
    const workspace = createWorkspace({
      id: "ws-1",
      name: "My Project",
      directory: "/home/user/my-project",
    });
    const task = createTaskWithStatus("running", {
      config: { id: "l1", name: "Task 1", workspaceId: "ws-1" },
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/workspaces", () => [workspace]);

    const { getByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("/home/user/my-project")).toBeTruthy();
    });
    expect(getByText("(1 task)")).toBeTruthy();
  });

  test("renders status group headers for active tasks", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Project" });
    const runningTask = createTaskWithStatus("running", {
      config: { id: "l1", name: "Running Task", workspaceId: "ws-1" },
    });
    const completedTask = createTaskWithStatus("completed", {
      config: { id: "l2", name: "Done Task", workspaceId: "ws-1" },
    });

    api.get("/api/tasks", () => [runningTask, completedTask]);
    api.get("/api/workspaces", () => [workspace]);

    const { getByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("Active (1)")).toBeTruthy();
    });
    expect(getByText("Completed (1)")).toBeTruthy();
  });

  test("renders draft tasks in Drafts section", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Project" });
    const draftTask = createTaskWithStatus("draft", {
      config: { id: "l1", name: "Draft Task", workspaceId: "ws-1" },
    });

    api.get("/api/tasks", () => [draftTask]);
    api.get("/api/workspaces", () => [workspace]);

    const { getByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("Drafts (1)")).toBeTruthy();
    });
    expect(getByText("Draft Task")).toBeTruthy();
  });

  test("renders awaiting feedback tasks in correct section", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Project" });
    const pushedTask = createTaskWithStatus("pushed", {
      config: { id: "l1", name: "Pushed Task", workspaceId: "ws-1" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 1,
        },
      },
    });

    api.get("/api/tasks", () => [pushedTask]);
    api.get("/api/workspaces", () => [workspace]);

    const { getByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("Awaiting Feedback (1)")).toBeTruthy();
    });
  });

  test("renders unassigned tasks when task has no workspace", async () => {
    const task = createTaskWithStatus("running", {
      config: { id: "l1", name: "Orphan Task", workspaceId: "" },
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/workspaces", () => []);

    const { getByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("Unassigned")).toBeTruthy();
    });
    expect(getByText("Orphan Task")).toBeTruthy();
  });

  test("renders tasks with a missing workspace in the unassigned section", async () => {
    const task = createTaskWithStatus("running", {
      config: { id: "l2", name: "Missing Workspace Task", workspaceId: "missing-workspace" },
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/workspaces", () => []);

    const { getByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("Unassigned")).toBeTruthy();
      expect(
        getByText("Tasks appear here when they are not assigned to a workspace or when their saved workspace is no longer available.")
      ).toBeTruthy();
    });
    expect(getByText("Missing Workspace Task")).toBeTruthy();
  });

  test("does not classify missing-workspace tasks as unassigned before workspaces finish loading", async () => {
    const task = createTaskWithStatus("running", {
      config: { id: "l3", name: "Loading Workspace Task", workspaceId: "missing-workspace" },
    });
    let resolveWorkspaces: (value: ReturnType<typeof createWorkspace>[]) => void = () => {};
    const workspacesPromise = new Promise<ReturnType<typeof createWorkspace>[]>((resolve) => {
      resolveWorkspaces = resolve;
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/workspaces", async () => await workspacesPromise);

    const { queryByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(api.calls("/api/tasks", "GET").length).toBe(1);
      expect(api.calls("/api/workspaces", "GET").length).toBe(1);
    });

    expect(queryByText("Unassigned")).toBeNull();
    expect(queryByText("Loading Workspace Task")).toBeNull();

    resolveWorkspaces([]);

    await waitFor(() => {
      expect(queryByText("Unassigned")).toBeTruthy();
      expect(queryByText("Loading Workspace Task")).toBeTruthy();
    });
  });

  test("marks workspace SSH sessions whose workspace is missing", async () => {
    const session = createSshSession({
      config: {
        id: "ssh-orphan-1",
        name: "Orphaned Shell",
        workspaceId: "missing-workspace",
      },
      state: { status: "failed", error: "Workspace missing" },
    });

    api.get("/api/workspaces", () => []);
    api.get("/api/ssh-sessions", () => [session]);

    const { getByRole, getByText, user } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByRole("button", { name: /SSH \(1\)/ })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: /SSH \(1\)/ }));

    await waitFor(() => {
      expect(getByText("Orphaned Shell")).toBeTruthy();
      expect(getByText("Workspace missing")).toBeTruthy();
      expect(
        getByText("The saved workspace for this SSH session is no longer available, but the session can still be opened or deleted.")
      ).toBeTruthy();
    });
  });

  test("does not show workspace-missing SSH warnings before workspaces finish loading", async () => {
    const session = createSshSession({
      config: {
        id: "ssh-orphan-2",
        name: "Loading Shell",
        workspaceId: "missing-workspace",
      },
      state: { status: "failed", error: "Workspace missing" },
    });
    let resolveWorkspaces: (value: ReturnType<typeof createWorkspace>[]) => void = () => {};
    const workspacesPromise = new Promise<ReturnType<typeof createWorkspace>[]>((resolve) => {
      resolveWorkspaces = resolve;
    });

    api.get("/api/workspaces", async () => await workspacesPromise);
    api.get("/api/ssh-sessions", () => [session]);

    const { getByRole, queryByText, user } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByRole("button", { name: /SSH \(1\)/ })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: /SSH \(1\)/ }));

    await waitFor(() => {
      expect(queryByText("Loading Shell")).toBeTruthy();
    });

    expect(queryByText("Workspace missing")).toBeNull();
    expect(
      queryByText("The saved workspace for this SSH session is no longer available, but the session can still be opened or deleted.")
    ).toBeNull();

    resolveWorkspaces([]);

    await waitFor(() => {
      expect(queryByText("Workspace missing")).toBeTruthy();
      expect(
        queryByText("The saved workspace for this SSH session is no longer available, but the session can still be opened or deleted.")
      ).toBeTruthy();
    });
  });

  test("renders archived tasks (merged/pushed/deleted)", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Project" });
    const mergedTask = createTaskWithStatus("merged", {
      config: { id: "l1", name: "Merged Task", workspaceId: "ws-1" },
    });

    api.get("/api/tasks", () => [mergedTask]);
    api.get("/api/workspaces", () => [workspace]);

    const { getByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("Archived (1)")).toBeTruthy();
    });
  });
});

// ─── Task card click navigation ─────────────────────────────────────────────

describe("task card click navigation", () => {
  test("calls onSelectTask when an active task card is clicked", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Project" });
    const task = createTaskWithStatus("running", {
      config: { id: "task-123", name: "Click Me", workspaceId: "ws-1" },
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/workspaces", () => [workspace]);

    let selectedTaskId: string | undefined;
    const { getByText, user } = renderWithAppEvents(
      <Dashboard onSelectTask={(id) => { selectedTaskId = id; }} />,
    );

    await waitFor(() => {
      expect(getByText("Click Me")).toBeTruthy();
    });

    await user.click(getByText("Click Me"));

    expect(selectedTaskId).toBe("task-123");
  });

  test("calls onSelectTask when a completed task card is clicked", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Project" });
    const task = createTaskWithStatus("completed", {
      config: { id: "task-456", name: "Done Task", workspaceId: "ws-1" },
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/workspaces", () => [workspace]);

    let selectedTaskId: string | undefined;
    const { getByText, user } = renderWithAppEvents(
      <Dashboard onSelectTask={(id) => { selectedTaskId = id; }} />,
    );

    await waitFor(() => {
      expect(getByText("Done Task")).toBeTruthy();
    });

    await user.click(getByText("Done Task"));

    expect(selectedTaskId).toBe("task-456");
  });
});

// ─── Create task modal ──────────────────────────────────────────────────────

describe("create task modal", () => {
  test("opens create task modal when 'New Task' is clicked", async () => {
    const { getByRole, getByText, user } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByRole("button", { name: "New Task" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "New Task" }));

    await waitFor(() => {
      expect(getByText("Create New Task")).toBeTruthy();
    });
  });

  test("closes create task modal on cancel", async () => {
    const { getByRole, getByText, queryByText, user } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByRole("button", { name: "New Task" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "New Task" }));

    await waitFor(() => {
      expect(getByText("Create New Task")).toBeTruthy();
    });

    // The modal has a Cancel button in footer
    await user.click(getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(queryByText("Create New Task")).toBeNull();
    });
  });
});

// ─── Delete task modal ──────────────────────────────────────────────────────
// Delete/Accept/Purge/Address Comments action buttons were removed from dashboard
// cards in a prior refactor. These actions are now available only in TaskDetails.

// ─── Accept task modal ──────────────────────────────────────────────────────
// Accept action was removed from dashboard cards (now in TaskDetails).

// ─── Purge task modal ───────────────────────────────────────────────────────
// Purge action was removed from dashboard cards (now in TaskDetails).

// ─── Address comments modal ─────────────────────────────────────────────────
// Address comments action was removed from dashboard cards (now in TaskDetails).

// ─── Task rename restrictions ────────────────────────────────────────────────

describe("task rename restrictions", () => {
  test("does not expose rename controls for started tasks", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Project" });
    const task = createTaskWithStatus("running", {
      config: { id: "l1", name: "Rename Me", workspaceId: "ws-1" },
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/workspaces", () => [workspace]);

    const { getByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("Rename Me")).toBeTruthy();
    });

    const renameBtn = document.querySelector('button[aria-label="Rename task"]');
    expect(renameBtn).toBeNull();
  });
});

// ─── App settings modal ─────────────────────────────────────────────────────

describe("app settings modal", () => {
  test("opens app settings modal when settings button is clicked", async () => {
    const { getByTitle, getByText, user } = renderWithAppEvents(
      <ThemePreferenceProvider>
        <Dashboard />
      </ThemePreferenceProvider>,
    );

    await waitFor(() => {
      expect(getByTitle("App Settings")).toBeTruthy();
    });

    await user.click(getByTitle("App Settings"));

    await waitFor(() => {
      expect(getByText("App Settings")).toBeTruthy();
    });
  });
});

// ─── Create workspace modal ─────────────────────────────────────────────────

describe("create workspace modal", () => {
  test("opens create workspace modal when 'New Workspace' is clicked", async () => {
    const { getByRole, user } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByRole("button", { name: "New Workspace" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "New Workspace" }));

    await waitFor(() => {
      expect(getByRole("heading", { name: "Create Workspace" })).toBeTruthy();
    });
  });
});

// ─── Empty workspaces section ───────────────────────────────────────────────

describe("empty workspaces section", () => {
  test("shows empty workspaces that have no tasks", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Empty Project" });

    api.get("/api/tasks", () => []);
    api.get("/api/workspaces", () => [workspace]);

    const { getByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("Empty Workspaces")).toBeTruthy();
    });
    expect(getByText("Empty Project")).toBeTruthy();
  });
});

// ─── Error display ──────────────────────────────────────────────────────────

describe("error display", () => {
  test("displays error message when tasks fail to load", async () => {
    // Override the default tasks handler to return an error
    api.get("/api/tasks", () => {
      throw { status: 500, body: { error: "server_error" } };
    });

    const { getByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      // The useTasks hook sets an error string on failed fetch
      expect(getByText(/Failed to fetch tasks/)).toBeTruthy();
    });
  });
});

// ─── Multiple status groups ─────────────────────────────────────────────────

describe("multiple status groups in same workspace", () => {
  test("renders all status groups for a workspace with mixed tasks", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Full Project" });
    const draft = createTaskWithStatus("draft", {
      config: { id: "d1", name: "Draft 1", workspaceId: "ws-1" },
    });
    const running = createTaskWithStatus("running", {
      config: { id: "r1", name: "Running 1", workspaceId: "ws-1" },
    });
    const completed = createTaskWithStatus("completed", {
      config: { id: "c1", name: "Completed 1", workspaceId: "ws-1" },
    });

    api.get("/api/tasks", () => [draft, running, completed]);
    api.get("/api/workspaces", () => [workspace]);

    const { getByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("Full Project")).toBeTruthy();
    });
    expect(getByText("Drafts (1)")).toBeTruthy();
    expect(getByText("Active (1)")).toBeTruthy();
    expect(getByText("Completed (1)")).toBeTruthy();
    expect(getByText("Draft 1")).toBeTruthy();
    expect(getByText("Running 1")).toBeTruthy();
    expect(getByText("Completed 1")).toBeTruthy();
  });

  test("renders multiple tasks count in section headers", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Busy Project" });
    const r1 = createTaskWithStatus("running", {
      config: { id: "r1", name: "Run 1", workspaceId: "ws-1" },
    });
    const r2 = createTaskWithStatus("running", {
      config: { id: "r2", name: "Run 2", workspaceId: "ws-1" },
    });
    const r3 = createTaskWithStatus("running", {
      config: { id: "r3", name: "Run 3", workspaceId: "ws-1" },
    });

    api.get("/api/tasks", () => [r1, r2, r3]);
    api.get("/api/workspaces", () => [workspace]);

    const { getByText } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("Active (3)")).toBeTruthy();
    });
    expect(getByText("(3 tasks)")).toBeTruthy();
  });
});

// ─── Edit draft flow ────────────────────────────────────────────────────────
// Edit button was removed from dashboard cards. Drafts are edited by clicking
// the card itself, which triggers onEditDraft via TaskGrid.

describe("edit draft flow", () => {
  test("keeps Cancel before draft actions in the edit draft modal", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Project", directory: "/workspaces/project" });
    const draftTask = createTaskWithStatus("draft", {
      config: {
        id: "draft-1",
        name: "Draft Task",
        workspaceId: "ws-1",
        directory: "/workspaces/project",
        prompt: "Build a feature",
      },
    });

    api.get("/api/tasks", () => [draftTask]);
    api.get("/api/workspaces", () => [workspace]);

    const { getByRole, getByText, user } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("Draft Task")).toBeTruthy();
    });

    await user.click(getByText("Draft Task"));

    await waitFor(() => {
      expect(getByText("Edit Draft Task")).toBeTruthy();
      expect(getByRole("button", { name: "Cancel" })).toBeTruthy();
      expect(getByRole("button", { name: "Delete" })).toBeTruthy();
      expect(getByRole("button", { name: "Update" })).toBeTruthy();
    });

    const cancelButton = getByRole("button", { name: "Cancel" });
    const deleteDraftButton = getByRole("button", { name: "Delete" });
    const updateDraftButton = getByRole("button", { name: "Update" });

    expect(cancelButton.compareDocumentPosition(deleteDraftButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    expect(deleteDraftButton.compareDocumentPosition(updateDraftButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
  });
});

// ─── Workspace settings modal ───────────────────────────────────────────────

describe("workspace settings modal", () => {
  test("opens workspace settings when gear icon is clicked", async () => {
    const workspace = createWorkspace({ id: "ws-1", name: "Settings Project" });
    const task = createTaskWithStatus("running", {
      config: { id: "l1", name: "Task", workspaceId: "ws-1" },
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/workspaces", () => [workspace]);
    api.get("/api/workspaces/:id", () => workspace);
    api.get("/api/workspaces/:id/status", () => ({ connected: true }));

    const { getByText, user } = renderWithAppEvents(<Dashboard />);

    await waitFor(() => {
      expect(getByText("Settings Project")).toBeTruthy();
    });

    // Click the workspace gear icon (next to workspace name)
    const gearBtns = document.querySelectorAll('button[title="Workspace Settings"]');
    expect(gearBtns.length).toBeGreaterThan(0);

    await user.click(gearBtns[0] as HTMLElement);

    await waitFor(() => {
      expect(getByText("Workspace Settings")).toBeTruthy();
    });
  });
});
