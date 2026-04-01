/**
 * E2E Scenario: Draft Workflow
 *
 * Tests the shell-native draft workflow: listing draft loops in the sidebar, opening the inline editor,
 * updating, starting, deleting, and creating a draft.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor, within } from "../helpers/render";
import {
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

function draftLoop(id = "draft-1", name = "My Draft", planMode = false) {
  return createLoopWithStatus("draft", {
    config: {
      id,
      name,
      directory: "/workspaces/my-project",
      workspaceId: "ws-1",
      prompt: "Build a feature",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
      useWorktree: true,
      planMode,
    },
  });
}

function setupBaseApi() {
  api.get("/api/config", () => ({ remoteOnly: false }));
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
  api.get("/api/loops/:id/port-forwards", () => []);
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
  test("draft loop appears in Loops section with Draft badge", async () => {
    setupBaseApi();
    api.get("/api/loops", () => [draftLoop()]);
    api.get("/api/workspaces", () => [WORKSPACE]);

    const { getByRole, getAllByText, queryByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Collapse Loops section" })).toBeTruthy();
      expect(getAllByText("My Draft").length).toBeGreaterThan(0);
    });

    expect(queryByText("Drafts")).toBeNull();
    expect(getAllByText("Draft").length).toBeGreaterThan(0);
  });

  test("clicking a draft opens the inline draft editor", async () => {
    setupBaseApi();
    api.get("/api/loops", () => [draftLoop()]);
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

  test("inline draft editor orders draft actions from cancel to start", async () => {
    setupBaseApi();
    api.get("/api/loops", () => [draftLoop()]);
    api.get("/api/workspaces", () => [WORKSPACE]);

    const { getByRole } = renderWithUser(<App />, { route: "#/loop/draft-1" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Edit My Draft" })).toBeTruthy();
    });

    const cancelButton = getByRole("button", { name: "Cancel" });
    const deleteDraftButton = getByRole("button", { name: "Delete" });
    const updateDraftButton = getByRole("button", { name: "Update" });
    const startLoopButton = getByRole("button", { name: "Start" });

    expect(cancelButton.compareDocumentPosition(deleteDraftButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    expect(deleteDraftButton.compareDocumentPosition(updateDraftButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    expect(updateDraftButton.compareDocumentPosition(startLoopButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
  });

  test("inline draft editor header hides workspace and draft metadata", async () => {
    setupBaseApi();
    api.get("/api/loops", () => [draftLoop("draft-1", "My Draft", true)]);
    api.get("/api/workspaces", () => [WORKSPACE]);

    const { getByRole } = renderWithUser(<App />, { route: "#/loop/draft-1" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Edit My Draft" })).toBeTruthy();
      expect(getByRole("button", { name: "Start" })).toBeTruthy();
    });

    const headerTitleGroup = getByRole("heading", { name: "Edit My Draft" }).parentElement as HTMLElement;
    expect(headerTitleGroup).toBeTruthy();
    expect(within(headerTitleGroup).queryByText(/^My Project$/)).toBeNull();
    expect(within(headerTitleGroup).queryByText(/^Draft$/)).toBeNull();
    expect(within(headerTitleGroup).queryByText(/^Plan mode$/)).toBeNull();
  });

  test("starting a draft loop calls the draft/start API", async () => {
    setupBaseApi();
    const draft = draftLoop();
    api.get("/api/loops", () => [draft]);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.put("/api/loops/:id", () => draft);
    api.post("/api/loops/:id/draft/start", () => ({ success: true }));

    const { getByRole, user } = renderWithUser(<App />, { route: "#/loop/draft-1" });

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
      const calls = api.calls("/api/loops/:id/draft/start", "POST");
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  test("inline draft editor can delete an existing draft", async () => {
    setupBaseApi();
    api.get("/api/loops", () => [draftLoop()]);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.post("/api/loops/:id/purge", () => ({ success: true }));

    const { getByRole, getByText, user } = renderWithUser(<App />, { route: "#/loop/draft-1" });

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
      const calls = api.calls("/api/loops/:id/purge", "POST");
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  test("save as draft from the shell create loop form", async () => {
    setupBaseApi();
    api.get("/api/loops", () => []);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.post("/api/loops", () => draftLoop("new-draft", "New Draft"));
    api.put("/api/preferences/last-model", () => ({ success: true }));
    api.put("/api/preferences/last-directory", () => ({ success: true }));

    const { getByRole, getByLabelText, user } = renderWithUser(<App />, { route: "#/new/loop" });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Start a new loop" })).toBeTruthy();
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
      const calls = api.calls("/api/loops", "POST");
      expect(calls.length).toBeGreaterThan(0);
      const body = calls[0]!.body as Record<string, unknown>;
      expect(body["draft"]).toBe(true);
      expect(body["name"]).toBe("New Draft");
    });
  });
});
