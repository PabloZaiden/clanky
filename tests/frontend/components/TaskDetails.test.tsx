/**
 * Tests for TaskDetails component.
 *
 * Tests task data display, tab navigation, planning mode, action buttons,
 * modal flows, connection status, loading/error states, and the action bar.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMockApi, MockApiError } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor, within } from "../helpers/render";
import {
  createTaskWithStatus,
  createFileDiff,
  createSshSession,
} from "../helpers/factories";
import { TaskDetails } from "@/components/TaskDetails";
import { AppEventsProvider } from "@/hooks";
import type { Chat } from "@/types";

const api = createMockApi();
const ws = createMockWebSocket();

const TASK_ID = "task-1";
let openCalls: Array<{ url: string; target: string; features: string }> = [];

function renderWithAppEvents(
  ui: Parameters<typeof renderWithUser>[0],
  options?: Parameters<typeof renderWithUser>[1],
) {
  const result = renderWithUser(<AppEventsProvider>{ui}</AppEventsProvider>, options);
  return {
    ...result,
    rerender: (nextUi: Parameters<typeof renderWithUser>[0]) =>
      result.rerender(<AppEventsProvider>{nextUi}</AppEventsProvider>),
  };
}
let originalWindowOpen: typeof window.open;

type TaskDetailsRenderResult = ReturnType<typeof renderWithUser>;

async function openActionsTab(
  renderResult: Pick<TaskDetailsRenderResult, "getByRole" | "user">,
): Promise<HTMLElement> {
  await renderResult.user.click(renderResult.getByRole("button", { name: /^Actions$/i }));
  return await waitFor(() => renderResult.getByRole("region", { name: /^Actions$/i }));
}

/** Set up default API routes for TaskDetails. */
function setupDefaultApi(taskOverrides?: Parameters<typeof createTaskWithStatus>[1]) {
  const task = createTaskWithStatus("running", {
    config: { id: TASK_ID, name: "Test Task", prompt: "Fix the bug", ...(taskOverrides?.config ?? {}) },
    state: taskOverrides?.state,
  });

  // Core task endpoint
  api.get("/api/tasks/:id", () => task);
  // Diff, plan, status-file
  api.get("/api/tasks/:id/diff", () => []);
  api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
  api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
  api.get("/api/tasks/:id/pull-request", () => ({
    enabled: false,
    destinationType: "disabled",
    disabledReason: "GitHub CLI is not available in the task environment.",
  }));
  // Comments
  api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
  // Models
  api.get("/api/models", () => []);
  // Preferences
  api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
  api.get("/api/preferences/log-level", () => ({ level: "info" }));
  // Actions (POST/PUT/DELETE)
  api.post("/api/tasks/:id/accept", () => ({ success: true }));
  api.post("/api/tasks/:id/push", () => ({ success: true }));
  api.post("/api/tasks/:id/stop", () => ({ success: true }));
  api.delete("/api/tasks/:id", () => ({ success: true }));
  api.post("/api/tasks/:id/purge", () => ({ success: true }));
  api.post("/api/tasks/:id/mark-merged", () => ({ success: true }));
  api.post("/api/tasks/:id/manual-complete", () => ({ success: true }));
  api.post("/api/tasks/:id/address-comments", () => ({ success: true }));
  api.post("/api/tasks/:id/automatic-pr-flow/start", () => ({
    success: true,
    automaticPrFlow: {
      enabled: true,
      status: "monitoring",
      startedAt: "2026-04-11T04:00:00.000Z",
      updatedAt: "2026-04-11T04:00:00.000Z",
      lastCheckedAt: "2026-04-11T04:00:00.000Z",
      pullRequestNumber: 1,
      pullRequestUrl: "https://github.com/example/repo/pull/1",
    },
  }));
  api.post("/api/tasks/:id/automatic-pr-flow/stop", () => ({
    success: true,
    automaticPrFlow: {
      enabled: false,
      status: "stopped",
      startedAt: "2026-04-11T04:00:00.000Z",
      updatedAt: "2026-04-11T04:10:00.000Z",
      stoppedAt: "2026-04-11T04:10:00.000Z",
    },
  }));
  api.post("/api/tasks/:id/pull-request/auto-merge", () => ({
    success: true,
    pullRequest: {
      number: 1,
      url: "https://github.com/example/repo/pull/1",
    },
  }));
  api.post("/api/tasks/:id/pending", () => ({ success: true }));
  api.post("/api/tasks/:id/follow-up", () => ({ success: true }));
  api.delete("/api/tasks/:id/pending", () => ({ success: true }));
  api.put("/api/tasks/:id", () => task);
  api.patch("/api/tasks/:id", () => task);
  api.post("/api/tasks/:id/plan/feedback", () => ({ success: true }));
  api.post("/api/tasks/:id/plan/accept", () => ({ success: true, mode: "start_task" }), 200);
  api.post("/api/tasks/:id/plan/discard", () => ({ success: true }));

  return task;
}

beforeEach(() => {
  api.reset();
  api.install();
  api.get("/api/tasks/:id/port-forwards", () => []);
  ws.reset();
  ws.install();
  openCalls = [];
  originalWindowOpen = window.open;
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    openCalls.push({
      url: String(url),
      target: target ?? "",
      features: features ?? "",
    });
    return null;
  }) as typeof window.open;
});

afterEach(() => {
  window.open = originalWindowOpen;
  api.uninstall();
  ws.uninstall();
});

// ─── Task not found ──────────────────────────────────────────────────────────

