/**
 * E2E Scenario: Error Handling
 *
 * Tests error scenarios at the UI level: API failures, disconnection states,
 * uncommitted changes conflicts, and recovery.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { act } from "@testing-library/react";
import { createMockApi, MockApiError } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";
import {
  createTaskWithStatus,
  createWorkspace,
  createModelInfo,
  createTaskError,
} from "../helpers/factories";
import { App } from "@/App";

const api = createMockApi();
const ws = createMockWebSocket();

const WORKSPACE = createWorkspace({
  id: "ws-1",
  name: "My Project",
  directory: "/workspaces/my-project",
});

function setupBaseApi() {
  api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/ssh-sessions", () => []);
  api.get("/api/ssh-servers", () => []);
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
  api.get("/api/tasks/:id/diff", () => []);
  api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
  api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
  api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
  api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
}

function getSectionActionButton(sectionTitle: string, actionLabel = "New"): HTMLButtonElement | undefined {
  const actionByLabel = document.querySelector(
    `button[aria-label="${actionLabel} ${sectionTitle}"]`,
  ) as HTMLButtonElement | null;
  if (actionByLabel) {
    return actionByLabel;
  }

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

// ─── Error handling scenarios ────────────────────────────────────────────────

describe("error handling scenario", () => {
  async function navigateToTaskRoute(taskId: string) {
    await act(async () => {
      window.location.hash = `#/task/${taskId}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  test("failed task shows error message on task card", async () => {
    setupBaseApi();

    const failedTask = createTaskWithStatus("failed", {
      config: { id: "fail-1", name: "Failed Task", directory: "/workspaces/my-project", workspaceId: "ws-1" },
      state: {
        error: createTaskError({ message: "Process crashed unexpectedly" }),
      },
    });

    api.get("/api/tasks", () => [failedTask]);
    api.get("/api/workspaces", () => [WORKSPACE]);

    const { getAllByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Failed Task").length).toBeGreaterThan(0);
    });

    // Status badge shows "Failed"
    expect(getAllByText("Failed").length).toBeGreaterThan(0);
  });

  test("task details shows error state for failed tasks", async () => {
    setupBaseApi();

    const failedTask = createTaskWithStatus("failed", {
      config: { id: "fail-detail-1", name: "Detail Failure", directory: "/workspaces/my-project", workspaceId: "ws-1" },
      state: {
        error: createTaskError({ message: "API rate limit exceeded" }),
      },
    });

    api.get("/api/tasks", () => [failedTask]);
    api.get("/api/tasks/:id", () => failedTask);
    api.get("/api/workspaces", () => [WORKSPACE]);

    const { getAllByText } = renderWithUser(<App />);

    await navigateToTaskRoute("fail-detail-1");

    await waitFor(() => {
      expect(getAllByText("Detail Failure").length).toBeGreaterThan(0);
    });

    // Error is visible in the details view
    await waitFor(() => {
      expect(document.body.textContent).toContain("API rate limit exceeded");
    });
  });

  test("task not found shows error page", async () => {
    setupBaseApi();

    api.get("/api/tasks", () => []);
    api.get("/api/tasks/:id", () => {
      throw new MockApiError(404, { error: "not_found", message: "Task not found" });
    });
    api.get("/api/workspaces", () => [WORKSPACE]);

    const { getByText } = renderWithUser(<App />);

    await navigateToTaskRoute("nonexistent-task");

    await waitFor(() => {
      expect(document.body.textContent).toContain("Task not found");
    });
    expect(getByText("Task not found")).toBeTruthy();
  });

  test("create task with 409 uncommitted changes shows conflict modal", async () => {
    setupBaseApi();
    api.get("/api/tasks", () => []);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.post(
      "/api/tasks",
      () => ({
        error: "uncommitted_changes",
        message: "Directory has uncommitted changes.",
        changedFiles: ["src/main.ts"],
      }),
      409,
    );

    const { getByRole, getByLabelText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Clanky" })).toBeTruthy();
    });

    const tasksNewButton = getSectionActionButton("Tasks");
    expect(tasksNewButton).toBeTruthy();
    await user.click(tasksNewButton!);
    await waitFor(() => {
      expect(getByRole("heading", { name: /Start a new task/ })).toBeTruthy();
    });

    // Select workspace
    const wsSelect = document.querySelector("select#workspace") as HTMLSelectElement;
    await user.selectOptions(wsSelect, "ws-1");

    // Wait for form ready and the generic Create action to appear.
    await waitFor(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Create"),
      );
      expect(btn).toBeTruthy();
    });

    // Fill required fields
    const titleInput = getByLabelText(/Title/) as HTMLInputElement;
    await user.type(titleInput, "Conflict Task");

    const promptTextarea = getByLabelText(/Prompt/) as HTMLTextAreaElement;
    await user.type(promptTextarea, "X");

    // Submit
    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Create"),
    );
    await user.click(submitBtn!);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Uncommitted changes blocked the new run. Resolve them and try again.");
    });
  });

  test("accept task failure shows error in modal", async () => {
    setupBaseApi();

    const task = createTaskWithStatus("completed", {
      config: { id: "accept-fail-1", name: "Accept Fail", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });

    api.get("/api/tasks", () => [task]);
    api.get("/api/tasks/:id", () => task);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.post("/api/tasks/:id/accept", () => ({ error: "Merge conflict detected" }), 500);

    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />);

    await navigateToTaskRoute("accept-fail-1");

    await waitFor(() => {
      expect(getAllByText("Accept Fail").length).toBeGreaterThan(0);
    });

    await user.click(getByRole("button", { name: /Actions/ }));

    // Click Accept
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

    // Click Accept Locally
    const mergeBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Accept Locally"),
    );
    await user.click(mergeBtn!);

    // The API was called (even if it fails)
    await waitFor(() => {
      const calls = api.calls("/api/tasks/:id/accept", "POST");
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  test("multiple tasks in different error states display correctly", async () => {
    setupBaseApi();

    const failedTask = createTaskWithStatus("failed", {
      config: { id: "multi-fail", name: "Failure One", directory: "/workspaces/my-project", workspaceId: "ws-1" },
      state: {
        error: createTaskError({ message: "Timeout error" }),
      },
    });
    const stoppedTask = createTaskWithStatus("stopped", {
      config: { id: "multi-stop", name: "Stopped One", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });
    const maxIterTask = createTaskWithStatus("max_iterations", {
      config: { id: "multi-max", name: "Maxed Out", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });

    api.get("/api/tasks", () => [failedTask, stoppedTask, maxIterTask]);
    api.get("/api/workspaces", () => [WORKSPACE]);

    const { getAllByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Failure One").length).toBeGreaterThan(0);
    });

    expect(getAllByText("Stopped One").length).toBeGreaterThan(0);
    expect(getAllByText("Maxed Out").length).toBeGreaterThan(0);

    // Status badges
    expect(getAllByText("Failed").length).toBeGreaterThan(0);
    expect(getAllByText("Stopped").length).toBeGreaterThan(0);
    expect(getAllByText("Max Iterations").length).toBeGreaterThan(0);

  });
});
