/**
 * E2E Scenario: Review Comments Workflow
 *
 * Tests the review cycle: task pushed -> address comments -> new cycle starts.
 * Covers the AddressCommentsModal flow from both Dashboard and TaskDetails.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { act } from "@testing-library/react";
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

const TASK_ID = "review-task-1";

const WORKSPACE = createWorkspace({
  id: "ws-1",
  name: "My Project",
  directory: "/workspaces/my-project",
});

function pushedAddressableTask(reviewCycles = 0) {
  return createTaskWithStatus("pushed", {
    config: { id: TASK_ID, name: "Pushed Task", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    state: {
      reviewMode: {
        addressable: true,
        completionAction: "push",
        reviewCycles,
      },
    },
  });
}

function mergedAddressableTask(reviewCycles = 0) {
  return createTaskWithStatus("merged", {
    config: { id: TASK_ID, name: "Merged Task", directory: "/workspaces/my-project", workspaceId: "ws-1" },
    state: {
      reviewMode: {
        addressable: true,
        completionAction: "local",
        reviewCycles,
      },
    },
  });
}

function setupApi(task: ReturnType<typeof createTaskWithStatus>) {
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

// ─── Review comments scenarios ───────────────────────────────────────────────

describe("review comments scenario", () => {
  async function navigateToTaskRoute() {
    await act(async () => {
      window.location.hash = `#/task/${TASK_ID}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  test("pushed addressable task exposes review actions in task details", async () => {
    const task = pushedAddressableTask(0);
    setupApi(task);

    const { getAllByText, getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Pushed Task").length).toBeGreaterThan(0);
    });

    await navigateToTaskRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/task/${TASK_ID}`);
    });
    await user.click(getByRole("button", { name: /Actions/ }));

    await waitFor(() => {
      const addressBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
      );
      expect(addressBtn).toBeTruthy();
    });
  });

  test("address comments from dashboard: navigate to details then submit", async () => {
    const task = pushedAddressableTask(1);
    setupApi(task);
    api.post("/api/tasks/:id/address-comments", () => ({ success: true }));

    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Pushed Task").length).toBeGreaterThan(0);
    });

    await navigateToTaskRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/task/${TASK_ID}`);
    });

    await user.click(getByRole("button", { name: /Actions/ }));

    // Find and click Address Comments button in the Actions tab
    await waitFor(() => {
      const addressBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
      );
      expect(addressBtn).toBeTruthy();
    });

    const addressBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
    );
    await user.click(addressBtn!);

    // AddressCommentsModal opens
    await waitFor(() => {
      expect(getByText("Address Reviewer Comments")).toBeTruthy();
    });

    // Description shows task name and review cycle
    const reviewCycleTexts = Array.from(document.querySelectorAll("*")).filter(
      (el) => el.textContent?.includes("Pushed Task") && el.textContent?.includes("Review Cycle 2"),
    );
    expect(reviewCycleTexts.length).toBeGreaterThan(0);

    // Fill in comments
    const textarea = document.querySelector("#reviewer-comments") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    await user.type(textarea, "X");

    // Submit Comments button
    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Submit Comments"),
    );
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn!);

    // API should have been called
    await waitFor(() => {
      const calls = api.calls("/api/tasks/:id/address-comments", "POST");
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  test("address comments from task details: navigate then address", async () => {
    const task = pushedAddressableTask(0);
    setupApi(task);
    api.post("/api/tasks/:id/address-comments", () => ({ success: true }));

    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />);

    await navigateToTaskRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/task/${TASK_ID}`);
      expect(getAllByText("Pushed Task").length).toBeGreaterThan(0);
    });

    await user.click(getByRole("button", { name: /Actions/ }));

    // Find and click Address Comments button
    await waitFor(() => {
      const addressBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
      );
      expect(addressBtn).toBeTruthy();
    });

    const addressBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
    );
    await user.click(addressBtn!);

    // AddressCommentsModal opens
    await waitFor(() => {
      expect(getByText("Address Reviewer Comments")).toBeTruthy();
    });

    // Fill in and submit
    const textarea = document.querySelector("#reviewer-comments") as HTMLTextAreaElement;
    await user.type(textarea, "Y");

    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Submit Comments"),
    );
    await user.click(submitBtn!);

    // API called
    await waitFor(() => {
      const calls = api.calls("/api/tasks/:id/address-comments", "POST");
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  test("merged addressable task exposes address-comments action in details", async () => {
    const task = mergedAddressableTask(2);
    setupApi(task);

    const { getAllByText, getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Merged Task").length).toBeGreaterThan(0);
    });

    await navigateToTaskRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/task/${TASK_ID}`);
    });
    await user.click(getByRole("button", { name: /Actions/ }));

    await waitFor(() => {
      const addressBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
      );
      expect(addressBtn).toBeTruthy();
    });
  });

  test("review cycle is reflected in the address-comments dialog", async () => {
    const task = pushedAddressableTask(3);
    setupApi(task);

    const { getAllByText, getByRole, user } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getAllByText("Pushed Task").length).toBeGreaterThan(0);
    });

    await navigateToTaskRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/task/${TASK_ID}`);
    });
    await user.click(getByRole("button", { name: /Actions/ }));

    await waitFor(() => {
      const addressBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
      );
      expect(addressBtn).toBeTruthy();
    });
    const addressBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
    );
    await user.click(addressBtn!);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Review Cycle 4");
    });
  });

  test("submit comments is disabled when textarea is empty", async () => {
    const task = pushedAddressableTask(0);
    setupApi(task);

    const { getAllByText, getByRole, getByText, user } = renderWithUser(<App />);

    await navigateToTaskRoute();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/task/${TASK_ID}`);
      expect(getAllByText("Pushed Task").length).toBeGreaterThan(0);
    });

    await user.click(getByRole("button", { name: /Actions/ }));

    // Find and click Address Comments button
    await waitFor(() => {
      const addressBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
      );
      expect(addressBtn).toBeTruthy();
    });

    const addressBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
    );
    await user.click(addressBtn!);

    // AddressCommentsModal opens
    await waitFor(() => {
      expect(getByText("Address Reviewer Comments")).toBeTruthy();
    });

    // Submit button should be disabled when empty
    const submitBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Submit Comments"),
    );
    expect(submitBtn).toBeTruthy();
    expect(submitBtn!.disabled).toBe(true);
  });
});
