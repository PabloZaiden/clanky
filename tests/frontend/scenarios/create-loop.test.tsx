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

function setupApi(loops: ReturnType<typeof createLoop>[] = []) {
  api.get("/api/loops", () => loops);
  api.get("/api/workspaces", () => [WORKSPACE]);
  api.get("/api/config", () => ({ remoteOnly: false }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
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
  test("shell create view is accessible and shows the form", async () => {
    setupApi();
    const { getByRole } = renderWithUser(<App />, { route: "#/new/loop" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Start a new loop" })).toBeTruthy();
    });

    expect(document.querySelector("select#workspace")).toBeTruthy();
  });

  test("shell create view orders actions as cancel, save draft, create", async () => {
    setupApi();
    const { getByRole } = renderWithUser(<App />, { route: "#/new/loop" });

    await waitFor(() => {
      expect(getByRole("button", { name: "Cancel" })).toBeTruthy();
      expect(getByRole("button", { name: "Save as Draft" })).toBeTruthy();
      expect(getByRole("button", { name: "Create" })).toBeTruthy();
    });

    const cancelButton = getByRole("button", { name: "Cancel" });
    const saveDraftButton = getByRole("button", { name: "Save as Draft" });
    const createButton = getByRole("button", { name: "Create" });

    expect(cancelButton.compareDocumentPosition(saveDraftButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    expect(saveDraftButton.compareDocumentPosition(createButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
  });

  test("full create loop flow: fill form and submit", async () => {
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
      expect(window.location.hash).toBe("#/loop/new-loop-1");
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

    const { getByRole, getByLabelText, user } = renderWithUser(<App />, { route: "#/new/loop" });

    await selectWorkspace(user);
    await user.type(getByLabelText(/Prompt/) as HTMLTextAreaElement, "X");
    await user.click(getByRole("button", { name: "Generate title with AI" }));

    await waitFor(() => {
      expect(
        document.body.textContent?.includes("Title generation failed") ||
          document.body.textContent?.includes("Failed to generate loop title"),
      ).toBe(true);
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
