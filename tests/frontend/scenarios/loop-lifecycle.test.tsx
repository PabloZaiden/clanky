/**
 * E2E Scenario: Loop Lifecycle
 *
 * Tests the full lifecycle of a loop: running -> completed -> accept/push/discard.
 * Renders the App component and simulates user navigation and actions.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { act } from "@testing-library/react";
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

const LOOP_ID = "lifecycle-loop-1";

const WORKSPACE = createWorkspace({
  id: "ws-1",
  name: "My Project",
  directory: "/workspaces/my-project",
});

function setupApi(loop: ReturnType<typeof createLoop>) {
  api.get("/api/loops", () => [loop]);
  api.get("/api/loops/:id", () => loop);
  api.get("/api/workspaces", () => [WORKSPACE]);
  api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/ssh-sessions", () => []);
  api.get("/api/ssh-servers", () => []);
  api.get("/api/preferences/last-model", () => null);
  api.get("/api/preferences/log-level", () => ({ level: "info" }));
  api.get("/api/preferences/last-directory", () => null);
  api.get("/api/models", () => [createModelInfo({ connected: true })]);
  api.get("/api/loops/:id/diff", () => []);
  api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
  api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
  api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
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

// ─── Loop lifecycle scenarios ────────────────────────────────────────────────

describe("loop lifecycle scenario", () => {
  async function navigateToLoopRoute() {
    await act(async () => {
      window.location.hash = `#/loop/${LOOP_ID}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  test("running loop appears on dashboard and user navigates to details", async () => {
    const loop = createLoopWithStatus("running", {
      config: { id: LOOP_ID, name: "Feature Loop", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });
    setupApi(loop);

    const { getAllByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Feature Loop").length).toBeGreaterThan(0);
    });
    expect(getAllByText("Running").length).toBeGreaterThan(0);

    await user.click(getAllByText("Feature Loop")[0]!);

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/loop/${LOOP_ID}`);
    });
    expect(getAllByText("Feature Loop").length).toBeGreaterThan(0);
  });

  test("accept loop flow: click accept, confirm local accept, loop status updates", async () => {
    const loop = createLoopWithStatus("completed", {
      config: { id: LOOP_ID, name: "Accept Loop", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });
    setupApi(loop);
    api.post("/api/loops/:id/accept", () => ({
      success: true,
    }));

    const { getAllByText, getByText, getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Accept Loop").length).toBeGreaterThan(0);
    });

    await navigateToLoopRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/loop/${LOOP_ID}`);
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

    // AcceptLoopModal opens with "Finalize Loop" title
    await waitFor(() => {
      expect(getByText("Finalize Loop")).toBeTruthy();
    });

    // Click "Accept Locally" in the modal
    const mergeBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Accept Locally"),
    );
    expect(mergeBtn).toBeTruthy();
    await user.click(mergeBtn!);

    // After merge, the API was called
    await waitFor(() => {
      const acceptCalls = api.calls("/api/loops/:id/accept", "POST");
      expect(acceptCalls.length).toBeGreaterThan(0);
    });
  });

  test("delete loop flow: click delete, confirm, navigates back to dashboard", async () => {
    const loop = createLoopWithStatus("running", {
      config: { id: LOOP_ID, name: "Delete Me Loop", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });
    let loops = [loop];
    api.get("/api/loops", () => loops);
    api.get("/api/loops/:id", () => loop);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
    api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
    api.get("/api/ssh-sessions", () => []);
    api.get("/api/ssh-servers", () => []);
    api.get("/api/preferences/last-model", () => null);
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.get("/api/preferences/last-directory", () => null);
    api.get("/api/models", () => [createModelInfo({ connected: true })]);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.delete("/api/loops/:id", () => ({ success: true }));
    api.get("/api/loops", () => loops);

    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Delete Me Loop").length).toBeGreaterThan(0);
    });

    await navigateToLoopRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/loop/${LOOP_ID}`);
    });

    await user.click(getByRole("button", { name: /Actions/ }));

    // Click Delete Loop button (text: "Delete Loop" + "Cancel and delete this loop")
    await waitFor(() => {
      const deleteBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Delete Loop") && b.textContent?.includes("Cancel and delete"),
      );
      expect(deleteBtn).toBeTruthy();
    });

    const deleteBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete Loop") && b.textContent?.includes("Cancel and delete"),
    );
    await user.click(deleteBtn!);

    // Delete confirmation modal should appear
    await waitFor(() => {
      expect(getByText(/Are you sure/i)).toBeTruthy();
    });

    // Confirm delete
    const confirmBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Delete" || b.textContent?.trim() === "Delete Loop",
    );
    expect(confirmBtn).toBeTruthy();
    loops = [];
    await user.click(confirmBtn!);

    await waitFor(() => {
      expect(getByRole("button", { name: /ralpher/i })).toBeTruthy();
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
    });
  });

  test("push loop flow: click accept, push to remote", async () => {
    const loop = createLoopWithStatus("completed", {
      config: { id: LOOP_ID, name: "Push Loop", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });
    setupApi(loop);
    api.post("/api/loops/:id/push", () => ({
      success: true,
      remoteBranch: "push-loop-a1b2c3d",
    }));

    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Push Loop").length).toBeGreaterThan(0);
    });

    await navigateToLoopRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/loop/${LOOP_ID}`);
    });

    await user.click(getByRole("button", { name: /Actions/ }));

    // Click Accept button to open AcceptLoopModal
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

    // AcceptLoopModal opens
    await waitFor(() => {
      expect(getByText("Finalize Loop")).toBeTruthy();
    });

    // Click "Push to Remote" in the modal
    const pushBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Push to Remote"),
    );
    expect(pushBtn).toBeTruthy();
    await user.click(pushBtn!);

    // After push, the API was called
    await waitFor(() => {
      const pushCalls = api.calls("/api/loops/:id/push", "POST");
      expect(pushCalls.length).toBeGreaterThan(0);
    });
  });

  test("shell navigation from loop details returns to overview", async () => {
    const loop = createLoopWithStatus("running", {
      config: { id: LOOP_ID, name: "Nav Loop", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });
    setupApi(loop);

    const { getAllByText, getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Nav Loop").length).toBeGreaterThan(0);
    });

    await navigateToLoopRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/loop/${LOOP_ID}`);
    });

    await user.click(getByRole("button", { name: /ralpher/i }));

    await waitFor(() => {
      expect(getByRole("button", { name: /ralpher/i })).toBeTruthy();
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
    });
  });
});
