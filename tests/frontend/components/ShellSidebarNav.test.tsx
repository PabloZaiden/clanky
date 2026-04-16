import { describe, expect, mock, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { useState } from "react";
import type { Chat } from "@/types/chat";
import type { SshServer, SshServerSession } from "@/types/ssh-server";
import { ShellSidebarNav } from "@/components/app-shell/shell-sidebar-nav";
import { buildServerSidebarNodes, buildWorkspaceSidebarGroups, type ShellRoute } from "@/components/app-shell/shell-types";
import { createLoop, createSshSession, createWorkspace } from "../helpers/factories";
import { renderWithUser } from "../helpers/render";

function createChat(overrides?: {
  config?: Partial<Chat["config"]>;
  state?: Partial<Chat["state"]>;
}): Chat {
  return {
    config: {
      id: overrides?.config?.id ?? "chat-1",
      name: overrides?.config?.name ?? "Workspace Chat",
      workspaceId: overrides?.config?.workspaceId ?? "workspace-1",
      directory: overrides?.config?.directory ?? "/workspaces/workspace-1",
      model: overrides?.config?.model ?? {
        providerID: "copilot",
        modelID: "gpt-5.4",
        variant: "",
      },
      useWorktree: overrides?.config?.useWorktree ?? true,
      createdAt: overrides?.config?.createdAt ?? "2026-04-16T10:00:00.000Z",
      updatedAt: overrides?.config?.updatedAt ?? "2026-04-16T10:00:00.000Z",
      mode: "chat",
      ...overrides?.config,
    },
    state: {
      id: overrides?.state?.id ?? overrides?.config?.id ?? "chat-1",
      status: overrides?.state?.status ?? "idle",
      messages: overrides?.state?.messages ?? [],
      logs: overrides?.state?.logs ?? [],
      toolCalls: overrides?.state?.toolCalls ?? [],
      ...overrides?.state,
    },
  };
}

function createSshServer(overrides?: Partial<SshServer>): SshServer {
  return {
    config: {
      id: overrides?.config?.id ?? "server-1",
      name: overrides?.config?.name ?? "Server 1",
      address: overrides?.config?.address ?? "server.example.com",
      username: overrides?.config?.username ?? "ubuntu",
      repositoriesBasePath: overrides?.config?.repositoriesBasePath ?? null,
      createdAt: overrides?.config?.createdAt ?? "2026-04-16T09:00:00.000Z",
      updatedAt: overrides?.config?.updatedAt ?? "2026-04-16T09:00:00.000Z",
      ...overrides?.config,
    },
    publicKey: {
      algorithm: overrides?.publicKey?.algorithm ?? "RSA-OAEP-256",
      publicKey: overrides?.publicKey?.publicKey ?? "public-key",
      fingerprint: overrides?.publicKey?.fingerprint ?? "fingerprint",
      version: overrides?.publicKey?.version ?? 1,
      createdAt: overrides?.publicKey?.createdAt ?? "2026-04-16T09:00:00.000Z",
      ...overrides?.publicKey,
    },
  };
}

function createStandaloneServerSession(overrides?: Partial<SshServerSession>): SshServerSession {
  return {
    config: {
      id: overrides?.config?.id ?? "server-session-1",
      name: overrides?.config?.name ?? "Standalone Server Session",
      connectionMode: overrides?.config?.connectionMode ?? "dtach",
      remoteSessionName: overrides?.config?.remoteSessionName ?? "server-session-1",
      sshServerId: overrides?.config?.sshServerId ?? "server-1",
      createdAt: overrides?.config?.createdAt ?? "2026-04-16T12:00:00.000Z",
      updatedAt: overrides?.config?.updatedAt ?? "2026-04-16T12:00:00.000Z",
      ...overrides?.config,
    },
    state: {
      status: overrides?.state?.status ?? "connected",
      ...overrides?.state,
    },
  };
}

function createSidebarData() {
  const workspaces = [
    createWorkspace({
      id: "workspace-1",
      name: "Workspace 1",
      directory: "/workspaces/workspace-1",
      sshServerId: "server-1",
    }),
    createWorkspace({
      id: "workspace-2",
      name: "Workspace 2",
      directory: "/workspaces/workspace-2",
    }),
  ];
  const loops = [
    createLoop({
      config: {
        id: "loop-1",
        name: "Feature Loop",
        workspaceId: "workspace-1",
      },
      state: {
        status: "running",
      },
    }),
    createLoop({
      config: {
        id: "loop-2",
        name: "Loop With SSH",
        workspaceId: "workspace-1",
      },
      state: {
        status: "planning",
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: true,
        },
      },
    }),
    createLoop({
      config: {
        id: "loop-3",
        name: "Completed Loop",
        workspaceId: "workspace-1",
      },
      state: {
        status: "completed",
      },
    }),
  ];
  const chats = [
    createChat({
      config: {
        id: "chat-1",
        name: "Workspace Chat",
        workspaceId: "workspace-1",
      },
    }),
  ];
  const workspaceSessions = [
    createSshSession({
      config: {
        id: "workspace-session-1",
        name: "Loop SSH Session",
        workspaceId: "workspace-1",
        loopId: "loop-2",
        createdAt: "2026-04-16T11:00:00.000Z",
      },
      state: {
        status: "connected",
      },
    }),
    createSshSession({
      config: {
        id: "workspace-session-2",
        name: "Workspace SSH",
        workspaceId: "workspace-1",
        createdAt: "2026-04-16T11:30:00.000Z",
      },
      state: {
        status: "ready",
      },
    }),
  ];
  const servers = [createSshServer()];
  const sessionsByServerId = {
    "server-1": [
      createStandaloneServerSession(),
    ],
  };

  return {
    workspaces,
    workspaceGroups: buildWorkspaceSidebarGroups({
      workspaces,
      loops,
      chats,
      sessions: workspaceSessions,
    }),
    serverNodes: buildServerSidebarNodes({
      servers,
      sessionsByServerId,
      workspaces,
      workspaceSessions,
    }),
  };
}

