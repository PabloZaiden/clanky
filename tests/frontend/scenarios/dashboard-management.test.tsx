/**
 * E2E Scenario: Shell overview management
 *
 * Tests shell-level workflows: overview empty states, sidebar/detail navigation,
 * settings navigation, and workspace mapping in the shell-first UI.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor, within } from "../helpers/render";
import {
  createTaskWithStatus,
  createSshSession,
  createWorkspace,
  createModelInfo,
} from "../helpers/factories";
import { App } from "@/App";
import type { Chat } from "@/types";

const api = createMockApi();
const ws = createMockWebSocket();

const WORKSPACE_A = createWorkspace({
  id: "ws-a",
  name: "Project Alpha",
  directory: "/workspaces/alpha",
});

const WORKSPACE_B = createWorkspace({
  id: "ws-b",
  name: "Project Beta",
  directory: "/workspaces/beta",
});

function createChat(overrides?: {
  config?: Partial<Chat["config"]>;
  state?: Partial<Chat["state"]>;
}): Chat {
  return {
    config: {
      id: overrides?.config?.id ?? "chat-1",
      name: overrides?.config?.name ?? "Workspace Chat",
      workspaceId: overrides?.config?.workspaceId ?? "ws-a",
      directory: overrides?.config?.directory ?? "/workspaces/alpha",
      model: {
        providerID: "github",
        modelID: "gpt-5.4",
        variant: "",
      },
      useWorktree: true,
      baseBranch: "main",
      createdAt: "2026-04-16T10:00:00.000Z",
      updatedAt: "2026-04-16T10:00:00.000Z",
      mode: "chat",
      ...overrides?.config,
      scope: overrides?.config?.scope ?? "workspace",
      taskId: overrides?.config?.taskId,
    },
    state: {
      id: overrides?.state?.id ?? overrides?.config?.id ?? "chat-1",
      status: overrides?.state?.status ?? "idle",
      messages: [],
      logs: [],
      toolCalls: [],
      ...overrides?.state,
    },
  };
}

function setupBaseApi() {
  api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/ssh-sessions", () => []);
  api.get("/api/ssh-sessions/:id", (req) => createSshSession({ config: { id: req.params["id"]! } }));
  api.get("/api/ssh-servers", () => []);
  api.get("/api/chats", () => []);
  api.get("/api/chats/:id", (req) => createChat({ config: { id: req.params["id"]! } }));
  api.get("/api/preferences/last-model", () => null);
  api.get("/api/preferences/log-level", () => ({ level: "info" }));
  api.get("/api/preferences/last-directory", () => null);
  api.get("/api/models", () => [createModelInfo({ connected: true })]);
  api.get("/api/git/branches", () => ({
    branches: [{ name: "main", isCurrent: true, isDefault: true }],
    currentBranch: "main",
  }));
  api.get("/api/git/default-branch", () => ({ defaultBranch: "main" }));
  api.get("/api/check-planning-dir", () => ({ warning: null }));
  // TaskDetails endpoints (for navigation tests)
  api.get("/api/tasks/:id/diff", () => []);
  api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
  api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
  api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
  api.get("/api/tasks/:id/port-forwards", () => []);
  api.get("/api/tasks/:id/pull-request", () => ({
    enabled: false,
    destinationType: "disabled",
    disabledReason: "disabled",
  }));
  api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
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

// ─── Dashboard management scenarios ──────────────────────────────────────────

describe("dashboard management scenario", () => {
  test("overview shows active work, server maps, and the workspaces map", async () => {
    setupBaseApi();

    const runningTask = createTaskWithStatus("running", {
      config: { id: "task-run-1", name: "Running Task", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });
    const completedTask = createTaskWithStatus("completed", {
      config: { id: "task-comp-1", name: "Done Task", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });
    const pushedTask = createTaskWithStatus("pushed", {
      config: { id: "task-pushed-1", name: "Pushed Task", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });
    const draftTask = createTaskWithStatus("draft", {
      config: { id: "task-draft-1", name: "Draft Task", directory: "/workspaces/beta", workspaceId: "ws-b" },
    });

    api.get("/api/tasks", () => [runningTask, completedTask, pushedTask, draftTask]);
    api.get("/api/workspaces", () => [WORKSPACE_A, WORKSPACE_B]);

    const { getAllByText, getByRole, getByTestId, getByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Project Alpha").length).toBeGreaterThan(0);
    });

    expect(getAllByText("Project Beta").length).toBeGreaterThan(0);
    expect(getByRole("heading", { name: "Server maps" })).toBeTruthy();
    expect(getByText("Workspaces map")).toBeTruthy();

    const activeWorkHeading = getByRole("heading", { name: "Active Work" });
    const serverMapsHeading = getByRole("heading", { name: "Server maps" });
    const workspacesMapHeading = getByRole("heading", { name: "Workspaces map" });
    const activeWorkCard = getByTestId("active-work-card");

    expect(within(activeWorkCard).getByText("Running Task")).toBeTruthy();
    expect(within(activeWorkCard).getByText("Done Task")).toBeTruthy();
    expect(within(activeWorkCard).getByText("Pushed Task")).toBeTruthy();
    expect(within(activeWorkCard).getByText("Draft Task")).toBeTruthy();

    expect(activeWorkHeading.compareDocumentPosition(serverMapsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(serverMapsHeading.compareDocumentPosition(workspacesMapHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("clicking a task card navigates to task details", async () => {
    setupBaseApi();

    const task = createTaskWithStatus("running", {
      config: { id: "nav-task-1", name: "Nav Target", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/tasks/:id", () => task);
    api.get("/api/workspaces", () => [WORKSPACE_A]);

    const { getAllByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Nav Target").length).toBeGreaterThan(0);
    });

    await user.click(getAllByText("Nav Target")[0]!);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/task/nav-task-1");
    });
    expect(getAllByText("Nav Target").length).toBeGreaterThan(0);
  });

  test("navigating to task details and back preserves the overview", async () => {
    setupBaseApi();

    const task = createTaskWithStatus("completed", {
      config: { id: "round-trip-1", name: "Round Trip", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/tasks/:id", () => task);
    api.get("/api/workspaces", () => [WORKSPACE_A]);

    const { getAllByText, getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Round Trip").length).toBeGreaterThan(0);
    });

    await user.click(getAllByText("Round Trip")[0]!);
    await waitFor(() => {
      expect(window.location.hash).toBe("#/task/round-trip-1");
    });

    await user.click(getByRole("button", { name: /clanky/i }));

    await waitFor(() => {
      expect(getByRole("button", { name: /clanky/i })).toBeTruthy();
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
      expect(getByRole("heading", { name: "Active Work" })).toBeTruthy();
      expect(getByRole("heading", { name: "Server maps" })).toBeTruthy();
    });
  });

  test("settings button opens the shell settings view", async () => {
    setupBaseApi();
    api.get("/api/tasks", () => []);
    api.get("/api/workspaces", () => []);

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

  test("addressable review tasks remain reachable from the shell", async () => {
    setupBaseApi();

    const pushedTask = createTaskWithStatus("pushed", {
      config: { id: "pushed-1", name: "Pushed Task", directory: "/workspaces/alpha", workspaceId: "ws-a" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 1,
        },
      },
    });

    api.get("/api/tasks", () => [pushedTask]);
    api.get("/api/workspaces", () => [WORKSPACE_A]);

    const { getAllByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Pushed Task").length).toBeGreaterThan(0);
    });
  });

  test("active work keeps sidebar-active tasks visible while omitting history tasks", async () => {
    setupBaseApi();

    const runningTask = createTaskWithStatus("running", {
      config: { id: "task-run-visible", name: "Visible Running", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });
    const planningTask = createTaskWithStatus("planning", {
      config: { id: "task-plan-visible", name: "Visible Planning", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });
    const completedTask = createTaskWithStatus("completed", {
      config: { id: "task-completed-visible", name: "Visible Completed", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });
    const failedTask = createTaskWithStatus("failed", {
      config: { id: "task-failed-hidden", name: "Hidden Failed", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });
    const pushedTask = createTaskWithStatus("pushed", {
      config: { id: "task-pushed-visible", name: "Visible Pushed", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });
    const mergedTask = createTaskWithStatus("merged", {
      config: { id: "task-merged-hidden", name: "Hidden Merged", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });

    api.get("/api/tasks", () => [runningTask, planningTask, completedTask, failedTask, pushedTask, mergedTask]);
    api.get("/api/workspaces", () => [WORKSPACE_A]);

    const { getByRole, getByTestId } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Active Work" })).toBeTruthy();
    });

    const activeWorkCard = getByTestId("active-work-card");

    await waitFor(() => {
      expect(within(activeWorkCard).getByText("Visible Running")).toBeTruthy();
      expect(within(activeWorkCard).getByText("Visible Planning")).toBeTruthy();
      expect(within(activeWorkCard).getByText("Visible Completed")).toBeTruthy();
      expect(within(activeWorkCard).getByText("Visible Pushed")).toBeTruthy();
    });

    expect(within(activeWorkCard).queryByText("Hidden Failed")).toBeNull();
    expect(within(activeWorkCard).queryByText("Hidden Merged")).toBeNull();
  });

  test("active work mirrors sidebar item categories and ordering", async () => {
    setupBaseApi();

    const task = createTaskWithStatus("running", {
      config: { id: "task-active-work", name: "Task Work", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });
    const chat = createChat({ config: { id: "chat-active-work", name: "Chat Work", workspaceId: "ws-a" } });
    const session = createSshSession({
      config: { id: "ssh-active-work", name: "Terminal Work", workspaceId: "ws-a", directory: "/workspaces/alpha" },
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/chats", () => [chat]);
    api.get("/api/ssh-sessions", () => [session]);
    api.get("/api/workspaces", () => [WORKSPACE_A]);

    const { getByTestId } = renderWithUser(<App />);

    const activeWorkCard = await waitFor(() => getByTestId("active-work-card"));

    await waitFor(() => {
      expect(within(activeWorkCard).getByRole("button", { name: /Task Work/ })).toBeTruthy();
      expect(within(activeWorkCard).getByRole("button", { name: /Chat Work/ })).toBeTruthy();
      expect(within(activeWorkCard).getByRole("button", { name: /Terminal Work/ })).toBeTruthy();
    });

    const labels = within(activeWorkCard)
      .getAllByRole("button")
      .map((button) => button.textContent ?? "");

    expect(labels[0]).toContain("Task Work");
    expect(labels[1]).toContain("Chat Work");
    expect(labels[2]).toContain("Terminal Work");
  });

  test("active work excludes chats pinned to the quick chat workspace", async () => {
    setupBaseApi();

    const task = createTaskWithStatus("running", {
      config: { id: "task-quick-chat-filter", name: "Task Work", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });
    const quickChat = createChat({
      config: { id: "chat-quick-chat-filter", name: "Quick Chat Work", workspaceId: "ws-a" },
    });
    const session = createSshSession({
      config: { id: "ssh-quick-chat-filter", name: "Terminal Work", workspaceId: "ws-a", directory: "/workspaces/alpha" },
    });

    api.get("/api/preferences/quick-chat", () => ({
      workspaceId: "ws-a",
      model: {
        providerID: "github",
        modelID: "gpt-5.4",
        variant: "",
      },
    }));
    api.get("/api/tasks", () => [task]);
    api.get("/api/chats", () => [quickChat]);
    api.get("/api/ssh-sessions", () => [session]);
    api.get("/api/workspaces", () => [WORKSPACE_A]);

    const { getByTestId } = renderWithUser(<App />);

    const activeWorkCard = await waitFor(() => getByTestId("active-work-card"));

    await waitFor(() => {
      expect(within(activeWorkCard).getByRole("button", { name: /Task Work/ })).toBeTruthy();
      expect(within(activeWorkCard).getByRole("button", { name: /Terminal Work/ })).toBeTruthy();
    });

    expect(within(activeWorkCard).queryByRole("button", { name: /Quick Chat Work/ })).toBeNull();
  });

  test("overview omits removed shell summary cards", async () => {
    setupBaseApi();
    api.get("/api/tasks", () => [
      createTaskWithStatus("running", {
        config: { id: "summary-task", name: "Summary Task", directory: "/workspaces/alpha", workspaceId: "ws-a" },
      }),
    ]);
    api.get("/api/workspaces", () => [WORKSPACE_A, WORKSPACE_B]);

    const { getByRole, getByText, queryByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Active Work" })).toBeTruthy();
      expect(getByText("Server maps")).toBeTruthy();
      expect(getByText("Workspaces map")).toBeTruthy();
    });

    expect(queryByText("Tracked repositories and hosts.")).toBeNull();
    expect(queryByText("Task-oriented Clanky tasks.")).toBeNull();
    expect(queryByText("Interactive conversations.")).toBeNull();
  });

  // Note: "connection status indicator shows connected state" test was removed because
  // the "Connected" text indicator was removed from the Dashboard in PR #118.
  // WebSocket connection status is no longer displayed as a text label.

  test("workspace map includes workspaces with no tasks", async () => {
    setupBaseApi();

    const taskInA = createTaskWithStatus("running", {
      config: { id: "in-a", name: "In Alpha", directory: "/workspaces/alpha", workspaceId: "ws-a" },
    });

    api.get("/api/tasks", () => [taskInA]);
    api.get("/api/workspaces", () => [WORKSPACE_A, WORKSPACE_B]);

    const { getAllByText, getByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByText("Workspaces map")).toBeTruthy();
    });
    expect(getAllByText("Project Beta").length).toBeGreaterThan(0);
    expect(getByText("0 tasks")).toBeTruthy();
  });
});
