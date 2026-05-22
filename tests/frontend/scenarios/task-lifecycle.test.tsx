/**
 * E2E Scenario: Task Lifecycle
 *
 * Tests the full lifecycle of a task: running -> completed -> accept/push/discard.
 * Renders the App component and simulates user navigation and actions.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { act } from "@testing-library/react";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";
import {
  createTask,
  createTaskWithStatus,
  createWorkspace,
  createModelInfo,
} from "../helpers/factories";
import { App } from "@/App";

const api = createMockApi();
const ws = createMockWebSocket();

const TASK_ID = "lifecycle-task-1";

const WORKSPACE = createWorkspace({
  id: "ws-1",
  name: "My Project",
  directory: "/workspaces/my-project",
});

function setupApi(task: ReturnType<typeof createTask>) {
  api.get("/api/tasks", () => [task]);
  api.get("/api/tasks/:id", () => task);
  api.get("/api/workspaces", () => [WORKSPACE]);
  api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/ssh-sessions", () => []);
  api.get("/api/ssh-servers", () => []);
  api.get("/api/preferences/last-model", () => null);
  api.get("/api/preferences/log-level", () => ({ level: "info" }));
  api.get("/api/preferences/last-directory", () => null);
  api.get("/api/models", () => [createModelInfo({ connected: true })]);
  api.get("/api/tasks/:id/diff", () => []);
  api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
  api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
  api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
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

// ─── Task lifecycle scenarios ────────────────────────────────────────────────

describe("task lifecycle scenario", () => {
  async function navigateToTaskRoute() {
    await act(async () => {
      window.location.hash = `#/task/${TASK_ID}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  test("running task appears on dashboard and user navigates to details", async () => {
    const task = createTaskWithStatus("running", {
      config: { id: TASK_ID, name: "Feature Task", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });
    setupApi(task);

    const { getAllByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Feature Task").length).toBeGreaterThan(0);
    });
    expect(getAllByText("Running").length).toBeGreaterThan(0);

    await user.click(getAllByText("Feature Task")[0]!);

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/task/${TASK_ID}`);
    });
    expect(getAllByText("Feature Task").length).toBeGreaterThan(0);
  });

  test("accept task flow: click accept, confirm local accept, task status updates", async () => {
    const task = createTaskWithStatus("completed", {
      config: { id: TASK_ID, name: "Accept Task", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });
    setupApi(task);
    api.post("/api/tasks/:id/accept", () => ({
      success: true,
    }));

    const { getAllByText, getByText, getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Accept Task").length).toBeGreaterThan(0);
    });

    await navigateToTaskRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/task/${TASK_ID}`);
    });

    await user.click(getByRole("button", { name: /Actions/ }));

    // Click Accept button
    await waitFor(() => {
      const acceptBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Accept") && b.textContent?.includes("locally or push"),
      );
      expect(acceptBtn).toBeTruthy();
    });

    const acceptBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Accept") && b.textContent?.includes("locally or push"),
    );
    await user.click(acceptBtn!);

    // AcceptTaskModal opens with "Finalize Task" title
    await waitFor(() => {
      expect(getByText("Finalize Task")).toBeTruthy();
    });

    // Click "Accept Locally" in the modal
    const mergeBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Accept Locally"),
    );
    expect(mergeBtn).toBeTruthy();
    await user.click(mergeBtn!);

    // After merge, the API was called
    await waitFor(() => {
      const acceptCalls = api.calls("/api/tasks/:id/accept", "POST");
      expect(acceptCalls.length).toBeGreaterThan(0);
    });
  });

  test("delete task flow: click delete, confirm, navigates back to dashboard", async () => {
    const task = createTaskWithStatus("running", {
      config: { id: TASK_ID, name: "Delete Me Task", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });
    let tasks = [task];
    api.get("/api/tasks", () => tasks);
    api.get("/api/tasks/:id", () => task);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
    api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
    api.get("/api/ssh-sessions", () => []);
    api.get("/api/ssh-servers", () => []);
    api.get("/api/preferences/last-model", () => null);
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.get("/api/preferences/last-directory", () => null);
    api.get("/api/models", () => [createModelInfo({ connected: true })]);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.delete("/api/tasks/:id", () => ({ success: true }));
    api.get("/api/tasks", () => tasks);

    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Delete Me Task").length).toBeGreaterThan(0);
    });

    await navigateToTaskRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/task/${TASK_ID}`);
    });

    await user.click(getByRole("button", { name: /Actions/ }));

    // Click Delete Task button (text: "Delete Task" + "Cancel and delete this task")
    await waitFor(() => {
      const deleteBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Delete Task") && b.textContent?.includes("Cancel and delete"),
      );
      expect(deleteBtn).toBeTruthy();
    });

    const deleteBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete Task") && b.textContent?.includes("Cancel and delete"),
    );
    await user.click(deleteBtn!);

    // Delete confirmation modal should appear
    await waitFor(() => {
      expect(getByText(/Are you sure/i)).toBeTruthy();
    });

    // Confirm delete
    const confirmBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Delete" || b.textContent?.trim() === "Delete Task",
    );
    expect(confirmBtn).toBeTruthy();
    tasks = [];
    await user.click(confirmBtn!);

    await waitFor(() => {
      expect(getByRole("button", { name: /clanky/i })).toBeTruthy();
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
    });
  });

  test("push task flow: click accept, push to remote", async () => {
    const task = createTaskWithStatus("completed", {
      config: { id: TASK_ID, name: "Push Task", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });
    setupApi(task);
    api.post("/api/tasks/:id/push", () => ({
      success: true,
      remoteBranch: "push-task-a1b2c3d",
    }));

    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Push Task").length).toBeGreaterThan(0);
    });

    await navigateToTaskRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/task/${TASK_ID}`);
    });

    await user.click(getByRole("button", { name: /Actions/ }));

    // Click Accept button to open AcceptTaskModal
    await waitFor(() => {
      const acceptBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Accept") && b.textContent?.includes("locally or push"),
      );
      expect(acceptBtn).toBeTruthy();
    });

    const acceptBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Accept") && b.textContent?.includes("locally or push"),
    );
    await user.click(acceptBtn!);

    // AcceptTaskModal opens
    await waitFor(() => {
      expect(getByText("Finalize Task")).toBeTruthy();
    });

    // Click "Push to Remote" in the modal
    const pushBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Push to Remote"),
    );
    expect(pushBtn).toBeTruthy();
    await user.click(pushBtn!);

    // After push, the API was called
    await waitFor(() => {
      const pushCalls = api.calls("/api/tasks/:id/push", "POST");
      expect(pushCalls.length).toBeGreaterThan(0);
    });
  });

  test("shell navigation from task details returns to overview", async () => {
    const task = createTaskWithStatus("running", {
      config: { id: TASK_ID, name: "Nav Task", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });
    setupApi(task);

    const { getAllByText, getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Nav Task").length).toBeGreaterThan(0);
    });

    await navigateToTaskRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/task/${TASK_ID}`);
    });

    await user.click(getByRole("button", { name: /clanky/i }));

    await waitFor(() => {
      expect(getByRole("button", { name: /clanky/i })).toBeTruthy();
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
    });
  });
});
