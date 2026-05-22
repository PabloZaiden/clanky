/**
 * E2E Scenario: Plan Mode Workflow
 *
 * Tests the full plan mode flow: create task with plan mode -> planning status ->
 * plan content appears -> user sends feedback -> plan updated -> user accepts plan ->
 * task starts running. Also tests: discard plan.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";
import {
  createTaskWithStatus,
  createWorkspace,
  createModelInfo,
  createSshSession,
} from "../helpers/factories";
import { App } from "@/App";

const api = createMockApi();
const ws = createMockWebSocket();

const TASK_ID = "plan-task-1";

const WORKSPACE = createWorkspace({
  id: "ws-1",
  name: "My Project",
  directory: "/workspaces/my-project",
});

function planningTask(isPlanReady: boolean, feedbackRounds = 0) {
  return createTaskWithStatus("planning", {
    config: { id: TASK_ID, name: "Plan Task", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    state: {
      planMode: {
        active: true,
        feedbackRounds,
        planningFolderCleared: false,
        isPlanReady,
      },
    },
  });
}

function setupApi(task: ReturnType<typeof createTaskWithStatus>, planContent = "") {
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
  api.get("/api/tasks/:id/plan", () => ({
    exists: planContent.length > 0,
    content: planContent,
  }));
  api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
  api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
  api.get("/api/tasks/:id/port-forwards", () => []);
  api.get("/api/preferences/markdown-rendering", () => ({ enabled: false }));
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

// ─── Plan mode scenarios ─────────────────────────────────────────────────────

describe("plan mode scenario", () => {
  test("planning task shows unified tab UI with plan tab active", async () => {
    const task = planningTask(false);
    setupApi(task);

    window.location.hash = `/task/${TASK_ID}`;
    const { getAllByText, getByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Plan Task").length).toBeGreaterThan(0);
    });

    // Unified tab UI should show all tabs including Plan
    await waitFor(() => {
      expect(getByText("Plan")).toBeTruthy();
      expect(getByText("Log")).toBeTruthy();
      expect(getByText("Prompt")).toBeTruthy();
      expect(getByText("Actions")).toBeTruthy();
    });
  });

  test("plan content appears when plan is ready", async () => {
    const task = planningTask(true);
    setupApi(task, "## Step 1\nDo something\n\n## Step 2\nDo more");

    window.location.hash = `/task/${TASK_ID}`;
    const { getAllByText, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Plan Task").length).toBeGreaterThan(0);
    });

    // Plan content should be visible (rendered as raw text since markdown rendering is disabled)
    await waitFor(() => {
      expect(getByText(/Step 1/)).toBeTruthy();
    });

    // Switch to Actions tab to find the Accept Plan button
    const actionsTab = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Actions",
    );
    expect(actionsTab).toBeTruthy();
    await user.click(actionsTab!);

    // Accept button should be enabled when isPlanReady is true
    await waitFor(() => {
      const acceptBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Accept Plan"),
      );
      expect(acceptBtn).toBeTruthy();
      expect(acceptBtn!.disabled).toBe(false);
    });
  });

  test("accept plan disabled while AI is still writing", async () => {
    const task = planningTask(false);
    setupApi(task, "## Partial plan");

    window.location.hash = `/task/${TASK_ID}`;
    const { getAllByText, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Plan Task").length).toBeGreaterThan(0);
    });

    // Wait for plan content to appear
    await waitFor(() => {
      expect(getByText(/Partial plan/)).toBeTruthy();
    });

    // Switch to Actions tab to find the Accept Plan button
    const actionsTab = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Actions",
    );
    expect(actionsTab).toBeTruthy();
    await user.click(actionsTab!);

    // Accept button should be disabled when isPlanReady is false
    await waitFor(() => {
      const acceptBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Accept Plan"),
      );
      expect(acceptBtn).toBeTruthy();
      expect(acceptBtn!.disabled).toBe(true);
    });
  });

  test("send feedback on plan", async () => {
    let currentTask = planningTask(true, 0);
    setupApi(currentTask, "## Initial Plan\nDo X and Y");

    api.get("/api/tasks/:id", () => currentTask);
    api.post("/api/tasks/:id/plan/feedback", () => {
      currentTask = planningTask(false, 1);
      return { success: true };
    });

    window.location.hash = `/task/${TASK_ID}`;
    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Plan Task").length).toBeGreaterThan(0);
    });

    // Wait for plan content to load
    await waitFor(() => {
      expect(getByText(/Initial Plan/)).toBeTruthy();
    });

    const feedbackInput = getByRole("textbox", { name: "Plan feedback" }) as HTMLTextAreaElement;
    expect(feedbackInput.placeholder).toBe("");
    await user.type(feedbackInput, "X");

    await user.click(getByRole("button", { name: "Send Feedback" }));

    // API should have been called
    await waitFor(() => {
      const calls = api.calls("/api/tasks/:id/plan/feedback", "POST");
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  test("accept plan triggers API and transitions task", async () => {
    const task = planningTask(true);
    setupApi(task, "## Final Plan\nAll steps defined");

    api.post("/api/tasks/:id/plan/accept", () => ({ success: true, mode: "start_task" }), 200);

    window.location.hash = `/task/${TASK_ID}`;
    const { getAllByText, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Plan Task").length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(getByText(/Final Plan/)).toBeTruthy();
    });

    // Switch to Actions tab to find the Accept Plan button
    const actionsTab = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Actions",
    );
    expect(actionsTab).toBeTruthy();
    await user.click(actionsTab!);

    // Click Accept Plan & Start Task
    await waitFor(() => {
      const acceptBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Accept Plan"),
      );
      expect(acceptBtn).toBeTruthy();
    });
    const acceptBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Accept Plan"),
    );
    await user.click(acceptBtn!);

    // API should have been called
    await waitFor(() => {
      const calls = api.calls("/api/tasks/:id/plan/accept", "POST");
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  test("accept plan and open ssh navigates straight to the ssh route", async () => {
    const task = planningTask(true);
    setupApi(task, "## Final Plan\nAll steps defined");
    const sshSession = createSshSession({ config: { id: "ssh-plan-1", taskId: TASK_ID } });

    api.post("/api/tasks/:id/plan/accept", (req) => {
      expect(req.body).toEqual({ mode: "open_ssh" });
      return { success: true, mode: "open_ssh", sshSession };
    }, 200);
    api.get("/api/ssh-sessions/:id", () => sshSession);
    api.get("/api/ssh-sessions/:id/output", () => ({ output: "", seq: 0 }));

    window.location.hash = `/task/${TASK_ID}`;
    const { getAllByText, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Plan Task").length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(getByText(/Final Plan/)).toBeTruthy();
    });

    const actionsTab = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Actions",
    );
    expect(actionsTab).toBeTruthy();
    await user.click(actionsTab!);

    await waitFor(() => {
      expect(getByText("Accept Plan & Open SSH")).toBeTruthy();
    });
    await user.click(getByText("Accept Plan & Open SSH"));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/ssh/ssh-plan-1");
    });
  });

  test("discard plan shows confirmation and deletes task", async () => {
    const task = planningTask(true);
    setupApi(task, "## Plan to discard");

    api.post("/api/tasks/:id/plan/discard", () => ({ success: true }));

    window.location.hash = `/task/${TASK_ID}`;
    const { getAllByText, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Plan Task").length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(getByText(/Plan to discard/)).toBeTruthy();
    });

    // Switch to Actions tab to find the Discard Plan button
    const actionsTab = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Actions",
    );
    expect(actionsTab).toBeTruthy();
    await user.click(actionsTab!);

    // Click Discard Plan
    await waitFor(() => {
      const discardBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Discard Plan"),
      );
      expect(discardBtn).toBeTruthy();
    });
    const discardBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Discard Plan"),
    );
    await user.click(discardBtn!);

    // Confirmation modal should appear
    await waitFor(() => {
      expect(getByText("Discard Plan?")).toBeTruthy();
    });

    // Confirm discard
    const confirmBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Discard",
    );
    expect(confirmBtn).toBeTruthy();
    await user.click(confirmBtn!);

    // API should have been called
    await waitFor(() => {
      const calls = api.calls("/api/tasks/:id/plan/discard", "POST");
      expect(calls.length).toBeGreaterThan(0);
    });
  });

});
