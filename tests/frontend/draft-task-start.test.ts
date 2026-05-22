import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_TASK_CONFIG } from "../../src/types/task";
import type { CreateTaskRequest } from "../../src/types";
import { startDraftTask } from "../../src/lib/draft-task-start";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createRequest(overrides: Partial<CreateTaskRequest> = {}): CreateTaskRequest {
  return {
    name: "Draft Task",
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
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.fetch = originalFetch;
});

describe("startDraftTask", () => {
  test("surfaces the server message for non-uncommitted 409 responses", async () => {
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
      error: "draft_start_blocked",
      message: "Draft cannot be started right now.",
    }, 409)) as typeof globalThis.fetch;
    window.fetch = globalThis.fetch;

    const result = await startDraftTask({
      taskId: "draft-1",
      request: createRequest(),
      onRefresh: async () => {},
    });

    expect(result).toEqual({
      status: "failed",
      message: "Draft cannot be started right now.",
    });
  });
});
