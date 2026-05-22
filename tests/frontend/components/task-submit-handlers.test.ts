import { afterEach, describe, expect, mock, test } from "bun:test";
import { handleCreateTaskSubmit } from "@/components/dashboard-modals/task-submit-handlers";
import { createTaskWithStatus, createWorkspace } from "../helpers/factories";
import { DEFAULT_TASK_CONFIG } from "@/types/task";
import { waitFor } from "../helpers/render";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.fetch = originalFetch;
});

describe("handleCreateTaskSubmit", () => {
  test("returns immediately when starting an edited draft and shows async conflicts later", async () => {
    const pendingDraftUpdate = { resolve: (_response: Response) => {} };
    const pendingDraftStart = { resolve: (_response: Response) => {} };

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const path = new URL(requestUrl, window.location.origin).pathname;

      if (method === "PUT" && path === "/api/tasks/draft-1") {
        return await new Promise<Response>((resolve) => {
          pendingDraftUpdate.resolve = resolve;
        });
      }

      if (method === "POST" && path === "/api/tasks/draft-1/draft/start") {
        return await new Promise<Response>((resolve) => {
          pendingDraftStart.resolve = resolve;
        });
      }

      if (method === "PUT" && path.startsWith("/api/preferences/")) {
        return jsonResponse({ success: true });
      }

      throw new Error(`Unexpected request: ${method} ${path}`);
    }) as typeof globalThis.fetch;
    window.fetch = globalThis.fetch;

    const setUncommittedModal = mock((_state: unknown) => {});
    const onRefresh = mock(async () => {});
    const toast = { error: mock((_message: string) => {}) };

    const result = await handleCreateTaskSubmit(
      {
        workspaces: [createWorkspace({ id: "ws-1", directory: "/workspaces/project-a" })],
        setLastModel: mock(() => {}),
        setLastCheapModel: mock(() => {}),
        setUncommittedModal,
        onRefresh,
        onCreateTask: mock(async () => ({ task: null })),
      },
      createTaskWithStatus("draft", {
        config: {
          id: "draft-1",
          name: "Existing Draft",
          workspaceId: "ws-1",
          directory: "/workspaces/project-a",
          prompt: "Ship the feature",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
            variant: "",
          },
        },
      }),
      {
        name: "Existing Draft",
        workspaceId: "ws-1",
        prompt: "Ship the feature",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
          variant: "",
        },
        draft: false,
        planMode: false,
        useWorktree: true,
        clearPlanningFolder: false,
        attachments: [],
        cheapModel: { mode: "same-as-task" },
        maxIterations: null,
        maxConsecutiveErrors: DEFAULT_TASK_CONFIG.maxConsecutiveErrors,
        activityTimeoutSeconds: DEFAULT_TASK_CONFIG.activityTimeoutSeconds,
        stopPattern: DEFAULT_TASK_CONFIG.stopPattern,
        git: {
          branchPrefix: DEFAULT_TASK_CONFIG.git.branchPrefix,
          commitScope: DEFAULT_TASK_CONFIG.git.commitScope,
        },
        baseBranch: "",
        autoAcceptPlan: false,
        fullyAutonomous: false,
      },
      toast,
    );

    expect(result).toBe(true);
    expect(setUncommittedModal).not.toHaveBeenCalled();
    pendingDraftUpdate.resolve(jsonResponse({ success: true }));
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    pendingDraftStart.resolve(jsonResponse({
      error: "uncommitted_changes",
      message: "Directory has uncommitted changes.",
      changedFiles: ["src/main.ts"],
    }, 409));

    await waitFor(() => {
      expect(setUncommittedModal).toHaveBeenCalledWith({
        open: true,
        taskId: "draft-1",
        error: {
          error: "uncommitted_changes",
          message: "Directory has uncommitted changes.",
          changedFiles: ["src/main.ts"],
        },
      });
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("still starts an edited draft when saving preferences fails", async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const path = new URL(requestUrl, window.location.origin).pathname;
      fetchCalls.push(`${method} ${path}`);

      if (method === "PUT" && path === "/api/tasks/draft-1") {
        return jsonResponse({ success: true });
      }

      if (method === "PUT" && path === "/api/preferences/last-model") {
        throw new Error("Preference network failure");
      }

      if (method === "PUT" && path === "/api/preferences/last-directory") {
        return jsonResponse({ success: true });
      }

      if (method === "POST" && path === "/api/tasks/draft-1/draft/start") {
        return jsonResponse({ success: true });
      }

      throw new Error(`Unexpected request: ${method} ${path}`);
    }) as typeof globalThis.fetch;
    window.fetch = globalThis.fetch;

    const onRefresh = mock(async () => {});
    const toast = { error: mock((_message: string) => {}) };

    const result = await handleCreateTaskSubmit(
      {
        workspaces: [createWorkspace({ id: "ws-1", directory: "/workspaces/project-a" })],
        setLastModel: mock(() => {}),
        setLastCheapModel: mock(() => {}),
        setUncommittedModal: mock(() => {}),
        onRefresh,
        onCreateTask: mock(async () => ({ task: null })),
      },
      createTaskWithStatus("draft", {
        config: {
          id: "draft-1",
          name: "Existing Draft",
          workspaceId: "ws-1",
          directory: "/workspaces/project-a",
          prompt: "Ship the feature",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
            variant: "",
          },
        },
      }),
      {
        name: "Existing Draft",
        workspaceId: "ws-1",
        prompt: "Ship the feature",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
          variant: "",
        },
        draft: false,
        planMode: false,
        useWorktree: true,
        clearPlanningFolder: false,
        attachments: [],
        cheapModel: { mode: "same-as-task" },
        maxIterations: null,
        maxConsecutiveErrors: DEFAULT_TASK_CONFIG.maxConsecutiveErrors,
        activityTimeoutSeconds: DEFAULT_TASK_CONFIG.activityTimeoutSeconds,
        stopPattern: DEFAULT_TASK_CONFIG.stopPattern,
        git: {
          branchPrefix: DEFAULT_TASK_CONFIG.git.branchPrefix,
          commitScope: DEFAULT_TASK_CONFIG.git.commitScope,
        },
        baseBranch: "",
        autoAcceptPlan: false,
        fullyAutonomous: false,
      },
      toast,
    );

    expect(result).toBe(true);
    await waitFor(() => {
      expect(fetchCalls).toContain("POST /api/tasks/draft-1/draft/start");
      expect(onRefresh).toHaveBeenCalledTimes(2);
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("clanky.taskModelPreference")).toBe(
      JSON.stringify({
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
        variant: "",
      }),
    );
    expect(window.localStorage.getItem("clanky.taskCheapModelPreference")).toBe(
      JSON.stringify({ mode: "same-as-task" }),
    );
  });

  test("persists local task defaults after a successful create", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const path = new URL(requestUrl, window.location.origin).pathname;

      if (method === "PUT" && path.startsWith("/api/preferences/")) {
        return jsonResponse({ success: true });
      }

      throw new Error(`Unexpected request: ${method} ${path}`);
    }) as typeof globalThis.fetch;
    window.fetch = globalThis.fetch;

    const result = await handleCreateTaskSubmit(
      {
        workspaces: [createWorkspace({ id: "ws-1", directory: "/workspaces/project-a" })],
        setLastModel: mock(() => {}),
        setLastCheapModel: mock(() => {}),
        setUncommittedModal: mock(() => {}),
        onRefresh: mock(async () => {}),
        onCreateTask: mock(async () => ({
          task: createTaskWithStatus("starting", {
            config: {
              id: "task-1",
              workspaceId: "ws-1",
              directory: "/workspaces/project-a",
            },
          }),
        })),
      },
      null,
      {
        name: "New Task",
        workspaceId: "ws-1",
        prompt: "Ship the feature",
        model: {
          providerID: "openai",
          modelID: "gpt-4o",
          variant: "",
        },
        draft: false,
        planMode: false,
        useWorktree: true,
        clearPlanningFolder: false,
        attachments: [],
        cheapModel: {
          mode: "custom",
          model: {
            providerID: "anthropic",
            modelID: "claude-haiku-4-5",
            variant: "",
          },
        },
        maxIterations: null,
        maxConsecutiveErrors: DEFAULT_TASK_CONFIG.maxConsecutiveErrors,
        activityTimeoutSeconds: DEFAULT_TASK_CONFIG.activityTimeoutSeconds,
        stopPattern: DEFAULT_TASK_CONFIG.stopPattern,
        git: {
          branchPrefix: DEFAULT_TASK_CONFIG.git.branchPrefix,
          commitScope: DEFAULT_TASK_CONFIG.git.commitScope,
        },
        baseBranch: "main",
        autoAcceptPlan: false,
        fullyAutonomous: false,
      },
      { error: mock((_message: string) => {}) },
    );

    expect(result).toBe(true);
    expect(window.localStorage.getItem("clanky.taskModelPreference")).toBe(
      JSON.stringify({
        providerID: "openai",
        modelID: "gpt-4o",
        variant: "",
      }),
    );
    expect(window.localStorage.getItem("clanky.taskCheapModelPreference")).toBe(
      JSON.stringify({
        mode: "custom",
        model: {
          providerID: "anthropic",
          modelID: "claude-haiku-4-5",
          variant: "",
        },
      }),
    );
  });
});
