/**
 * E2E Scenario: Create Loop Workflow
 *
 * Tests the shell-native loop creation flow.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";
import {
  createLoop,
  createLoopWithStatus,
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

function setupApi(loops: ReturnType<typeof createLoop>[] = []) {
  api.get("/api/loops", () => loops);
  api.get("/api/workspaces", () => [WORKSPACE]);
  api.get("/api/config", () => ({ remoteOnly: false, basicAuthEnabled: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
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
  api.get("/api/loops/:id/diff", () => []);
  api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
  api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
  api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
  api.get("/api/loops/:id/port-forwards", () => []);
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

describe("create loop scenario", () => {
  test("full create loop flow: fill form and return to the workspace", async () => {
    const createdLoop = createLoopWithStatus("running", {
      config: {
        id: "new-loop-1",
        name: "My New Loop",
        directory: "/workspaces/my-project",
        prompt: "X",
        workspaceId: "ws-1",
      },
    });

    setupApi();
    api.post("/api/loops", () => createdLoop);
    api.put("/api/preferences/last-model", () => ({ success: true }));
    api.put("/api/preferences/last-directory", () => ({ success: true }));

    const { getByLabelText, user } = renderWithUser(<App />, { route: "#/new/loop" });

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

  test("create flow auto-generates a missing title before creating the loop and returns to the workspace", async () => {
    const createdLoop = createLoopWithStatus("running", {
      config: {
        id: "new-loop-generated-title",
        name: "Generated Loop Title",
        directory: "/workspaces/my-project",
        prompt: "X",
        workspaceId: "ws-1",
      },
    });

    setupApi();
    api.post("/api/loops/title", () => ({ title: "Generated Loop Title" }));
    api.post("/api/loops", (req) => {
      expect((req.body as { name: string }).name).toBe("Generated Loop Title");
      return createdLoop;
    });
    api.put("/api/preferences/last-model", () => ({ success: true }));
    api.put("/api/preferences/last-directory", () => ({ success: true }));

    const { getByLabelText, user } = renderWithUser(<App />, { route: "#/new/loop" });

    await selectWorkspace(user);
    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");

    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Create"),
    );
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn!);

    await waitFor(() => {
      expect(api.calls("/api/loops/title", "POST").length).toBe(1);
      expect(api.calls("/api/loops", "POST").length).toBe(1);
      expect(window.location.hash).toBe("#/workspace/ws-1");
    });
  });

  test("returns to the workspace immediately and does not auto-open the created loop later", async () => {
    const createdLoop = createLoopWithStatus("running", {
      config: {
        id: "new-loop-late",
        name: "My New Loop",
        directory: "/workspaces/my-project",
        prompt: "X",
        workspaceId: "ws-1",
      },
    });
    const createRequest = createDeferred<typeof createdLoop>();

    setupApi();
    api.post("/api/loops", async () => await createRequest.promise);
    api.put("/api/preferences/last-model", () => ({ success: true }));
    api.put("/api/preferences/last-directory", () => ({ success: true }));

    const { getByLabelText, user } = renderWithUser(<App />, { route: "#/new/loop" });

    await selectWorkspace(user);

    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");
    await user.type(getByLabelText(/Title/) as HTMLInputElement, "X");

    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Create"),
    );
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn!);

    await waitFor(() => {
      expect(api.calls("/api/loops", "POST").length).toBe(1);
      expect(window.location.hash).toBe("#/workspace/ws-1");
    });

    const loopGetCountBeforeResolve = api.calls("/api/loops", "GET").length;

    createRequest.resolve(createdLoop);

    await waitFor(() => {
      expect(api.calls("/api/loops", "GET").length).toBeGreaterThan(loopGetCountBeforeResolve);
      expect(window.location.hash).toBe("#/workspace/ws-1");
    });
  });

  test("title spark button fills the title from the prompt", async () => {
    setupApi();
    api.post("/api/loops/title", () => ({ title: "Generated Loop Title" }));

    const { getByRole, getByLabelText, user } = renderWithUser(<App />, { route: "#/new/loop" });

    await selectWorkspace(user);
    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");
    await user.click(getByRole("button", { name: "Generate title with AI" }));

    await waitFor(() => {
      expect((getByLabelText(/Title/) as HTMLInputElement).value).toBe("Generated Loop Title");
    });
  });

  test("title spark button shows an error toast when generation fails", async () => {
    setupApi();
    api.post("/api/loops/title", () => ({ message: "Title generation failed" }), 500);

    const { getByText, getByRole, getByLabelText, user } = renderWithUser(<App />, { route: "#/new/loop" });

    await selectWorkspace(user);
    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");
    await user.click(getByRole("button", { name: "Generate title with AI" }));

    await waitFor(() => {
      expect(getByText("Title generation failed")).toBeTruthy();
    });
  });

  test("create flow stops and shows an error when automatic title generation fails", async () => {
    setupApi();
    api.post("/api/loops/title", () => ({ message: "Title generation failed" }), 500);

    const { getByText, getByLabelText, user } = renderWithUser(<App />, { route: "#/new/loop" });

    await selectWorkspace(user);
    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");

    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Create"),
    );
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn!);

    await waitFor(() => {
      expect(getByText("Title generation failed")).toBeTruthy();
      expect(api.calls("/api/loops/title", "POST").length).toBe(1);
      expect(api.calls("/api/loops", "POST").length).toBe(0);
      expect(window.location.hash).toBe("#/new/loop");
    });
  });

  test("create loop with 409 uncommitted changes shows shell error feedback", async () => {
    setupApi();
    api.post(
      "/api/loops",
      () => ({
        error: "uncommitted_changes",
        message: "Directory has uncommitted changes. Please commit or stash your changes before creating a loop.",
        changedFiles: ["src/index.ts", "src/app.ts"],
      }),
      409,
    );

    const { getByLabelText, user } = renderWithUser(<App />, { route: "#/new/loop" });

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

  test("cancel create loop returns to the overview", async () => {
    setupApi();
    const { getByRole, user } = renderWithUser(<App />, { route: "#/new/loop" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Start a new loop" })).toBeTruthy();
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