describe("task not found", () => {
  test("shows task not found when API returns error", async () => {
    api.get("/api/tasks/:id", () => {
      throw new MockApiError(404, { error: "not_found" });
    });
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Not found")).toBeTruthy();
    });
    // The error detail is shown in the paragraph below
    expect(getByText("Task not found")).toBeTruthy();
  });

});

// ─── Header display ──────────────────────────────────────────────────────────

describe("header display", () => {
  test("calls onBack when back button is clicked", async () => {
    setupDefaultApi();
    let backCalled = false;
    const onBack = () => { backCalled = true; };
    const { getByRole, user } = renderWithAppEvents(
      <TaskDetails taskId={TASK_ID} onBack={onBack} />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: /Back/ })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: /Back/ }));
    expect(backCalled).toBe(true);
  });
});

// ─── Tab navigation ──────────────────────────────────────────────────────────

describe("tab navigation", () => {
  test("can switch to Info tab", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Test Task")).toBeTruthy();
    });

    await user.click(getByText("Info"));

    await waitFor(() => {
      expect(getByText("Task Information")).toBeTruthy();
    });
  });

  test("can switch to Prompt tab", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Test Task")).toBeTruthy();
    });

    await user.click(getByText("Prompt"));

    await waitFor(() => {
      expect(getByText("Original Task Prompt")).toBeTruthy();
    });
  });

  test("can switch to Plan tab", async () => {
    const task = createTaskWithStatus("running", {
      config: { id: TASK_ID, name: "Test Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: true, content: "# My Plan\nDo things" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Test Task")).toBeTruthy();
    });

    await user.click(getByText("Plan"));

    await waitFor(() => {
      expect(getByText(/My Plan/)).toBeTruthy();
    });
  });

  test("opens the task Chat tab with the embedded chat composer and preserves draft input between tabs", async () => {
    setupDefaultApi();
    const taskChat: Chat = {
      config: {
        id: "task-chat-1",
        name: "Test Task",
        workspaceId: "workspace-1",
        directory: "/workspaces/test-task/.clanky-worktrees/task-1",
        model: {
          providerID: "github",
          modelID: "gpt-5.4",
          variant: "",
        },
        useWorktree: false,
        baseBranch: "main",
        createdAt: "2026-04-28T00:00:00.000Z",
        updatedAt: "2026-04-28T00:00:00.000Z",
        mode: "chat",
        scope: "task",
        taskId: TASK_ID,
      },
      state: {
        id: "task-chat-1",
        status: "idle",
        messages: [],
        logs: [],
        toolCalls: [],
      },
    };
    let createTaskChatCalls = 0;
    api.post("/api/tasks/:id/chat", () => {
      createTaskChatCalls += 1;
      return taskChat;
    });
    api.get("/api/chats/:id", () => taskChat);

    const { getByRole, getByText, queryByRole, queryByTestId, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Test Task")).toBeTruthy();
    });
    expect(createTaskChatCalls).toBe(0);

    await user.click(getByRole("button", { name: /^Chat$/i }));

    await waitFor(() => {
      expect(getByText("No messages yet")).toBeTruthy();
    });

    expect(createTaskChatCalls).toBe(1);
    expect(queryByTestId("chat-header")).toBeNull();
    expect(queryByTestId("chat-composer-model-cell")).toBeNull();
    expect(getByRole("textbox", { name: "Message" })).toBeInTheDocument();
    expect(getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(queryByRole("textbox", { name: "Task message" })).toBeNull();

    const messageInput = getByRole("textbox", { name: "Message" });
    await user.type(messageInput, "Need to keep this draft");

    await user.click(getByRole("button", { name: /^Info$/i }));
    await waitFor(() => {
      expect(getByText("Task Information")).toBeTruthy();
    });

    await user.click(getByRole("button", { name: /^Chat$/i }));

    await waitFor(() => {
      expect(getByRole("textbox", { name: "Message" })).toHaveValue("Need to keep this draft");
    });
    expect(createTaskChatCalls).toBe(1);
  });

  test("Plan tab shows message when no plan exists", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Test Task")).toBeTruthy();
    });

    await user.click(getByText("Plan"));

    await waitFor(() => {
      expect(getByText(/No plan\.md file found/)).toBeTruthy();
    });
  });

  test("can switch to Diff tab", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Test Task")).toBeTruthy();
    });

    await user.click(getByText("Diff"));

    await waitFor(() => {
      expect(getByText("No changes yet.")).toBeTruthy();
    });
  });

  test("Diff tab shows file changes when available", async () => {
    const task = createTaskWithStatus("running", {
      config: { id: TASK_ID, name: "Test Task" },
    });
    const diffs = [
      createFileDiff({ path: "src/app.ts", status: "modified", additions: 5, deletions: 2 }),
      createFileDiff({ path: "src/new.ts", status: "added", additions: 20, deletions: 0 }),
    ];
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => diffs);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Test Task")).toBeTruthy();
    });

    await user.click(getByText("Diff"));

    await waitFor(() => {
      expect(getByText("src/app.ts")).toBeTruthy();
      expect(getByText("src/new.ts")).toBeTruthy();
    });
  });

  test("Actions tab does not show review section when review mode is not enabled", async () => {
    setupDefaultApi();
    const { getByText, queryByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Test Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      // Actions tab should be visible
      expect(getByText("Delete Task")).toBeTruthy();
    });

    // Review section should not appear when review mode is not enabled
    expect(queryByText(/does not have review mode enabled/)).toBeFalsy();
    expect(queryByText("Review Mode Status")).toBeFalsy();
  });

  test("Actions tab shows review info when review mode is enabled", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Review Task" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 2,
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Review Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Review Mode Status")).toBeTruthy();
    });
    expect(getByText("Yes")).toBeTruthy(); // Addressable: Yes
    expect(getByText("push")).toBeTruthy(); // Completion action: push
  });

  test("can switch to Actions tab", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Test Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      // Running task shows Delete Task button in actions tab
      expect(getByText("Delete Task")).toBeTruthy();
    });
  });
});

