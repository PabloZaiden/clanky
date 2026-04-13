import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createMockApi } from "../helpers/mock-api";
import { createWorkspace } from "../helpers/factories";
import { useWorkspaceGitHubUrl } from "@/components/app-shell/use-workspace-github-url";

const api = createMockApi();

beforeEach(() => {
  api.reset();
  api.install();
});

afterEach(() => {
  api.uninstall();
});

describe("useWorkspaceGitHubUrl", () => {
  test("ignores aborted non-ok responses from a previous request when the workspace directory changes", async () => {
    const initialWorkspace = createWorkspace({
      id: "workspace-1",
      directory: "/workspaces/manual-a",
      repoUrl: undefined,
    });
    const nextWorkspace = createWorkspace({
      id: "workspace-1",
      directory: "/workspaces/manual-b",
      repoUrl: undefined,
    });
    const firstResponse = Promise.withResolvers<Response>();
    const secondResponse = Promise.withResolvers<Response>();
    const originalFetch = globalThis.fetch;
    const originalWindowFetch = window.fetch;
    let requestCount = 0;

    const fetchMock = (async () => {
      requestCount += 1;
      return requestCount === 1
        ? firstResponse.promise
        : secondResponse.promise;
    }) as unknown as typeof fetch;

    globalThis.fetch = fetchMock;
    window.fetch = fetchMock;

    try {
      const { result, rerender } = renderHook(
        ({ workspace }) => useWorkspaceGitHubUrl(workspace),
        { initialProps: { workspace: initialWorkspace } },
      );

      await waitFor(() => {
        expect(requestCount).toBe(1);
      });

      rerender({ workspace: nextWorkspace });

      await waitFor(() => {
        expect(requestCount).toBe(2);
      });

      await act(async () => {
        secondResponse.resolve(new Response(JSON.stringify({
          githubUrl: "https://github.com/owner/repo",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
        await secondResponse.promise;
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current).toBe("https://github.com/owner/repo");
      });

      await act(async () => {
        firstResponse.resolve(new Response(JSON.stringify({
          githubUrl: null,
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }));
        await firstResponse.promise;
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current).toBe("https://github.com/owner/repo");
      });
    } finally {
      globalThis.fetch = originalFetch;
      window.fetch = originalWindowFetch;
    }
  });

  test("does not fetch when the workspace has an explicit non-GitHub repoUrl", () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      directory: "/workspaces/non-github",
      repoUrl: "https://gitlab.com/owner/repo.git",
    });

    const { result } = renderHook(() => useWorkspaceGitHubUrl(workspace));

    expect(result.current).toBeNull();
    expect(api.calls("/api/git/github-repository-url", "GET")).toHaveLength(0);
  });

  test("does not expose the previous workspace GitHub URL while switching workspaces", async () => {
    api.get("/api/git/github-repository-url", () => new Promise(() => {}));

    const initialWorkspace = createWorkspace({
      id: "workspace-1",
      directory: "/workspaces/github",
      repoUrl: "https://github.com/owner/repo.git",
    });
    const nextWorkspace = createWorkspace({
      id: "workspace-2",
      directory: "/workspaces/manual",
      repoUrl: undefined,
    });

    const { result, rerender } = renderHook(
      ({ workspace }) => useWorkspaceGitHubUrl(workspace),
      { initialProps: { workspace: initialWorkspace } },
    );

    expect(result.current).toBe("https://github.com/owner/repo");

    rerender({ workspace: nextWorkspace });

    expect(result.current).toBeNull();

    await waitFor(() => {
      expect(api.calls("/api/git/github-repository-url", "GET")).toHaveLength(1);
    });
  });
});
