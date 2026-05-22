/**
 * E2E Scenario: Draft Workflow
 *
 * Tests the shell-native draft workflow: listing draft tasks in the sidebar, opening the inline editor,
 * updating, starting, deleting, and creating a draft.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";
import {
  createTaskWithStatus,
  createWorkspace,
  createModelInfo,
} from "../helpers/factories";
import { App } from "@/App";

const api = createMockApi();
const ws = createMockWebSocket();

const WORKSPACE = createWorkspace({
  id: "ws-1",
  name: "My Project",
  directory: "/workspaces/my-project",
});

function connectedModel() {
  return createModelInfo({
    providerID: "anthropic",
    modelID: "claude-sonnet-4-20250514",
    modelName: "Claude Sonnet 4",
    providerName: "Anthropic",
    connected: true,
  });
}

function draftTask(id = "draft-1", name = "My Draft", planMode = false) {
  return createTaskWithStatus("draft", {
    config: {
      id,
      name,
      directory: "/workspaces/my-project",
      workspaceId: "ws-1",
      prompt: "Build a feature",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514", variant: "" },
      useWorktree: true,
      planMode,
    },
  });
}

function setupBaseApi() {
  api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/preferences/last-model", () => null);
  api.get("/api/preferences/log-level", () => ({ level: "info" }));
  api.get("/api/preferences/last-directory", () => null);
  api.get("/api/models", () => [connectedModel()]);
  api.get("/api/ssh-sessions", () => []);
  api.get("/api/ssh-servers", () => []);
  api.get("/api/git/branches", () => ({
    branches: [{ name: "main", isCurrent: true, isDefault: true }],
    currentBranch: "main",
  }));
  api.get("/api/git/default-branch", () => ({ defaultBranch: "main" }));
  api.get("/api/check-planning-dir", () => ({ warning: null }));
  api.get("/api/tasks/:id/port-forwards", () => []);
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

describe("draft workflow scenario", () => {
  test("clicking a draft opens the inline draft editor", async () => {
    setupBaseApi();
    api.get("/api/tasks", () => [draftTask()]);
    api.get("/api/workspaces", () => [WORKSPACE]);

    const { getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      const draftButtons = Array.from(document.querySelectorAll("button")).filter((button) => button.textContent?.includes("My Draft"));
      expect(draftButtons.length).toBeGreaterThan(0);
    });

    const draftButtons = Array.from(document.querySelectorAll("button")).filter((button) => button.textContent?.includes("My Draft"));
    await user.click(draftButtons[0]!);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Edit My Draft" })).toBeTruthy();
    });
  });

  test("starting a draft task exits the draft editor immediately", async () => {
    setupBaseApi();
    const draft = draftTask();
    api.get("/api/tasks", () => [draft]);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.put("/api/tasks/:id", () => draft);
    api.post("/api/tasks/:id/draft/start", () => ({ success: true }));

    const { getByRole, user } = renderWithUser(<App />, { route: "#/task/draft-1" });

    await waitFor(() => {
      expect(getByRole("button", { name: "Start" })).toBeTruthy();
    });
    const workspaceSelect = document.querySelector("select#workspace") as HTMLSelectElement;
    expect(workspaceSelect).toBeTruthy();
    await user.selectOptions(workspaceSelect, "");
    await user.selectOptions(workspaceSelect, "ws-1");
    await waitFor(() => {
      const modelOption = document.querySelector('select#model option[value="anthropic:claude-sonnet-4-20250514:"]');
      expect(modelOption).toBeTruthy();
    });
    const modelSelect = document.querySelector("select#model") as HTMLSelectElement;
    expect(modelSelect).toBeTruthy();
    await user.selectOptions(modelSelect, "anthropic:claude-sonnet-4-20250514:");
    await waitFor(() => {
      expect((getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false);
    });

    await user.click(getByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/workspace/ws-1");
    });

    await waitFor(() => {
      const calls = api.calls("/api/tasks/:id/draft/start", "POST");
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  test("inline draft editor can delete an existing draft", async () => {
    setupBaseApi();
    api.get("/api/tasks", () => [draftTask()]);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.post("/api/tasks/:id/purge", () => ({ success: true }));

    const { getByRole, getByText, user } = renderWithUser(<App />, { route: "#/task/draft-1" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Edit My Draft" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(getByText('Are you sure you want to delete "My Draft"?')).toBeTruthy();
    });

    const dialog = getByRole("dialog");
    const confirmButton = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete Draft",
    );
    expect(confirmButton).toBeTruthy();
    await user.click(confirmButton!);

    await waitFor(() => {
      const calls = api.calls("/api/tasks/:id/purge", "POST");
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  test("save as draft from the shell create task form", async () => {
    setupBaseApi();
    let tasks = [] as ReturnType<typeof draftTask>[];
    api.get("/api/tasks", () => tasks);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.post("/api/tasks", () => {
      const task = draftTask("new-draft", "New Draft");
      tasks = [task];
      return task;
    });
    api.put("/api/preferences/last-model", () => ({ success: true }));
    api.put("/api/preferences/last-directory", () => ({ success: true }));

    const { getByRole, getByLabelText, user } = renderWithUser(<App />, { route: "#/new/task" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Start a new task" })).toBeTruthy();
    });

    await waitFor(() => {
      const option = document.querySelector('select#workspace option[value="ws-1"]');
      expect(option).toBeTruthy();
    });
    const wsSelect = document.querySelector("select#workspace") as HTMLSelectElement;
    await user.selectOptions(wsSelect, "ws-1");

    await waitFor(() => {
      expect(getByRole("button", { name: "Save as Draft" })).toBeTruthy();
    });

    await user.type(getByLabelText(/Title/) as HTMLInputElement, "New Draft");
    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");
    await user.click(getByRole("button", { name: "Save as Draft" }));

    await waitFor(() => {
      const calls = api.calls("/api/tasks", "POST");
      expect(calls.length).toBeGreaterThan(0);
      const body = calls[0]!.body as Record<string, unknown>;
      expect(body["draft"]).toBe(true);
      expect(body["name"]).toBe("New Draft");
      expect(window.location.hash).toBe("#/task/new-draft");
      expect(getByRole("heading", { name: "Edit New Draft" })).toBeTruthy();
    });
  });
});
