/**
 * E2E Scenario: Create Task Workflow
 *
 * Tests the shell-native task creation flow.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function setupApi(tasks: ReturnType<typeof createTask>[] = []) {
  api.get("/api/tasks", () => tasks);
  api.get("/api/workspaces", () => [WORKSPACE]);
  api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/ssh-sessions", () => []);
  api.get("/api/ssh-servers", () => []);
  api.get("/api/preferences/last-model", () => null);
  api.get("/api/preferences/log-level", () => ({ level: "info" }));
  api.get("/api/preferences/last-directory", () => null);
  api.get("/api/models", () => [connectedModel()]);
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
  api.get("/api/tasks/:id/port-forwards", () => []);
  api.get("/api/preferences/markdown-rendering", () => ({ enabled: false }));
}

async function selectWorkspace(user: ReturnType<typeof renderWithUser>["user"]) {
  await waitFor(() => {
    const option = document.querySelector('select#workspace option[value="ws-1"]');
    expect(option).toBeTruthy();
  });
  const wsSelect = document.querySelector("select#workspace") as HTMLSelectElement;
  await user.selectOptions(wsSelect, "ws-1");
  await waitFor(() => {
    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Create"),
    );
    expect(submitBtn).toBeTruthy();
  });
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

describe("create task scenario", () => {
  test("full create task flow: fill form and return to the workspace", async () => {
    const createdTask = createTaskWithStatus("running", {
      config: {
        id: "new-task-1",
        name: "My New Task",
        directory: "/workspaces/my-project",
        prompt: "X",
        workspaceId: "ws-1",
      },
    });

    setupApi();
    api.post("/api/tasks", () => createdTask);
    api.put("/api/preferences/last-model", () => ({ success: true }));
    api.put("/api/preferences/last-directory", () => ({ success: true }));

    const { getByLabelText, user } = renderWithUser(<App />, { route: "#/new/task" });

    await selectWorkspace(user);

    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");
    await user.type(getByLabelText(/Title/) as HTMLInputElement, "X");

    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Create"),
    );
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn!);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/workspace/ws-1");
    });
  });

  test("create flow auto-generates a missing title before creating the task and returns to the workspace", async () => {
    const createdTask = createTaskWithStatus("running", {
      config: {
        id: "new-task-generated-title",
        name: "Generated Task Title",
        directory: "/workspaces/my-project",
        prompt: "X",
        workspaceId: "ws-1",
      },
    });

    setupApi();
    api.post("/api/tasks/title", () => ({ title: "Generated Task Title" }));
    api.post("/api/tasks", (req) => {
      expect((req.body as { name: string }).name).toBe("Generated Task Title");
      return createdTask;
    });
    api.put("/api/preferences/last-model", () => ({ success: true }));
    api.put("/api/preferences/last-directory", () => ({ success: true }));

    const { getByLabelText, user } = renderWithUser(<App />, { route: "#/new/task" });

    await selectWorkspace(user);
    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");

    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Create"),
    );
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn!);

    await waitFor(() => {
      expect(api.calls("/api/tasks/title", "POST").length).toBe(1);
      expect(api.calls("/api/tasks", "POST").length).toBe(1);
      expect(window.location.hash).toBe("#/workspace/ws-1");
    });
  });

  test("returns to the workspace immediately and does not auto-open the created task later", async () => {
    const createdTask = createTaskWithStatus("running", {
      config: {
        id: "new-task-late",
        name: "My New Task",
        directory: "/workspaces/my-project",
        prompt: "X",
        workspaceId: "ws-1",
      },
    });
    const createRequest = createDeferred<typeof createdTask>();

    setupApi();
    api.post("/api/tasks", async () => await createRequest.promise);
    api.put("/api/preferences/last-model", () => ({ success: true }));
    api.put("/api/preferences/last-directory", () => ({ success: true }));

    const { getByLabelText, user } = renderWithUser(<App />, { route: "#/new/task" });

    await selectWorkspace(user);

    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");
    await user.type(getByLabelText(/Title/) as HTMLInputElement, "X");

    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Create"),
    );
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn!);

    await waitFor(() => {
      expect(api.calls("/api/tasks", "POST").length).toBe(1);
      expect(window.location.hash).toBe("#/workspace/ws-1");
    });

    const taskGetCountBeforeResolve = api.calls("/api/tasks", "GET").length;

    createRequest.resolve(createdTask);

    await waitFor(() => {
      expect(api.calls("/api/tasks", "GET").length).toBeGreaterThan(taskGetCountBeforeResolve);
      expect(window.location.hash).toBe("#/workspace/ws-1");
    });
  });

  test("title spark button fills the title from the prompt", async () => {
    setupApi();
    api.post("/api/tasks/title", () => ({ title: "Generated Task Title" }));

    const { getByRole, getByLabelText, user } = renderWithUser(<App />, { route: "#/new/task" });

    await selectWorkspace(user);
    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");
    await user.click(getByRole("button", { name: "Generate title with AI" }));

    await waitFor(() => {
      expect((getByLabelText(/Title/) as HTMLInputElement).value).toBe("Generated Task Title");
    });
  });

  test("title spark button shows an error toast when generation fails", async () => {
    setupApi();
    api.post("/api/tasks/title", () => ({ message: "Title generation failed" }), 500);

    const { getByText, getByRole, getByLabelText, user } = renderWithUser(<App />, { route: "#/new/task" });

    await selectWorkspace(user);
    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");
    await user.click(getByRole("button", { name: "Generate title with AI" }));

    await waitFor(() => {
      expect(getByText("Title generation failed")).toBeTruthy();
    });
  });

  test("create flow stops and shows an error when automatic title generation fails", async () => {
    setupApi();
    api.post("/api/tasks/title", () => ({ message: "Title generation failed" }), 500);

    const { getByText, getByLabelText, user } = renderWithUser(<App />, { route: "#/new/task" });

    await selectWorkspace(user);
    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");

    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Create"),
    );
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn!);

    await waitFor(() => {
      expect(getByText("Title generation failed")).toBeTruthy();
      expect(api.calls("/api/tasks/title", "POST").length).toBe(1);
      expect(api.calls("/api/tasks", "POST").length).toBe(0);
      expect(window.location.hash).toBe("#/new/task");
    });
  });

  test("create task with 409 uncommitted changes shows shell error feedback", async () => {
    setupApi();
    api.post(
      "/api/tasks",
      () => ({
        error: "uncommitted_changes",
        message: "Directory has uncommitted changes. Please commit or stash your changes before creating a task.",
        changedFiles: ["src/index.ts", "src/app.ts"],
      }),
      409,
    );

    const { getByLabelText, user } = renderWithUser(<App />, { route: "#/new/task" });

    await selectWorkspace(user);
    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");
    await user.type(getByLabelText(/Title/) as HTMLInputElement, "X");

    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Create"),
    );
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn!);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/workspace/ws-1");
      expect(document.body.textContent).toContain("Uncommitted changes blocked the new run. Resolve them and try again.");
    });
  });

  test("cancel create task returns to the overview", async () => {
    setupApi();
    const { getByRole, user } = renderWithUser(<App />, { route: "#/new/task" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Start a new task" })).toBeTruthy();
    });

    const cancelButtons = document.querySelectorAll("button");
    const cancelButton = Array.from(cancelButtons).find((button) => button.textContent?.trim() === "Cancel");
    expect(cancelButton).toBeTruthy();
    await user.click(cancelButton!);

    await waitFor(() => {
      expect(window.location.hash).toBe("#/");
    });
  });
});
