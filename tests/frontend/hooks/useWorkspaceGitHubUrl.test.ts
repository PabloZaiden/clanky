import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
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
