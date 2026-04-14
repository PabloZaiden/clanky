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

describe("DraftLoopComposer", () => {
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
  });
});
