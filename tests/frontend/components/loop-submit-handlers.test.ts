import { afterEach, describe, expect, mock, test } from "bun:test";
import { handleCreateLoopSubmit } from "@/components/dashboard-modals/loop-submit-handlers";
import { createLoopWithStatus, createWorkspace } from "../helpers/factories";

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

describe("handleCreateLoopSubmit", () => {
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

      if (method === "PUT" && path === "/api/loops/draft-1") {
        return jsonResponse({ success: true });
      }

      if (method === "PUT" && path === "/api/preferences/last-model") {
        throw new Error("Preference network failure");
      }

      if (method === "PUT" && path === "/api/preferences/last-directory") {
        return jsonResponse({ success: true });
      }

      if (method === "POST" && path === "/api/loops/draft-1/draft/start") {
        return jsonResponse({ success: true });
      }

      throw new Error(`Unexpected request: ${method} ${path}`);
    }) as typeof globalThis.fetch;
    window.fetch = globalThis.fetch;

    const onRefresh = mock(async () => {});
    const toast = { error: mock((_message: string) => {}) };

    const result = await handleCreateLoopSubmit(
      {
        workspaces: [createWorkspace({ id: "ws-1", directory: "/workspaces/project-a" })],
        setLastModel: mock(() => {}),
        setLastCheapModel: mock(() => {}),
        setUncommittedModal: mock(() => {}),
        onRefresh,
        onCreateLoop: mock(async () => ({ loop: null })),
      },
      createLoopWithStatus("draft", {
        config: {
          id: "draft-1",
          name: "Existing Draft",
          workspaceId: "ws-1",
          directory: "/workspaces/project-a",
          prompt: "Ship the feature",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
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
        },
        draft: false,
        planMode: false,
        useWorktree: true,
        clearPlanningFolder: false,
        attachments: [],
      },
      toast,
    );

    expect(result).toBe(true);
    expect(fetchCalls).toContain("POST /api/loops/draft-1/draft/start");
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