function SidebarHarness({
  route,
  navigateWithinShell,
  workspaces: workspacesOverride,
  workspaceGroups: workspaceGroupsOverride,
  serverNodes: serverNodesOverride,
}: {
  route?: ShellRoute;
  navigateWithinShell?: (route: ShellRoute) => void;
  workspaces?: ReturnType<typeof createSidebarData>["workspaces"];
  workspaceGroups?: ReturnType<typeof createSidebarData>["workspaceGroups"];
  serverNodes?: ReturnType<typeof createSidebarData>["serverNodes"];
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const { workspaces, workspaceGroups, serverNodes } = createSidebarData();

  return (
    <ShellSidebarNav
      route={route ?? { view: "home" }}
      sidebarOpen
      sidebarCollapsed={false}
      navigateWithinShell={navigateWithinShell ?? mock(() => {})}
      hideSidebar={mock(() => {})}
      isNodeCollapsed={(key) => collapsed[key] ?? false}
      toggleNodeCollapsed={(key) => setCollapsed((current) => ({ ...current, [key]: !(current[key] ?? false) }))}
      workspaces={workspacesOverride ?? workspaces}
      workspaceGroups={workspaceGroupsOverride ?? workspaceGroups}
      serverNodes={serverNodesOverride ?? serverNodes}
      version="test"
    />
  );
}

describe("ShellSidebarNav", () => {
  test("renders the workspace and server trees with active and all groups", () => {
    const { getAllByText, getByText } = renderWithUser(<SidebarHarness />);

    expect(getByText("Active")).toBeInTheDocument();
    expect(getByText("All")).toBeInTheDocument();
    expect(getAllByText("Workspace 1")).toHaveLength(2);
    expect(getByText("Workspace 2")).toBeInTheDocument();
    expect(getAllByText("Feature Loop")).toHaveLength(2);
    expect(getByText("Server 1")).toBeInTheDocument();
    expect(getByText("Standalone Server Session")).toBeInTheDocument();
  });

  test("moves terminal-state loops into per-workspace history groups", () => {
    const sidebarData = createSidebarData();
    const activeWorkspace = sidebarData.workspaceGroups
      .find((group) => group.key === "active")
      ?.workspaces.find((workspaceNode) => workspaceNode.workspace.id === "workspace-1");

    expect(activeWorkspace?.loops.map((loopNode) => loopNode.title)).toEqual(["Feature Loop", "Loop With SSH"]);
    expect(activeWorkspace?.historyLoops.map((loopNode) => loopNode.title)).toEqual(["Completed Loop"]);

    const { getAllByText } = renderWithUser(
      <SidebarHarness workspaceGroups={sidebarData.workspaceGroups} />,
    );

    expect(getAllByText("History")).toHaveLength(2);
    expect(getAllByText("Completed Loop")).toHaveLength(2);
  });

  test("collapses groups and routes scoped new actions", async () => {
    const navigateWithinShell = mock((_route: ShellRoute) => {});
    const { getAllByRole, getAllByText, getByRole, user } = renderWithUser(
      <SidebarHarness navigateWithinShell={navigateWithinShell} />,
    );

    expect(getAllByText("Workspace 1")).toHaveLength(2);

    const [activeButtonLabel] = getAllByText("Active");
    expect(activeButtonLabel).toBeDefined();
    await user.click(getByTextButton(activeButtonLabel!));
    expect(getAllByText("Workspace 1")).toHaveLength(1);

    await user.click(getByRole("button", { name: "New Workspaces" }));
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "compose", kind: "workspace" });

    await user.click(getByRole("button", { name: "New SSH servers" }));
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "compose", kind: "ssh-server" });

    await user.click(getByRole("button", { name: "New Sessions" }));
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "compose", kind: "ssh-session", scopeId: "server-1" });

    await user.click(getAllByRole("button", { name: "New Loops" })[0]!);
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "compose", kind: "loop", scopeId: "workspace-1" });
  });

  test("hides empty workspace groups", () => {
    const workspaces = [
      createWorkspace({
        id: "workspace-empty",
        name: "Empty Workspace",
        directory: "/workspaces/empty",
      }),
    ];
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces,
      loops: [],
      chats: [],
      sessions: [],
    });
    const { getByText, queryByText } = renderWithUser(
      <SidebarHarness workspaces={workspaces} workspaceGroups={workspaceGroups} />,
    );

    expect(queryByText("Active")).not.toBeInTheDocument();
    expect(getByText("All")).toBeInTheDocument();
    expect(getByText("Empty Workspace")).toBeInTheDocument();
  });

  test("hides the all group when there are no workspaces", () => {
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces: [],
      loops: [],
      chats: [],
      sessions: [],
    });
    const { queryByText } = renderWithUser(
      <SidebarHarness workspaces={[]} workspaceGroups={workspaceGroups} />,
    );

    expect(queryByText("Active")).not.toBeInTheDocument();
    expect(queryByText("All")).not.toBeInTheDocument();
  });

  test("supports in-app navigation and modified-click new-tab navigation", () => {
    const navigateWithinShell = mock((_route: ShellRoute) => {});
    const openSpy = mock(() => null);
    const originalOpen = window.open;
    window.open = openSpy as typeof window.open;

    try {
      const { getAllByText } = renderWithUser(
        <SidebarHarness navigateWithinShell={navigateWithinShell} />,
      );

      const [loopLabel] = getAllByText("Feature Loop");
      expect(loopLabel).toBeDefined();
      const loopButton = getByTextButton(loopLabel!);
      fireEvent.click(loopButton);
      expect(navigateWithinShell).toHaveBeenCalledWith({ view: "loop", loopId: "loop-1" });

      fireEvent.click(loopButton, { ctrlKey: true });
      expect(openSpy).toHaveBeenCalledWith(
        "http://localhost:3000/#/loop/loop-1",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      window.open = originalOpen;
    }
  });
});

function getByTextButton(node: HTMLElement): HTMLButtonElement {
  const button = node.closest("button");
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}
