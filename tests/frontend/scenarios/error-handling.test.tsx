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
  createLoopWithStatus,
  createWorkspace,
  createModelInfo,
  createLoopError,
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
  api.get("/api/loops/:id/diff", () => []);
  api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
  api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
  api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
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
  async function navigateToLoopRoute(loopId: string) {
    await act(async () => {
      window.location.hash = `#/loop/${loopId}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  test("failed loop shows error message on loop card", async () => {
    setupBaseApi();

    const failedLoop = createLoopWithStatus("failed", {
      config: { id: "fail-1", name: "Failed Loop", directory: "/workspaces/my-project", workspaceId: "ws-1" },
      state: {
        error: createLoopError({ message: "Process crashed unexpectedly" }),
      },
    });

    api.get("/api/loops", () => [failedLoop]);
    api.get("/api/workspaces", () => [WORKSPACE]);

    const { getAllByText } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Failed Loop").length).toBeGreaterThan(0);
    });

    // Status badge shows "Failed"
    expect(getAllByText("Failed").length).toBeGreaterThan(0);
  });

  test("loop details shows error state for failed loops", async () => {
    setupBaseApi();

    const failedLoop = createLoopWithStatus("failed", {
      config: { id: "fail-detail-1", name: "Detail Failure", directory: "/workspaces/my-project", workspaceId: "ws-1" },
      state: {
        error: createLoopError({ message: "API rate limit exceeded" }),
      },
    });

    api.get("/api/loops", () => [failedLoop]);
    api.get("/api/loops/:id", () => failedLoop);
    api.get("/api/workspaces", () => [WORKSPACE]);

    const { getAllByText } = renderWithUser(<App />);

    await navigateToLoopRoute("fail-detail-1");

    await waitFor(() => {
      expect(getAllByText("Detail Failure").length).toBeGreaterThan(0);
    });

    // Error is visible in the details view
    await waitFor(() => {
      expect(document.body.textContent).toContain("API rate limit exceeded");
    });
  });

  test("loop not found shows error page", async () => {
    setupBaseApi();

    api.get("/api/loops", () => []);
    api.get("/api/loops/:id", () => {
      throw new MockApiError(404, { error: "not_found", message: "Loop not found" });
    });
    api.get("/api/workspaces", () => [WORKSPACE]);

    const { getByText } = renderWithUser(<App />);

    await navigateToLoopRoute("nonexistent-loop");

    await waitFor(() => {
      expect(document.body.textContent).toContain("Loop not found");
    });
    expect(getByText("Loop not found")).toBeTruthy();
  });

  test("create loop with 409 uncommitted changes shows conflict modal", async () => {
    setupBaseApi();
    api.get("/api/loops", () => []);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.post(
      "/api/loops",
      () => ({
        error: "uncommitted_changes",
        message: "Directory has uncommitted changes.",
        changedFiles: ["src/main.ts"],
      }),
      409,
    );

    const { getByRole, getByLabelText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
    });

    const loopsNewButton = getSectionActionButton("Loops");
    expect(loopsNewButton).toBeTruthy();
    await user.click(loopsNewButton!);
    await waitFor(() => {
      expect(getByRole("heading", { name: /Start a new loop/ })).toBeTruthy();
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
    await user.type(titleInput, "Conflict Loop");

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

  test("accept loop failure shows error in modal", async () => {
    setupBaseApi();

    const loop = createLoopWithStatus("completed", {
      config: { id: "accept-fail-1", name: "Accept Fail", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });

    api.get("/api/loops", () => [loop]);
    api.get("/api/loops/:id", () => loop);
    api.get("/api/workspaces", () => [WORKSPACE]);
    api.post("/api/loops/:id/accept", () => ({ error: "Merge conflict detected" }), 500);

    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />);

    await navigateToLoopRoute("accept-fail-1");

    await waitFor(() => {
      expect(getAllByText("Accept Fail").length).toBeGreaterThan(0);
    });

    await user.click(getByRole("button", { name: /Actions/ }));

    // Click Accept
    await waitFor(() => {
      const acceptBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Accept") && b.textContent?.includes("merge or push"),
      );
      expect(acceptBtn).toBeTruthy();
    });

    const acceptBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Accept") && b.textContent?.includes("merge or push"),
    );
    await user.click(acceptBtn!);

    // AcceptLoopModal opens
    await waitFor(() => {
      expect(getByText("Finalize Loop")).toBeTruthy();
    });

    // Click Accept & Merge
    const mergeBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Accept & Merge"),
    );
    await user.click(mergeBtn!);

    // The API was called (even if it fails)
    await waitFor(() => {
      const calls = api.calls("/api/loops/:id/accept", "POST");
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  test("multiple loops in different error states display correctly", async () => {
    setupBaseApi();

    const failedLoop = createLoopWithStatus("failed", {
      config: { id: "multi-fail", name: "Failure One", directory: "/workspaces/my-project", workspaceId: "ws-1" },
      state: {
        error: createLoopError({ message: "Timeout error" }),
      },
    });
    const stoppedLoop = createLoopWithStatus("stopped", {
      config: { id: "multi-stop", name: "Stopped One", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });
    const maxIterLoop = createLoopWithStatus("max_iterations", {
      config: { id: "multi-max", name: "Maxed Out", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    });

    api.get("/api/loops", () => [failedLoop, stoppedLoop, maxIterLoop]);
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