// ─── Actions tab content ─────────────────────────────────────────────────────

describe("actions tab content", () => {
  test("running task shows delete action", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Test Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Delete Task")).toBeTruthy();
    });
  });

  test("planning tasks replace connect via ssh with accept plan and open ssh", async () => {
    const task = createTaskWithStatus("planning", {
      config: { id: TASK_ID, name: "Planning Task" },
      state: {
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: true,
          planContent: "# Plan",
        },
      },
    });
    const session = createSshSession({ config: { id: "ssh-task-1", taskId: TASK_ID } });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: true, content: "# Plan" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: true, content: "todo" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.post("/api/tasks/:id/plan/accept", (req) => {
      expect(req.body).toEqual({ mode: "open_ssh" });
      return { success: true, mode: "open_ssh", sshSession: session };
    }, 200);

    let selectedSessionId: string | null = null;
    const { getByText, user } = renderWithAppEvents(
      <TaskDetails taskId={TASK_ID} onSelectSshSession={(sshSessionId) => { selectedSessionId = sshSessionId; }} />,
    );

    await waitFor(() => {
      expect(getByText("Planning Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));
    expect(() => getByText("Connect via ssh")).toThrow();
    await user.click(getByText("Accept Plan & Open SSH"));

    await waitFor(() => {
      expect(selectedSessionId).toBe("ssh-task-1");
    });
  });

  describe("info tab content", () => {
    test("opens the task code explorer from the info tab", async () => {
      setupDefaultApi({
        state: {
          git: {
            originalBranch: "main",
            workingBranch: "task-code-explorer",
            commits: [],
            worktreePath: "/workspaces/test-project/.clanky-worktrees/task-1",
          },
        },
      });
      const openedTaskFiles: string[] = [];
      const { getByText, user } = renderWithAppEvents(
        <TaskDetails
          taskId={TASK_ID}
          onOpenTaskFiles={(taskId) => {
            openedTaskFiles.push(taskId);
          }}
        />,
      );

      await waitFor(() => {
        expect(getByText("Test Task")).toBeTruthy();
      });

      await user.click(getByText("Info"));

      await waitFor(() => {
        expect(getByText("Open code explorer")).toBeTruthy();
      });

      await user.click(getByText("Open code explorer"));

      expect(openedTaskFiles).toEqual([TASK_ID]);
    });

    test("port-forward form only shows the remote port and submits only that value", async () => {
      setupDefaultApi();
      api.post("/api/tasks/:id/port-forwards", (req) => {
        expect(req.body).toEqual({ remotePort: 3000 });
        return {
          config: {
            id: "forward-1",
            taskId: TASK_ID,
            workspaceId: "workspace-1",
            remoteHost: "localhost",
            remotePort: 3000,
            localPort: 43000,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          state: {
            status: "active",
          },
        };
      }, 201);

      const {
        getByLabelText,
        getByRole,
        getByText,
        queryByText,
        user,
      } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

      await waitFor(() => {
        expect(getByText("Test Task")).toBeTruthy();
      });

      await user.click(getByText("Info"));

      await waitFor(() => {
        expect(getByText("Forward a Port")).toBeTruthy();
      });

      expect(queryByText("Remote host")).toBeNull();

      const remotePortInput = getByLabelText("Remote port") as HTMLInputElement;
      expect(remotePortInput.type).toBe("number");
      expect(remotePortInput.min).toBe("1");
      expect(remotePortInput.max).toBe("65535");
      expect(remotePortInput.getAttribute("placeholder")).toBe("");

      expect(getByRole("button", { name: "Create Port Forward" })).toBeTruthy();

      await user.type(remotePortInput, "3000");
      await user.click(getByRole("button", { name: "Create Port Forward" }));

      await waitFor(() => {
        expect(remotePortInput.value).toBe("");
      });
    });

    test("deleted tasks still show connect via ssh in the info tab before purge", async () => {
      const task = createTaskWithStatus("deleted", {
        config: { id: TASK_ID, name: "Deleted Task" },
      });
      api.get("/api/tasks/:id", () => task);
      api.get("/api/tasks/:id/diff", () => []);
      api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
      api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
      api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
      api.get("/api/models", () => []);
      api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
      api.get("/api/preferences/log-level", () => ({ level: "info" }));

      const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

      await waitFor(() => {
        expect(getByText("Deleted Task")).toBeTruthy();
      });

      await user.click(getByText("Info"));

      await waitFor(() => {
        expect(getByText("Connect via ssh")).toBeTruthy();
      });

      await user.click(getByText("Actions"));

      await waitFor(() => {
        expect(getByText("Purge Task")).toBeTruthy();
      });
    });

    test("planning tasks can update auto-accept and fully autonomous settings from the info tab", async () => {
      let task = createTaskWithStatus("planning", {
        config: {
          id: TASK_ID,
          name: "Planning Task",
          autoAcceptPlan: false,
          fullyAutonomous: false,
        },
        state: {
          planMode: {
            active: true,
            feedbackRounds: 0,
            planningFolderCleared: false,
            isPlanReady: false,
          },
        },
      });
      api.get("/api/tasks/:id", () => task);
      api.get("/api/tasks/:id/diff", () => []);
      api.get("/api/tasks/:id/plan", () => ({ exists: true, content: "# Plan" }));
      api.get("/api/tasks/:id/status-file", () => ({ exists: true, content: "- Task A" }));
      api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
      api.get("/api/models", () => []);
      api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
      api.get("/api/preferences/log-level", () => ({ level: "info" }));
      api.patch("/api/tasks/:id", (req) => {
        expect(req.body).toEqual({ autoAcceptPlan: true, fullyAutonomous: true });
        task = {
          ...task,
          config: {
            ...task.config,
            autoAcceptPlan: true,
            fullyAutonomous: true,
          },
        };
        return task;
      });

      const { getByRole, getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

      await waitFor(() => {
        expect(getByText("Planning Task")).toBeTruthy();
      });

      await user.click(getByText("Info"));

      await waitFor(() => {
        expect(getByText("Plan automation")).toBeTruthy();
      });

      const autoAcceptCheckbox = getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement;
      const fullyAutonomousCheckbox = getByRole("checkbox", { name: /Fully autonomous task/i }) as HTMLInputElement;

      expect(autoAcceptCheckbox.checked).toBe(false);
      expect(fullyAutonomousCheckbox.checked).toBe(false);

      await user.click(fullyAutonomousCheckbox);

      await waitFor(() => {
        expect(api.calls("/api/tasks/:id", "PATCH")).toHaveLength(1);
        expect(autoAcceptCheckbox.checked).toBe(true);
        expect(fullyAutonomousCheckbox.checked).toBe(true);
      });
    });

    test("approved plan tasks can still enable fully autonomous mode from the info tab", async () => {
      let task = createTaskWithStatus("running", {
        config: {
          id: TASK_ID,
          name: "Accepted Plan Task",
          planMode: true,
          autoAcceptPlan: false,
          fullyAutonomous: false,
        },
        state: {
          planMode: {
            active: false,
            feedbackRounds: 0,
            planningFolderCleared: false,
            isPlanReady: true,
          },
        },
      });
      api.get("/api/tasks/:id", () => task);
      api.get("/api/tasks/:id/diff", () => []);
      api.get("/api/tasks/:id/plan", () => ({ exists: true, content: "# Plan" }));
      api.get("/api/tasks/:id/status-file", () => ({ exists: true, content: "- Task A" }));
      api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
      api.get("/api/models", () => []);
      api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
      api.get("/api/preferences/log-level", () => ({ level: "info" }));
      api.patch("/api/tasks/:id", (req) => {
        expect(req.body).toEqual({ fullyAutonomous: true });
        task = {
          ...task,
          config: {
            ...task.config,
            autoAcceptPlan: true,
            fullyAutonomous: true,
          },
        };
        return task;
      });

      const { getByRole, getByText, queryByRole, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

      await waitFor(() => {
        expect(getByText("Accepted Plan Task")).toBeTruthy();
      });

      await user.click(getByText("Info"));

      await waitFor(() => {
        expect(getByText("Plan automation")).toBeTruthy();
      });

      expect(queryByRole("checkbox", { name: /Auto-accept plan/i })).toBeNull();

      const fullyAutonomousCheckbox = getByRole("checkbox", { name: /Fully autonomous task/i }) as HTMLInputElement;
      expect(fullyAutonomousCheckbox.checked).toBe(false);

      await user.click(fullyAutonomousCheckbox);

      await waitFor(() => {
        expect(api.calls("/api/tasks/:id", "PATCH")).toHaveLength(1);
        expect(fullyAutonomousCheckbox.checked).toBe(true);
      });
    });
  });

  test("completed task shows accept and delete actions", async () => {
    const task = createTaskWithStatus("completed", {
      config: { id: TASK_ID, name: "Completed Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Completed Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Accept")).toBeTruthy();
      expect(getByText("Delete Task")).toBeTruthy();
    });
  });

  test("stopped task shows manual complete action and refreshes into accept state", async () => {
    let currentTask = createTaskWithStatus("stopped", {
      config: { id: TASK_ID, name: "Stopped Task" },
    });
    api.get("/api/tasks/:id", () => currentTask);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.post("/api/tasks/:id/manual-complete", () => {
      currentTask = createTaskWithStatus("completed", {
        config: { id: TASK_ID, name: "Stopped Task" },
      });
      return { success: true };
    });

    const { getByRole, getByText, queryByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Stopped Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Manually complete task")).toBeTruthy();
      expect(getByText("Delete Task")).toBeTruthy();
    });

    await user.click(getByText("Manually complete task"));

    await waitFor(() => {
      expect(getByRole("heading", { name: "Manually complete task" })).toBeTruthy();
      expect(getByText(/Use this when the task was stopped or failed/)).toBeTruthy();
    });

    const dialog = getByRole("dialog");
    const confirmButton = within(dialog).getByRole("button", { name: "Manually complete task" });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(api.calls("/api/tasks/:id/manual-complete", "POST")).toHaveLength(1);
      expect(getByText("Accept")).toBeTruthy();
      expect(queryByText("Manually complete task")).toBeNull();
    });
  });

  test("pushed task shows go to PR alongside review actions", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Pushed Task" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 1,
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/pull-request", () => ({
      enabled: true,
      destinationType: "existing_pr",
      url: "https://github.com/example/repo/pull/1",
    }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Pushed Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Go to PR")).toBeTruthy();
      expect(getByText("Automatic PR flow")).toBeTruthy();
      expect(getByText("Address Comments")).toBeTruthy();
      expect(getByText("Mark as Merged")).toBeTruthy();
      expect(getByText("Purge Task")).toBeTruthy();
    });
  });

  test("merged task hides the mark as merged action", async () => {
    const task = createTaskWithStatus("merged", {
      config: { id: TASK_ID, name: "Merged Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, queryByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Merged Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Purge Task")).toBeTruthy();
    });
    expect(queryByText("Mark as Merged")).toBeNull();
    expect(queryByText("Keep this task as merged after the branch landed elsewhere")).toBeNull();
  });

  test("pushed task disables go to PR when backend reports gh is unavailable", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Pushed Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/pull-request", () => ({
      enabled: false,
      destinationType: "disabled",
      disabledReason: "GitHub CLI is not available in the task environment.",
    }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const renderResult = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(renderResult.getByText("Pushed Task")).toBeTruthy();
    });

    const actionsTab = await openActionsTab(renderResult);
    const button = within(actionsTab).getByRole("button", { name: /Go to PR/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  test("pushed task keeps PR destination failures non-blocking", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Pushed Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/pull-request", () => {
      throw new MockApiError(500, { error: "internal_error" });
    });
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const renderResult = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(renderResult.getByText("Pushed Task")).toBeTruthy();
    });

    const actionsTab = await openActionsTab(renderResult);
    const button = within(actionsTab).getByRole("button", { name: /Go to PR/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(actionsTab).getByRole("button", { name: /Automatic PR flow/i })).toBeTruthy();
  });

  test("pushed task opens the create PR page when no PR exists", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Pushed Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/pull-request", () => ({
      enabled: true,
      destinationType: "create_pr",
      url: "https://github.com/example/repo/compare/main...feature%2Ftask?expand=1",
    }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByRole, getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Pushed Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    const button = await waitFor(() => getByRole("button", { name: /Go to PR/i }) as HTMLButtonElement);
    await waitFor(() => {
      expect(button.disabled).toBe(false);
    });

    await user.click(button);

    await waitFor(() => {
      expect(openCalls).toHaveLength(1);
    });
    expect(openCalls[0]).toEqual({
      url: "https://github.com/example/repo/compare/main...feature%2Ftask?expand=1",
      target: "_blank",
      features: "noopener,noreferrer",
    });
  });

  test("pushed task opens the existing PR when one already exists", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Pushed Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/pull-request", () => ({
      enabled: true,
      destinationType: "existing_pr",
      url: "https://github.com/example/repo/pull/42",
    }));
    api.post("/api/tasks/:id/pull-request/auto-merge", () => ({
      success: true,
      pullRequest: {
        number: 42,
        url: "https://github.com/example/repo/pull/42",
      },
    }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByRole, getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Pushed Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    const button = await waitFor(() => getByRole("button", { name: /Go to PR/i }) as HTMLButtonElement);
    await waitFor(() => {
      expect(button.disabled).toBe(false);
    });
    expect(button.type).toBe("button");

    await user.click(button);

    await waitFor(() => {
      expect(openCalls).toHaveLength(1);
    });
    expect(openCalls[0]).toEqual({
      url: "https://github.com/example/repo/pull/42",
      target: "_blank",
      features: "noopener,noreferrer",
    });
  });

  test("pushed task opens automatic PR flow confirmation modal", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Pushed Task" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/pull-request", () => ({
      enabled: true,
      destinationType: "existing_pr",
      url: "https://github.com/example/repo/pull/42",
    }));
    api.post("/api/tasks/:id/pull-request/auto-merge", () => ({
      success: true,
      pullRequest: {
        number: 42,
        url: "https://github.com/example/repo/pull/42",
      },
    }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Pushed Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));
    await waitFor(() => {
      expect(getByText("Automatic PR flow")).toBeTruthy();
    });

    await user.click(getByText("Automatic PR flow"));

    await waitFor(() => {
      expect(getByText("Start Automatic PR flow?")).toBeTruthy();
    });
  });

  test("pushed task enables auto-merge only when an existing PR already exists", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Pushed Task" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/pull-request", () => ({
      enabled: true,
      destinationType: "existing_pr",
      url: "https://github.com/example/repo/pull/42",
    }));
    api.post("/api/tasks/:id/pull-request/auto-merge", () => ({
      success: true,
      pullRequest: {
        number: 42,
        url: "https://github.com/example/repo/pull/42",
      },
    }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const renderResult = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(renderResult.getByText("Pushed Task")).toBeTruthy();
    });

    const actionsTab = await openActionsTab(renderResult);
    expect(within(actionsTab).getByRole("button", { name: /Automatic PR flow/i })).toBeTruthy();
    const autoMergeButton = within(actionsTab).getByRole("button", { name: /Enable Auto-Merge/i }) as HTMLButtonElement;
    expect(autoMergeButton.disabled).toBe(false);

    await renderResult.user.click(autoMergeButton);

    await waitFor(() => {
      expect(api.calls("/api/tasks/:id/pull-request/auto-merge", "POST")).toHaveLength(1);
    });
  });

  test("pushed task only shows auto-merge when an existing PR already exists", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Pushed Task" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/pull-request", () => ({
      enabled: true,
      destinationType: "create_pr",
      url: "https://github.com/example/repo/compare/main...feature%2Ftask?expand=1",
    }));
    api.post("/api/tasks/:id/pull-request/auto-merge", () => ({
      success: true,
      pullRequest: {
        number: 42,
        url: "https://github.com/example/repo/pull/42",
      },
    }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const renderResult = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(renderResult.getByText("Pushed Task")).toBeTruthy();
    });

    const actionsTab = await openActionsTab(renderResult);
    expect(within(actionsTab).queryByRole("button", { name: /Enable Auto-Merge/i })).toBeNull();
    expect(api.calls("/api/tasks/:id/pull-request/auto-merge", "POST")).toHaveLength(0);
  });

  test("pushed task shows stop automatic PR flow state when enabled", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Pushed Task" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
        },
        automaticPrFlow: {
          enabled: true,
          status: "monitoring",
          startedAt: "2026-04-11T04:00:00.000Z",
          updatedAt: "2026-04-11T04:00:00.000Z",
          lastCheckedAt: "2026-04-11T04:00:00.000Z",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.com/example/repo/pull/42",
          handledItems: [],
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/pull-request", () => ({
      enabled: true,
      destinationType: "existing_pr",
      url: "https://github.com/example/repo/pull/42",
    }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, queryByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Pushed Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Stop Automatic PR flow")).toBeTruthy();
    });
    expect(queryByText("Automatic PR flow")).toBeNull();
    expect(getByText("PR: #42")).toBeTruthy();
  });
});

