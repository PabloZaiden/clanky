import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_LOOP_CONFIG } from "../../src/types/loop";
import type { CreateLoopRequest } from "../../src/types";
import { startDraftLoop } from "../../src/lib/draft-loop-start";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createRequest(overrides: Partial<CreateLoopRequest> = {}): CreateLoopRequest {
  return {
    name: "Draft Loop",
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
    cheapModel: { mode: "same-as-loop" },
    maxIterations: null,
    maxConsecutiveErrors: DEFAULT_LOOP_CONFIG.maxConsecutiveErrors,
    activityTimeoutSeconds: DEFAULT_LOOP_CONFIG.activityTimeoutSeconds,
    stopPattern: DEFAULT_LOOP_CONFIG.stopPattern,
    git: {
      branchPrefix: DEFAULT_LOOP_CONFIG.git.branchPrefix,
      commitScope: DEFAULT_LOOP_CONFIG.git.commitScope,
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

describe("startDraftLoop", () => {
  test("surfaces the server message for non-uncommitted 409 responses", async () => {
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse({
      error: "draft_start_blocked",
      message: "Draft cannot be started right now.",
    }, 409)) as typeof globalThis.fetch;
    window.fetch = globalThis.fetch;

    const result = await startDraftLoop({
      loopId: "draft-1",
      request: createRequest(),
      onRefresh: async () => {},
    });

    expect(result).toEqual({
      status: "failed",
      message: "Draft cannot be started right now.",
    });
  });
});
