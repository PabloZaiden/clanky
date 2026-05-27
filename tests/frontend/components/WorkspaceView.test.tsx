import { describe, expect, test } from "bun:test";
import { renderWithUser, waitFor } from "../helpers/render";
import { createTask, createWorkspace } from "../helpers/factories";

import { WorkspaceView } from "@/components/app-shell/workspace-view";
import { EMPTY_SIDEBAR_PINNING_STATE } from "@/components/app-shell/sidebar-pins";

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
          relatedTasks={[]}
          relatedChats={[]}
          relatedSessions={[]}
          registeredSshServers={[]}
          onOpenSettings={() => {}}
          onPullLatestChanges={async () => ({ success: true })}
          pullingLatestChanges={false}
          onNavigate={() => {}}
          sidebarPinning={EMPTY_SIDEBAR_PINNING_STATE}
        />,
      );

      await user.click(getByRole("button", { name: "Workspace actions for Frontend" }));

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
        relatedTasks={[]}
        relatedChats={[]}
        relatedSessions={[]}
        registeredSshServers={[]}
        onOpenSettings={() => {}}
        onPullLatestChanges={async () => ({ success: true })}
        pullingLatestChanges={false}
        onNavigate={() => {}}
        sidebarPinning={EMPTY_SIDEBAR_PINNING_STATE}
      />,
    );

    await user.click(getByRole("button", { name: "Workspace actions for Frontend" }));

    expect(queryByRole("menuitem", { name: "Open in GitHub" })).toBeNull();
  });

  test("renders plan-ready task pills with the shared plan-ready badge variant", () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
    });
    const planReadyTask = createTask({
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
        relatedTasks={[planReadyTask]}
        relatedChats={[]}
        relatedSessions={[]}
        registeredSshServers={[]}
        onOpenSettings={() => {}}
        onPullLatestChanges={async () => ({ success: true })}
        pullingLatestChanges={false}
        onNavigate={() => {}}
        sidebarPinning={EMPTY_SIDEBAR_PINNING_STATE}
      />,
    );

    const pill = getByText("Plan Ready");
    expect(pill.getAttribute("data-badge-variant")).toBe("plan_ready");
  });

  test("runs pull latest from the workspace actions menu", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
    });
    let callCount = 0;

    const { getByRole, user } = renderWithUser(
      <WorkspaceView
        workspace={workspace}
        relatedTasks={[]}
        relatedChats={[]}
        relatedSessions={[]}
        registeredSshServers={[]}
        onOpenSettings={() => {}}
        onPullLatestChanges={() => {
          callCount += 1;
        }}
        pullingLatestChanges={false}
        onNavigate={() => {}}
        sidebarPinning={EMPTY_SIDEBAR_PINNING_STATE}
      />,
    );

    await user.click(getByRole("button", { name: "Workspace actions for Frontend" }));
    await user.click(getByRole("menuitem", { name: "Pull Latest Changes" }));

    expect(callCount).toBe(1);
  });

  test("places pinning last in the workspace actions menu", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
    });

    const { getAllByRole, getByRole, user } = renderWithUser(
      <WorkspaceView
        workspace={workspace}
        relatedTasks={[]}
        relatedChats={[]}
        relatedSessions={[]}
        registeredSshServers={[]}
        onOpenSettings={() => {}}
        onPullLatestChanges={() => {}}
        pullingLatestChanges={false}
        onNavigate={() => {}}
        sidebarPinning={EMPTY_SIDEBAR_PINNING_STATE}
      />,
    );

    await user.click(getByRole("button", { name: "Workspace actions for Frontend" }));

    expect(getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "New Task",
      "New Chat",
      "Open code explorer",
      "Pull Latest Changes",
      "Pin to sidebar",
    ]);
  });

  test("disables the pull latest action while pending", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
    });
    let callCount = 0;

    const { getByRole, user } = renderWithUser(
      <WorkspaceView
        workspace={workspace}
        relatedTasks={[]}
        relatedChats={[]}
        relatedSessions={[]}
        registeredSshServers={[]}
        onOpenSettings={() => {}}
        onPullLatestChanges={() => {
          callCount += 1;
        }}
        pullingLatestChanges
        onNavigate={() => {}}
        sidebarPinning={EMPTY_SIDEBAR_PINNING_STATE}
      />,
    );

    await user.click(getByRole("button", { name: "Workspace actions for Frontend" }));
    const pullItem = getByRole("menuitem", { name: "Pulling Latest Changes..." }) as HTMLButtonElement;

    expect(pullItem.disabled).toBe(true);
    await user.click(pullItem);
    expect(callCount).toBe(0);
  });
});