// ─── Modals ──────────────────────────────────────────────────────────────────

describe("delete modal", () => {
  test("opens delete modal from actions tab", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Test Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Delete Task")).toBeTruthy();
    });

    // Click the Delete Task action button in the actions tab
    const deleteBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete Task") && b.textContent?.includes("Cancel and delete"),
    );
    expect(deleteBtn).toBeTruthy();
    await user.click(deleteBtn!);

    await waitFor(() => {
      // The DeleteTaskModal shows a confirmation
      expect(getByText(/Are you sure/)).toBeTruthy();
    });
  });
});

describe("accept modal", () => {
  test("opens accept modal from actions tab for completed task", async () => {
    const task = createTaskWithStatus("completed", {
      config: { id: TASK_ID, name: "Accept Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Accept Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      // The Accept action button in the actions tab
      const acceptBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Accept") && b.textContent?.includes("Accept changes"),
      );
      expect(acceptBtn).toBeTruthy();
    });

    const acceptBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Accept") && b.textContent?.includes("Accept changes"),
    );
    await user.click(acceptBtn!);

    await waitFor(() => {
      expect(getByText("Finalize Task")).toBeTruthy();
    });
  });
});

describe("purge modal", () => {
  test("opens purge modal from actions tab for pushed task", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Purge Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Purge Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      const purgeBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Purge Task") && b.textContent?.includes("Delete this task"),
      );
      expect(purgeBtn).toBeTruthy();
    });

    const purgeBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Purge Task") && b.textContent?.includes("Delete this task"),
    );
    await user.click(purgeBtn!);

    await waitFor(() => {
      // Purge modal confirmation
      expect(getByText(/permanently delete/i)).toBeTruthy();
    });
  });
});

