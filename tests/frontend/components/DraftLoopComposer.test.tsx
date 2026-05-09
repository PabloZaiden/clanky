import { afterEach, describe, expect, mock, test } from "bun:test";
import { DraftLoopComposer } from "@/components/app-shell/draft-loop-composer";
import { renderWithUser, waitFor } from "../helpers/render";
import {
  createBranchInfo,
  createLoopWithStatus,
  createModelInfo,
  createWorkspace,
} from "../helpers/factories";

const originalFetch = globalThis.fetch;
const LOOP_MODEL_STORAGE_KEY = "ralpher.loopModelPreference";
const LOOP_CHEAP_MODEL_STORAGE_KEY = "ralpher.loopCheapModelPreference";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.fetch = originalFetch;
  window.localStorage.removeItem(LOOP_MODEL_STORAGE_KEY);
  window.localStorage.removeItem(LOOP_CHEAP_MODEL_STORAGE_KEY);
});

describe("DraftLoopComposer", () => {
  test("navigates away immediately when starting a draft", async () => {
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

      if (method === "PUT" && path === "/api/loops/draft-1") {
        return await new Promise<Response>((resolve) => {
          pendingDraftUpdate.resolve = resolve;
        });
      }

      if (method === "POST" && path === "/api/loops/draft-1/draft/start") {
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

    const onRefresh = mock(async () => {});
    const onNavigate = mock((_route: unknown) => {});

    const loop = createLoopWithStatus("draft", {
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
    });

    const { getByRole, user } = renderWithUser(
      <DraftLoopComposer
        loop={loop}
        workspaces={[createWorkspace({ id: "ws-1", directory: "/workspaces/project-a" })]}
        models={[
          createModelInfo({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
            connected: true,
          }),
        ]}
        modelsLoading={false}
        lastModel={null}
        lastCheapModel={null}
        setLastModel={mock(() => {})}
        setLastCheapModel={mock(() => {})}
        onWorkspaceChange={mock(() => {})}
        planningWarning={null}
        branches={[createBranchInfo({ name: "main", current: true })]}
        branchesLoading={false}
        currentBranch="main"
        defaultBranch="main"
        workspaceError={null}
        workspacesLoading={false}
        onRefresh={onRefresh}
        onDeleteDraft={mock(async () => true)}
        onNavigate={onNavigate}
      />
    );

    await waitFor(() => {
      expect(getByRole("button", { name: "Start" })).toBeEnabled();
    });

    await user.click(getByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith({
        view: "workspace",
        workspaceId: "ws-1",
      });
    });

    pendingDraftUpdate.resolve(jsonResponse({ success: true }));
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    pendingDraftStart.resolve(jsonResponse({ success: true }));
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(2);
    });
  });

  test("keeps draft updates successful when preference persistence fails", async () => {
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

      if (method === "PUT" && path === "/api/preferences/last-cheap-model") {
        return jsonResponse({ success: true });
      }

      if (method === "PUT" && path === "/api/preferences/last-directory") {
        return jsonResponse({ success: true });
      }

      throw new Error(`Unexpected request: ${method} ${path}`);
    }) as typeof globalThis.fetch;
    window.fetch = globalThis.fetch;

    const onRefresh = mock(async () => {});

    const loop = createLoopWithStatus("draft", {
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
    });

    const { getByRole, queryByText, user } = renderWithUser(
      <DraftLoopComposer
        loop={loop}
        workspaces={[createWorkspace({ id: "ws-1", directory: "/workspaces/project-a" })]}
        models={[
          createModelInfo({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
            connected: true,
          }),
        ]}
        modelsLoading={false}
        lastModel={null}
        lastCheapModel={null}
        setLastModel={mock(() => {})}
        setLastCheapModel={mock(() => {})}
        onWorkspaceChange={mock(() => {})}
        planningWarning={null}
        branches={[createBranchInfo({ name: "main", current: true })]}
        branchesLoading={false}
        currentBranch="main"
        defaultBranch="main"
        workspaceError={null}
        workspacesLoading={false}
        onRefresh={onRefresh}
        onDeleteDraft={mock(async () => true)}
        onNavigate={mock(() => {})}
      />
    );

    await waitFor(() => {
      expect(getByRole("button", { name: "Update" })).toBeEnabled();
    });

    await user.click(getByRole("button", { name: "Update" }));

    await waitFor(() => {
      expect(fetchCalls).toContain("PUT /api/loops/draft-1");
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    expect(queryByText("Failed to update draft")).toBeNull();
    expect(window.localStorage.getItem("ralpher.loopModelPreference")).toBe(
      JSON.stringify({
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
        variant: "",
      }),
    );
    expect(window.localStorage.getItem("ralpher.loopCheapModelPreference")).toBe(
      JSON.stringify({ mode: "same-as-loop" }),
    );
  });

  test("updates a draft without a selected model", async () => {
    const fetchCalls: string[] = [];
    let draftUpdateBody: Record<string, unknown> | null = null;
    window.localStorage.setItem(
      LOOP_MODEL_STORAGE_KEY,
      JSON.stringify({
        providerID: "stale",
        modelID: "stale-model",
        variant: "",
      }),
    );

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
        draftUpdateBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ success: true });
      }

      if (method === "PUT" && path === "/api/preferences/last-cheap-model") {
        return jsonResponse({ success: true });
      }

      if (method === "PUT" && path === "/api/preferences/last-directory") {
        return jsonResponse({ success: true });
      }

      throw new Error(`Unexpected request: ${method} ${path}`);
    }) as typeof globalThis.fetch;
    window.fetch = globalThis.fetch;

    const onRefresh = mock(async () => {});
    const setLastModel = mock((_model: unknown) => {});

    const loop = createLoopWithStatus("draft", {
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
    });

    const { getByRole, user } = renderWithUser(
      <DraftLoopComposer
        loop={loop}
        workspaces={[createWorkspace({ id: "ws-1", directory: "/workspaces/project-a" })]}
        models={[]}
        modelsLoading={false}
        lastModel={null}
        lastCheapModel={null}
        setLastModel={setLastModel}
        setLastCheapModel={mock(() => {})}
        onWorkspaceChange={mock(() => {})}
        planningWarning={null}
        branches={[createBranchInfo({ name: "main", current: true })]}
        branchesLoading={false}
        currentBranch="main"
        defaultBranch="main"
        workspaceError={null}
        workspacesLoading={false}
        onRefresh={onRefresh}
        onDeleteDraft={mock(async () => true)}
        onNavigate={mock(() => {})}
      />
    );

    await waitFor(() => {
      expect(getByRole("button", { name: "Update" })).toBeEnabled();
    });

    await user.click(getByRole("button", { name: "Update" }));

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    expect(draftUpdateBody).not.toBeNull();
    expect("model" in draftUpdateBody!).toBe(false);
    expect(fetchCalls).not.toContain("PUT /api/preferences/last-model");
    expect(setLastModel).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LOOP_MODEL_STORAGE_KEY)).toBe(
      JSON.stringify({
        providerID: "stale",
        modelID: "stale-model",
        variant: "",
      }),
    );
  });
});
