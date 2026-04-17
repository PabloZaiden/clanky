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
  workspaceGroups: workspaceGroupsOverride,
  serverNodes: serverNodesOverride,
}: {
  route?: ShellRoute;
  navigateWithinShell?: (route: ShellRoute) => void;
  workspaceGroups?: ReturnType<typeof createSidebarData>["workspaceGroups"];
  serverNodes?: ReturnType<typeof createSidebarData>["serverNodes"];
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const { workspaceGroups, serverNodes } = createSidebarData();

  return (
    <ShellSidebarNav
      route={route ?? { view: "home" }}
      sidebarOpen
      sidebarCollapsed={false}
      navigateWithinShell={navigateWithinShell ?? mock(() => {})}
      hideSidebar={mock(() => {})}
      isNodeCollapsed={(key) => collapsed[key] ?? false}
      toggleNodeCollapsed={(key) => setCollapsed((current) => ({ ...current, [key]: !(current[key] ?? false) }))}
      workspaceGroups={workspaceGroupsOverride ?? workspaceGroups}
      serverNodes={serverNodesOverride ?? serverNodes}
      version="test"
    />
  );
}

describe("ShellSidebarNav", () => {
  test("renders the workspace and server trees with active and inactive groups", () => {
    const { getAllByText, getByText } = renderWithUser(<SidebarHarness />);

    expect(getByText("Active")).toBeInTheDocument();
    expect(getByText("Inactive")).toBeInTheDocument();
    expect(getAllByText("Workspace 1")).toHaveLength(1);
    expect(getByText("Workspace 2")).toBeInTheDocument();
    expect(getAllByText("Feature Loop")).toHaveLength(1);
    expect(getByText("Server 1")).toBeInTheDocument();
    expect(getByText("Standalone Server Session")).toBeInTheDocument();
  });

  test("uses compact indentation and gutter spacing for nested sidebar rows", () => {
    const { getAllByText, getByText } = renderWithUser(<SidebarHarness />);

    const workspaceRow = getTreeRowForText(getAllByText("Workspace 1")[0]!);
    expect(workspaceRow.style.marginLeft).toBe("0.375rem");
    expect(workspaceRow.firstElementChild).toHaveClass("w-3");
    expect(getTreeToggleButton(getAllByText("Workspace 1")[0]!)).toHaveClass("-mx-1.5", "w-6");
    expect(getByTextButton(getAllByText("Workspace 1")[0]!)).toHaveClass("pl-0", "pr-3");

    const loopRow = getTreeRowForText(getAllByText("Feature Loop")[0]!);
    expect(loopRow.style.marginLeft).toBe("1.125rem");
    expect(loopRow.firstElementChild?.tagName).toBe("BUTTON");
    expect(getByTextButton(getAllByText("Feature Loop")[0]!)).toHaveClass("pl-0", "pr-3");

    const sessionRow = getTreeRowForText(getAllByText("Loop SSH Session")[0]!);
    expect(sessionRow.style.marginLeft).toBe("1.125rem");
    expect(sessionRow.firstElementChild?.tagName).toBe("BUTTON");
    expect(getByTextButton(getAllByText("Loop SSH Session")[0]!)).toHaveClass("pl-0", "pr-3");

    const chatRow = getTreeRowForText(getAllByText("Workspace Chat")[0]!);
    expect(chatRow.style.marginLeft).toBe("1.125rem");
    expect(chatRow.firstElementChild?.tagName).toBe("BUTTON");
    expect(getByTextButton(getAllByText("Workspace Chat")[0]!)).toHaveClass("pl-0", "pr-3");

    const serverRow = getTreeRowForText(getByText("Server 1"));
    expect(serverRow.style.marginLeft).toBe("0.375rem");
    expect(serverRow.firstElementChild).toHaveClass("w-3");
    expect(getTreeToggleButton(getByText("Server 1"))).toHaveClass("-mx-1.5", "w-6");

    const standaloneSessionRow = getTreeRowForText(getByText("Standalone Server Session"));
    expect(standaloneSessionRow.style.marginLeft).toBe("1.125rem");
    expect(standaloneSessionRow.firstElementChild?.tagName).toBe("BUTTON");
  });

  test("renders workspace SSH sessions only in the SSH sessions section, not nested under loops", () => {
    const { getAllByText, queryAllByText } = renderWithUser(<SidebarHarness />);

    expect(getAllByText("Loop SSH Session")).toHaveLength(2);
    expect(queryAllByText("Expand Loop With SSH")).toHaveLength(0);
  });

  test("keeps compact row padding for inactive rows while adding a slight inset to active rows", () => {
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces: [
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
      ],
      loops: [
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
        createLoop({
          config: {
            id: "loop-4",
            name: "Merged Loop",
            workspaceId: "workspace-1",
          },
          state: {
            status: "merged",
          },
        }),
      ],
      chats: [
        createChat({
          config: {
            id: "chat-1",
            name: "Workspace Chat",
            workspaceId: "workspace-1",
          },
        }),
      ],
      sessions: [
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
      ],
    });
    const { getAllByText, getByText } = renderWithUser(
      <SidebarHarness
        route={{ view: "workspace", workspaceId: "workspace-1" }}
        workspaceGroups={workspaceGroups}
      />,
    );

    const workspaceButton = getByTextButton(getAllByText("Workspace 1")[0]!);
    expect(workspaceButton).toHaveClass("pl-2", "pr-3");
    expect(workspaceButton).toHaveClass("border-gray-900", "bg-gray-900", "text-white");
    expect(getByTextButton(getAllByText("/workspaces/workspace-1")[0]!)).toBe(workspaceButton);

    const historyLoopButton = getByTextButton(getAllByText("Merged Loop")[0]!);
    expect(historyLoopButton).toHaveClass("pl-0", "pr-3");

    const standaloneServerButton = getByTextButton(getByText("Server 1"));
    expect(standaloneServerButton).toHaveClass("pl-0", "pr-3");
    expect(getByTextButton(getByText("ubuntu@server.example.com"))).toBe(standaloneServerButton);
  });

  test("applies the same active inset padding to selected standalone server rows", () => {
    const { getByText } = renderWithUser(
      <SidebarHarness route={{ view: "ssh-server", serverId: "server-1" }} />,
    );

    const standaloneServerButton = getByTextButton(getByText("Server 1"));
    expect(standaloneServerButton).toHaveClass("pl-2", "pr-3");
    expect(standaloneServerButton).toHaveClass("border-gray-900", "bg-gray-900");
  });

  test("does not render sidebar count pills for sections or server rows", () => {
    const { queryByText } = renderWithUser(<SidebarHarness />);

    expect(queryByText("2")).toBeNull();
    expect(queryByText("3")).toBeNull();
    expect(queryByText("1")).toBeNull();
  });

  test("keeps pushed and completed loops in regular workspace groups while routing archived terminal loops to history", () => {
    const workspaces = [
      createWorkspace({
        id: "workspace-1",
        name: "Workspace 1",
        directory: "/workspaces/workspace-1",
      }),
    ];
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces,
      loops: [
        createLoop({
          config: {
            id: "loop-running",
            name: "Feature Loop",
            workspaceId: "workspace-1",
          },
          state: {
            status: "running",
          },
        }),
        createLoop({
          config: {
            id: "loop-pushed",
            name: "Pushed Loop",
            workspaceId: "workspace-1",
          },
          state: {
            status: "pushed",
          },
        }),
        createLoop({
          config: {
            id: "loop-merged",
            name: "Merged Loop",
            workspaceId: "workspace-1",
          },
          state: {
            status: "merged",
          },
        }),
        createLoop({
          config: {
            id: "loop-completed",
            name: "Completed Loop",
            workspaceId: "workspace-1",
          },
          state: {
            status: "completed",
          },
        }),
      ],
      chats: [],
      sessions: [],
    });
    const activeWorkspace = workspaceGroups
      .find((group) => group.key === "active")
      ?.workspaces.find((workspaceNode) => workspaceNode.workspace.id === "workspace-1");

    expect(activeWorkspace?.loops.map((loopNode) => loopNode.title)).toEqual([
      "Feature Loop",
      "Pushed Loop",
      "Completed Loop",
    ]);
    expect(activeWorkspace?.historyLoops.map((loopNode) => loopNode.title)).toEqual(["Merged Loop"]);

    const { getAllByText } = renderWithUser(<SidebarHarness workspaceGroups={workspaceGroups} />);

    expect(getAllByText("History")).toHaveLength(1);
    expect(getAllByText("Pushed Loop")).toHaveLength(1);
    expect(getAllByText("Merged Loop")).toHaveLength(1);
    expect(getAllByText("Completed Loop")).toHaveLength(1);
  });

  test("nests history inside loops so collapsing loops hides the whole history branch", async () => {
    const workspaces = [
      createWorkspace({
        id: "workspace-1",
        name: "Workspace 1",
        directory: "/workspaces/workspace-1",
      }),
    ];
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces,
      loops: [
        createLoop({
          config: {
            id: "loop-running",
            name: "Feature Loop",
            workspaceId: "workspace-1",
          },
          state: {
            status: "running",
          },
        }),
        createLoop({
          config: {
            id: "loop-merged",
            name: "Merged Loop",
            workspaceId: "workspace-1",
          },
          state: {
            status: "merged",
          },
        }),
      ],
      chats: [],
      sessions: [],
    });
    const { getAllByText, queryByText, user } = renderWithUser(
      <SidebarHarness workspaceGroups={workspaceGroups} />,
    );

    expect(getAllByText("History")).toHaveLength(1);
    expect(getAllByText("Feature Loop")).toHaveLength(1);
    expect(getAllByText("Merged Loop")).toHaveLength(1);

    await user.click(getByTextButton(getAllByText("Loops")[0]!));

    expect(queryByText("Feature Loop")).not.toBeInTheDocument();
    expect(queryByText("History")).not.toBeInTheDocument();
    expect(queryByText("Merged Loop")).not.toBeInTheDocument();
  });

  test("keeps workspaces with only history items in the active group", () => {
    const workspaces = [
      createWorkspace({
        id: "workspace-history",
        name: "History Workspace",
        directory: "/workspaces/history",
      }),
    ];
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces,
      loops: [
        createLoop({
          config: {
            id: "loop-history",
            name: "Merged Loop",
            workspaceId: "workspace-history",
          },
          state: {
            status: "merged",
          },
        }),
      ],
      chats: [],
      sessions: [],
    });

    expect(workspaceGroups.find((group) => group.key === "active")?.workspaces.map((node) => node.workspace.name))
      .toEqual(["History Workspace"]);
    expect(workspaceGroups.find((group) => group.key === "inactive")?.workspaces).toHaveLength(0);
  });

  test("renders history-only workspaces under active with the nested history branch", () => {
    const workspaces = [
      createWorkspace({
        id: "workspace-history",
        name: "History Workspace",
        directory: "/workspaces/history",
      }),
    ];
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces,
      loops: [
        createLoop({
          config: {
            id: "loop-history",
            name: "Merged Loop",
            workspaceId: "workspace-history",
          },
          state: {
            status: "merged",
          },
        }),
      ],
      chats: [],
      sessions: [],
    });
    const { getAllByText, queryByText } = renderWithUser(
      <SidebarHarness workspaceGroups={workspaceGroups} />,
    );

    expect(getAllByText("Active")).toHaveLength(1);
    expect(queryByText("Inactive")).not.toBeInTheDocument();
    expect(getAllByText("History Workspace")).toHaveLength(1);
    expect(getAllByText("History")).toHaveLength(1);
    expect(getAllByText("Merged Loop")).toHaveLength(1);
  });

  test("keeps workspaces with only completed loops in the active group", () => {
    const workspaces = [
      createWorkspace({
        id: "workspace-completed",
        name: "Completed Workspace",
        directory: "/workspaces/completed",
      }),
    ];
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces,
      loops: [
        createLoop({
          config: {
            id: "loop-completed",
            name: "Completed Loop",
            workspaceId: "workspace-completed",
          },
          state: {
            status: "completed",
          },
        }),
      ],
      chats: [],
      sessions: [],
    });

    expect(workspaceGroups.find((group) => group.key === "active")?.workspaces.map((node) => node.workspace.name))
      .toEqual(["Completed Workspace"]);
    expect(workspaceGroups.find((group) => group.key === "inactive")?.workspaces).toHaveLength(0);
  });

  test("collapses groups and routes scoped new actions", async () => {
    const navigateWithinShell = mock((_route: ShellRoute) => {});
    const { getAllByRole, getAllByText, getByRole, queryAllByText, user } = renderWithUser(
      <SidebarHarness navigateWithinShell={navigateWithinShell} />,
    );

    expect(getAllByText("Workspace 1")).toHaveLength(1);

    const [activeButtonLabel] = getAllByText("Active");
    expect(activeButtonLabel).toBeDefined();
    await user.click(getByTextButton(activeButtonLabel!));
    expect(queryAllByText("Workspace 1")).toHaveLength(0);

    await user.click(getByRole("button", { name: "New Workspaces" }));
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "compose", kind: "workspace" });

    await user.click(getByRole("button", { name: "New SSH servers" }));
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "compose", kind: "ssh-server" });

    await user.click(getByRole("button", { name: "New Sessions" }));
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "compose", kind: "ssh-session", scopeId: "server-1" });

    await user.click(getAllByRole("button", { name: "New Loops" })[0]!);
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "compose", kind: "loop", scopeId: "workspace-2" });
  });

  test("uses the same shared action slot and button styling for every sidebar new action", () => {
    const { getAllByRole } = renderWithUser(<SidebarHarness />);
    const newButtons = getAllByRole("button", { name: /^New / });

    expect(newButtons.length).toBeGreaterThan(0);

    for (const button of newButtons) {
      expect(button).toHaveClass("min-w-[2.75rem]", "justify-center", "text-[11px]");
      expect(button.parentElement).not.toBeNull();
      expect(button.parentElement as HTMLElement).toHaveClass("min-w-12", "justify-end");
    }
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
      <SidebarHarness workspaceGroups={workspaceGroups} />,
    );

    expect(queryByText("Active")).not.toBeInTheDocument();
    expect(getByText("Inactive")).toBeInTheDocument();
    expect(getByText("Empty Workspace")).toBeInTheDocument();
  });

  test("hides the inactive group when there are no workspaces", () => {
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces: [],
      loops: [],
      chats: [],
      sessions: [],
    });
    const { queryByText } = renderWithUser(<SidebarHarness workspaceGroups={workspaceGroups} />);

    expect(queryByText("Active")).not.toBeInTheDocument();
    expect(queryByText("Inactive")).not.toBeInTheDocument();
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

function getTreeRowForText(node: HTMLElement): HTMLDivElement {
  const row = getByTextButton(node).parentElement;
  expect(row).not.toBeNull();
  return row as HTMLDivElement;
}

function getTreeToggleButton(node: HTMLElement): HTMLButtonElement {
  const row = getTreeRowForText(node);
  const wrapper = row.firstElementChild;
  expect(wrapper).not.toBeNull();
  const button = wrapper?.querySelector("button");
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}