describe("address comments modal", () => {
  test("opens address comments modal from actions tab", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Comment Task" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 1,
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Comment Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      const addrBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
      );
      expect(addrBtn).toBeTruthy();
    });

    const addrBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
    );
    await user.click(addrBtn!);

    await waitFor(() => {
      expect(getByText("Address Reviewer Comments")).toBeTruthy();
    });
  });
});

describe("mark merged modal", () => {
  test("opens mark merged modal from actions tab", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Merge Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Merge Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      const mergeBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Mark as Merged") && b.textContent?.includes("Keep this task as merged"),
      );
      expect(mergeBtn).toBeTruthy();
    });

    const mergeBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Mark as Merged") && b.textContent?.includes("Keep this task as merged"),
    );
    await user.click(mergeBtn!);

    await waitFor(() => {
      expect(getByText(/keep the task as merged/i)).toBeTruthy();
    });
  });
});

describe("task rename restrictions", () => {
  test("does not expose rename controls from task details", async () => {
    setupDefaultApi();
    const { getByText, container } = renderWithAppEvents(
      <TaskDetails taskId={TASK_ID} />,
    );

    await waitFor(() => {
      expect(getByText("Test Task")).toBeTruthy();
    });

    const renameBtn = container.querySelector('button[aria-label="Rename task"]');
    expect(renameBtn).toBeNull();
  });
});

