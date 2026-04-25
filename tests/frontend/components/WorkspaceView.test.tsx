import { describe, expect, test } from "bun:test";
import { renderWithUser, waitFor } from "../helpers/render";
import { createLoop, createWorkspace } from "../helpers/factories";

import { WorkspaceView } from "@/components/app-shell/workspace-view";

describe("WorkspaceView", () => {
  test("shows an Open in GitHub action when the workspace has a GitHub URL", async () => {
    const openCalls: Array<{ url: string | URL | undefined; target: string | undefined; features: string | undefined }> = [];
    const originalWindowOpen = window.open;
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      openCalls.push({ url, target, features });
      return null;
    }) as typeof window.open;

    try {
      const workspace = createWorkspace({
        id: "workspace-1",
        name: "Frontend",
        directory: "/workspaces/frontend",
        repoUrl: "https://github.com/owner/repo.git",
      });
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
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
      repoUrl: "https://gitlab.com/owner/repo.git",
    });
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

  test("renders plan-ready loop pills with the shared plan-ready badge variant", () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
    });
    const planReadyLoop = createLoop({
      config: {
        workspaceId: workspace.id,
        name: "Review generated plan",
      },
      state: {
        status: "planning",
        planMode: {
          active: true,
          feedbackRounds: 1,
          planningFolderCleared: false,
          isPlanReady: true,
        },
      },
    });

    const { getByText } = renderWithUser(
      <WorkspaceView
        workspace={workspace}
        relatedLoops={[planReadyLoop]}
        relatedChats={[]}
        relatedSessions={[]}
        registeredSshServers={[]}
        onOpenSettings={() => {}}
        onNavigate={() => {}}
      />,
    );

    const pill = getByText("Plan Ready");
    expect(pill.getAttribute("data-badge-variant")).toBe("plan_ready");
  });
});
