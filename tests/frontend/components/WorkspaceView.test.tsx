import { describe, expect, test } from "bun:test";
import { renderWithUser, waitFor, within } from "../helpers/render";
import { createLoopWithStatus, createWorkspace } from "../helpers/factories";

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

  test("moves merged and deleted loops into the history card", () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
    });
    const runningLoop = createLoopWithStatus("running", {
      config: { id: "loop-running", name: "Active Loop", workspaceId: workspace.id, directory: workspace.directory },
    });
    const pushedLoop = createLoopWithStatus("pushed", {
      config: { id: "loop-pushed", name: "Pushed Loop", workspaceId: workspace.id, directory: workspace.directory },
    });
    const mergedLoop = createLoopWithStatus("merged", {
      config: { id: "loop-merged", name: "Merged Loop", workspaceId: workspace.id, directory: workspace.directory },
    });
    const deletedLoop = createLoopWithStatus("deleted", {
      config: { id: "loop-deleted", name: "Deleted Loop", workspaceId: workspace.id, directory: workspace.directory },
    });

    const { getByTestId } = renderWithUser(
      <WorkspaceView
        workspace={workspace}
        relatedLoops={[runningLoop, pushedLoop, mergedLoop, deletedLoop]}
        relatedChats={[]}
        relatedSessions={[]}
        registeredSshServers={[]}
        onOpenSettings={() => {}}
        onNavigate={() => {}}
      />,
    );

    const activityCard = getByTestId("workspace-activity-card");
    const historyCard = getByTestId("workspace-history-card");

    expect(within(activityCard).getByText("Active Loop")).toBeTruthy();
    expect(within(activityCard).getByText("Pushed Loop")).toBeTruthy();
    expect(within(activityCard).queryByText("Merged Loop")).toBeNull();
    expect(within(activityCard).queryByText("Deleted Loop")).toBeNull();

    expect(within(historyCard).getByText("Merged Loop")).toBeTruthy();
    expect(within(historyCard).getByText("Deleted Loop")).toBeTruthy();
    expect(within(historyCard).queryByText("Active Loop")).toBeNull();
    expect(within(historyCard).queryByText("Pushed Loop")).toBeNull();
  });
});