// ─── Planning mode ───────────────────────────────────────────────────────────

describe("planning mode", () => {
  test("shows unified tab UI with plan tab active when in planning status", async () => {
    const task = createTaskWithStatus("planning", {
      config: { id: TASK_ID, name: "Planning Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: true, content: "# The Plan" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Planning Task")).toBeTruthy();
    });

    // All tabs should be visible in the unified UI
    await waitFor(() => {
      expect(getByText("Plan")).toBeTruthy();
      expect(getByText("Actions")).toBeTruthy();
      expect(getByText("Log")).toBeTruthy();
    });
  });

  test("shows Planning status badge for planning task", async () => {
    const task = createTaskWithStatus("planning", {
      config: { id: TASK_ID, name: "Planning Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Planning")).toBeTruthy();
    });
  });

  test("keeps the waiting state without a shared error banner when planning files hit transient no_worktree", async () => {
    const task = createTaskWithStatus("planning", {
      config: { id: TASK_ID, name: "Startup Planning Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => {
      throw new MockApiError(400, {
        error: "no_worktree",
        message: "Task is configured to use a worktree, but no worktree path is available.",
      });
    });
    api.get("/api/tasks/:id/status-file", () => {
      throw new MockApiError(400, {
        error: "no_worktree",
        message: "Task is configured to use a worktree, but no worktree path is available.",
      });
    });
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, queryByText } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Startup Planning Task")).toBeTruthy();
    });

    await waitFor(() => {
      expect(getByText("Waiting for AI to generate plan...")).toBeTruthy();
    });

    expect(queryByText(/Failed to get plan/)).toBeNull();
  });

  test("still shows the shared error banner for real plan fetch failures", async () => {
    const task = createTaskWithStatus("planning", {
      config: { id: TASK_ID, name: "Broken Planning Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => {
      throw new MockApiError(500, {
        error: "internal_error",
        message: "Unexpected failure while loading plan",
      });
    });
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Broken Planning Task")).toBeTruthy();
    });

    await waitFor(() => {
      expect(getByText(/Failed to get plan/)).toBeTruthy();
    });
  });


  test("renders planning tasks when isPlanReady=true", async () => {
    const task = createTaskWithStatus("planning", {
      config: { id: TASK_ID, name: "Amber Indicator Task" },
      state: {
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: true,
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: true, content: "# Plan" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Amber Indicator Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Accept Plan & Start Task")).toBeTruthy();
      expect(getByText("Accept Plan & Open SSH")).toBeTruthy();
      expect(getByText("Discard Plan")).toBeTruthy();
    });

  });
});

