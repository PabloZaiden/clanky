import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderWithUser, waitFor } from "../helpers/render";
import { createWorkspace } from "../helpers/factories";

let mockedGitHubUrl: string | null = null;

mock.module("@/components/app-shell/use-workspace-github-url", () => ({
  useWorkspaceGitHubUrl: () => mockedGitHubUrl,
}));

import { WorkspaceView } from "@/components/app-shell/workspace-view";

describe("WorkspaceView", () => {
  beforeEach(() => {
    mockedGitHubUrl = null;
  });

  test("shows an Open in GitHub action when the workspace has a GitHub URL", async () => {
    mockedGitHubUrl = "https://github.com/owner/repo";

    const openCalls: Array<{ url: string | URL | undefined; target: string | undefined; features: string | undefined }> = [];
    const originalWindowOpen = window.open;
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      openCalls.push({ url, target, features });
      return null;
    }) as typeof window.open;

    try {
      const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
      const { getByRole, user } = renderWithUser(
        <WorkspaceView
          workspace={workspace}
          relatedLoops={[]}
          relatedChats={[]}
          relatedSessions={[]}
          registeredSshServers={[]}
          onOpenSettings={() => {}}
          onNavigate={() => {}}
        />,
      );

      await user.click(getByRole("button", { name: "Create items in workspace Frontend" }));

      await waitFor(() => {
        expect(getByRole("menuitem", { name: "Open in GitHub" })).toBeTruthy();
      });

      await user.click(getByRole("menuitem", { name: "Open in GitHub" }));

      expect(openCalls).toEqual([
        {
          url: "https://github.com/owner/repo",
          target: "_blank",
          features: "noopener,noreferrer",
        },
      ]);
    } finally {
      window.open = originalWindowOpen;
    }
  });

  test("hides the Open in GitHub action when the workspace has no GitHub URL", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Frontend", directory: "/workspaces/frontend" });
    const { getByRole, queryByRole, user } = renderWithUser(
      <WorkspaceView
        workspace={workspace}
        relatedLoops={[]}
        relatedChats={[]}
        relatedSessions={[]}
        registeredSshServers={[]}
        onOpenSettings={() => {}}
        onNavigate={() => {}}
      />,
    );

    await user.click(getByRole("button", { name: "Create items in workspace Frontend" }));

    expect(queryByRole("menuitem", { name: "Open in GitHub" })).toBeNull();
  });
});