// ─── TaskActionBar ───────────────────────────────────────────────────────────

describe("task action bar", () => {
  test("shows action bar for active tasks", async () => {
    setupDefaultApi();
    const { getByRole } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByRole("textbox", { name: "Task message" })).toBeTruthy();
    });
  });

  test("shows Stop for an empty active composer and calls the stop API", async () => {
    setupDefaultApi();
    const { getByRole, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Stop" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(api.calls("/api/tasks/:id/stop", "POST")).toHaveLength(1);
    });
  });

  test("does not show action bar for non-addressable final-state tasks", async () => {
    const task = createTaskWithStatus("merged", {
      config: { id: TASK_ID, name: "Merged Task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, queryByRole } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Merged Task")).toBeTruthy();
    });

    expect(queryByRole("textbox", { name: "Task message" })).toBeNull();
  });

  test("shows restart composer for locally accepted addressable tasks and submits follow-up", async () => {
    const task = createTaskWithStatus("accepted_local", {
      config: { id: TASK_ID, name: "Accepted Local Task" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "local",
          reviewCycles: 0,
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.post("/api/tasks/:id/follow-up", () => ({ success: true }));

    const { getByRole, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Restart" })).toBeTruthy();
    });

    await user.type(getByRole("textbox", { name: "Task message" }), "Please revise this");
    await user.click(getByRole("button", { name: "Restart" }));

    await waitFor(() => {
      expect(api.calls("/api/tasks/:id/follow-up", "POST")).toHaveLength(1);
    });
    expect(api.calls("/api/tasks/:id/follow-up", "POST")[0]?.body).toMatchObject({
      message: "Please revise this",
      promptMode: "task_context",
    });
  });

  test("shows restart composer for pushed addressable tasks and submits plain chat follow-up", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Pushed Task" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.post("/api/tasks/:id/follow-up", () => ({ success: true }));

    const { getByRole, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Restart" })).toBeTruthy();
    });

    await user.type(getByRole("textbox", { name: "Task message" }), "Please revise this");
    await user.click(getByRole("button", { name: "Restart" }));

    await waitFor(() => {
      expect(api.calls("/api/tasks/:id/follow-up", "POST")).toHaveLength(1);
    });
    expect(api.calls("/api/tasks/:id/follow-up", "POST")[0]?.body).toMatchObject({
      message: "Please revise this",
      promptMode: "plain_chat",
    });
  });

  test("submits stopped task follow-up with task context", async () => {
    const task = createTaskWithStatus("stopped", {
      config: { id: TASK_ID, name: "Stopped Task", prompt: "Finish task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.post("/api/tasks/:id/follow-up", () => ({ success: true }));

    const { getByRole, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Restart" })).toBeTruthy();
    });

    await user.type(getByRole("textbox", { name: "Task message" }), "Resume with context");
    await user.click(getByRole("button", { name: "Restart" }));

    await waitFor(() => {
      expect(api.calls("/api/tasks/:id/follow-up", "POST")).toHaveLength(1);
    });
    expect(api.calls("/api/tasks/:id/follow-up", "POST")[0]?.body).toMatchObject({
      message: "Resume with context",
      promptMode: "task_context",
    });
  });

  test("shows restart composer for completed tasks and submits follow-up", async () => {
    const task = createTaskWithStatus("completed", {
      config: { id: TASK_ID, name: "Completed Task", prompt: "Finish task" },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.post("/api/tasks/:id/follow-up", () => ({ success: true }));

    const { getByRole, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Restart" })).toBeTruthy();
    });

    await user.type(getByRole("textbox", { name: "Task message" }), "Continue from the last result");
    await user.click(getByRole("button", { name: "Restart" }));

    await waitFor(() => {
      expect(api.calls("/api/tasks/:id/follow-up", "POST")).toHaveLength(1);
    });
    expect(api.calls("/api/tasks/:id/follow-up", "POST")[0]?.body).toMatchObject({
      message: "Continue from the last result",
      promptMode: "plain_chat",
    });
  });


  test("shows send feedback for plan-ready tasks and submits feedback", async () => {
    const task = createTaskWithStatus("planning", {
      config: { id: TASK_ID, name: "Plan Task", prompt: "Draft a plan" },
      state: {
        planMode: {
          active: true,
          feedbackRounds: 1,
          planningFolderCleared: false,
          isPlanReady: true,
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: true, content: "## Plan\n- Step 1" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: true, content: "- Task A" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.post("/api/tasks/:id/plan/feedback", () => ({ success: true }));

    const { getByRole, queryByRole, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Send Feedback" })).toBeTruthy();
    });
    expect(queryByRole("button", { name: "Stop" })).toBeNull();

    await user.type(getByRole("textbox", { name: "Plan feedback" }), "Please expand step 1");
    await user.click(getByRole("button", { name: "Send Feedback" }));

    await waitFor(() => {
      expect(api.calls("/api/tasks/:id/plan/feedback", "POST")).toHaveLength(1);
    });
  });
});

// ─── Error display ───────────────────────────────────────────────────────────

describe("error display", () => {
  test("shows task error when task has error state", async () => {
    const task = createTaskWithStatus("failed", {
      config: { id: TASK_ID, name: "Failed Task" },
      state: {
        error: {
          message: "Something went wrong in iteration 2",
          iteration: 2,
          timestamp: new Date().toISOString(),
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Task Error")).toBeTruthy();
    });
    expect(getByText("Something went wrong in iteration 2")).toBeTruthy();
    expect(getByText(/Iteration: 2/)).toBeTruthy();
  });
});

// ─── Log tab details ─────────────────────────────────────────────────────────

describe("log tab", () => {
  test("enters log focus mode while keeping the message composer available", async () => {
    setupDefaultApi();
    const { getByRole, queryByRole, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Enter focus mode" })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: "Enter focus mode" }));

    await waitFor(() => {
      expect(getByRole("button", { name: "Exit focus mode" })).toBeInTheDocument();
    });

    expect(queryByRole("button", { name: "Info" })).toBeNull();
    expect(queryByRole("button", { name: "Prompt" })).toBeNull();
    expect(queryByRole("button", { name: "Hide logs" })).toBeNull();
    expect(queryByRole("button", { name: "Show logs" })).toBeNull();
    expect(getByRole("textbox", { name: "Task message" })).toBeInTheDocument();
    expect(queryByRole("button", { name: "Autoscroll" })).toBeNull();
  });

  test("restores log focus mode from localStorage on remount", async () => {
    setupDefaultApi();
    const firstRender = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(firstRender.getByRole("button", { name: "Enter focus mode" })).toBeInTheDocument();
    });

    await firstRender.user.click(firstRender.getByRole("button", { name: "Enter focus mode" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("clanky-task-log-focus-mode")).toBe("true");
    });

    firstRender.unmount();

    const secondRender = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(secondRender.getByRole("button", { name: "Exit focus mode" })).toBeInTheDocument();
    });
  });

});

// ─── Actions tab comment history (review section) ────────────────────────────

describe("actions tab comment history", () => {
  test("shows comments grouped by review cycle", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Review Task" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 2,
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({
      success: true,
      comments: [
        {
          id: "c1",
          taskId: TASK_ID,
          reviewCycle: 1,
          commentText: "Fix the formatting",
          status: "addressed",
          createdAt: new Date().toISOString(),
          addressedAt: new Date().toISOString(),
        },
        {
          id: "c2",
          taskId: TASK_ID,
          reviewCycle: 2,
          commentText: "Add more tests",
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      ],
    }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Review Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Review Cycle 1")).toBeTruthy();
      expect(getByText("Review Cycle 2")).toBeTruthy();
    });
    expect(getByText("Fix the formatting")).toBeTruthy();
    expect(getByText("Add more tests")).toBeTruthy();
    expect(getByText("Addressed")).toBeTruthy();
    expect(getByText("Pending")).toBeTruthy();
  });

  test("shows no comments message when empty", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Review Task" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
        },
      },
    });
    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(getByText("Review Task")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("No comments yet.")).toBeTruthy();
    });
  });

  test("wraps long feedback lines inside the review comment card", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { id: TASK_ID, name: "Review Task" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 1,
        },
      },
    });
    const longComment = [
      "Feedback 1",
      "(sources=review_thread:PRRT_kwDOQ9x4vs5-xnOH,authors=copilot-pull-request-reviewer,paths=src/cli/update.ts:406,urls=https://github.com/PabloZaiden/clanky/pull/540#discussion_r1234567890123456789012345678901234567890)",
      "Make companion `clanky` replacement failures non-fatal in `clanky-cli update`.",
    ].join("\n");

    api.get("/api/tasks/:id", () => task);
    api.get("/api/tasks/:id/diff", () => []);
    api.get("/api/tasks/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/tasks/:id/comments", () => ({
      success: true,
      comments: [
        {
          id: "c1",
          taskId: TASK_ID,
          reviewCycle: 1,
          commentText: longComment,
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      ],
    }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const renderResult = renderWithAppEvents(<TaskDetails taskId={TASK_ID} />);

    await waitFor(() => {
      expect(renderResult.getByText("Review Task")).toBeTruthy();
    });

    const actionsTab = await openActionsTab(renderResult);
    const commentBody = await waitFor(() =>
      within(actionsTab).getByText((_, element) => (
        element instanceof HTMLParagraphElement && element.textContent === longComment
      ))
    );

    expect(commentBody.className).toContain("whitespace-pre-wrap");
    expect(commentBody.className).toContain("break-words");
    expect(commentBody.className).toContain("[overflow-wrap:anywhere]");
  });
});
