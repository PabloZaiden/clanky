import { describe, expect, mock, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { useState } from "react";
import type { Chat } from "@/types/chat";
import type { SshServer, SshServerSession } from "@/types/ssh-server";
import { ShellSidebarNav } from "@/components/app-shell/shell-sidebar-nav";
import {
  buildActiveWorkSidebarItems,
  buildServerSidebarNodes,
  buildWorkspaceSidebarGroups,
  type ShellRoute,
} from "@/components/app-shell/shell-types";
import { createLoop, createServerSettings, createSshSession, createWorkspace } from "../helpers/factories";
import { act, renderWithUser, waitFor } from "../helpers/render";

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
      scope: overrides?.config?.scope ?? "workspace",
      loopId: overrides?.config?.loopId,
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
      sshServerId: overrides?.config?.sshServerId ?? "server-1",
      ...overrides?.config,
      connectionMode: overrides?.config?.connectionMode ?? "dtach",
      useTmux: overrides?.config?.useTmux ?? true,
      remoteSessionName: overrides?.config?.remoteSessionName ?? "server-session-1",
      createdAt: overrides?.config?.createdAt ?? "2026-04-16T12:00:00.000Z",
      updatedAt: overrides?.config?.updatedAt ?? "2026-04-16T12:00:00.000Z",
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
      repoUrl: "git@github.com:owner/workspace-1.git",
      serverSettings: createServerSettings({ mode: "connect" }),
    }),
    createWorkspace({
      id: "workspace-2",
      name: "Workspace 2",
      directory: "/workspaces/workspace-2",
      repoUrl: "https://example.com/workspace-2.git",
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
  quickChatWorkspace,
  quickChatUnavailableReason,
  onQuickChat,
  onConfigureQuickChat,
  pullLatestWorkspaceChanges,
  pullingLatestWorkspaceIds,
  version,
}: {
  route?: ShellRoute;
  navigateWithinShell?: (route: ShellRoute) => void;
  workspaceGroups?: ReturnType<typeof createSidebarData>["workspaceGroups"];
  serverNodes?: ReturnType<typeof createSidebarData>["serverNodes"];
  quickChatWorkspace?: ReturnType<typeof createSidebarData>["workspaceGroups"][number]["workspaces"][number] | null;
  quickChatUnavailableReason?: string | null;
  onQuickChat?: () => void;
  onConfigureQuickChat?: () => void;
  pullLatestWorkspaceChanges?: (workspaceId: string) => Promise<void>;
  pullingLatestWorkspaceIds?: ReadonlySet<string>;
  version?: string;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const { workspaceGroups, serverNodes } = createSidebarData();

  return (
    <ShellSidebarNav
      route={route ?? { view: "home" }}
      sidebarOpen
      sidebarCollapsed={false}
      navigateWithinShell={navigateWithinShell ?? mock(() => {})}
      toggleSidebar={mock(() => {})}
      isNodeCollapsed={(key) => collapsed[key] ?? false}
      toggleNodeCollapsed={(key) => setCollapsed((current) => ({ ...current, [key]: !(current[key] ?? false) }))}
      workspaceGroups={workspaceGroupsOverride ?? workspaceGroups}
      serverNodes={serverNodesOverride ?? serverNodes}
      quickChatWorkspace={quickChatWorkspace ?? null}
      quickChatLoading={false}
      quickChatUnavailableReason={quickChatUnavailableReason ?? null}
      onQuickChat={onQuickChat ?? mock(() => {})}
      onConfigureQuickChat={onConfigureQuickChat ?? mock(() => {})}
      version={version}
      sidebarSearchFocusRequest={0}
      pullLatestWorkspaceChanges={pullLatestWorkspaceChanges ?? mock(async () => {})}
      pullingLatestWorkspaceIds={pullingLatestWorkspaceIds ?? new Set()}
    />
  );
}

describe("ShellSidebarNav", () => {
  test("renders the workspace and server trees with active and inactive groups", () => {
    const { getAllByText, getByText } = renderWithUser(<SidebarHarness />);

    expect(getByText("Active Work")).toBeInTheDocument();
    expect(getByText("Active")).toBeInTheDocument();
    expect(getByText("Inactive")).toBeInTheDocument();
    expect(getAllByText("Workspace 1").length).toBeGreaterThan(0);
    expect(getByText("Workspace 2")).toBeInTheDocument();
    expect(getAllByText("Feature Loop").length).toBeGreaterThan(0);
    expect(getByText("Server 1")).toBeInTheDocument();
    expect(getByText("Standalone Server Session")).toBeInTheDocument();
  });

  test("builds active work from workspace groups without quick chat input", () => {
    const { workspaceGroups } = createSidebarData();

    expect(buildActiveWorkSidebarItems(workspaceGroups).map((item) => {
      if (item.kind === "loop") {
        return `${item.kind}:${item.loopNode.title}:${item.workspaceName}`;
      }
      if (item.kind === "chat") {
        return `${item.kind}:${item.chatNode.title}:${item.workspaceName}`;
      }
      return `${item.kind}:${item.sessionNode.title}:${item.workspaceName}`;
    })).toEqual([
      "loop:Feature Loop:Workspace 1",
      "loop:Loop With SSH:Workspace 1",
      "loop:Completed Loop:Workspace 1",
      "chat:Workspace Chat:Workspace 1",
      "ssh-session:Workspace SSH:Workspace 1",
      "ssh-session:Loop SSH Session:Workspace 1",
    ]);
  });

  test("renders active work as a non-collapsible section with workspace context and navigation", async () => {
    const navigateWithinShell = mock((_route: ShellRoute) => {});
    const { getAllByText, getByText, queryByRole, user } = renderWithUser(
      <SidebarHarness navigateWithinShell={navigateWithinShell} />,
    );

    expect(getByText("Active Work").closest("button")).toBeNull();
    expect(queryByRole("button", { name: "Collapse Active Work" })).not.toBeInTheDocument();
    expect(queryByRole("button", { name: "Collapse Active Work section" })).not.toBeInTheDocument();
    expect(getAllByText("Workspace 1").length).toBeGreaterThan(1);

    await user.click(getByTextButton(getAllByText("Feature Loop")[0]!));
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "loop", loopId: "loop-1" });

    await user.click(getByTextButton(getAllByText("Workspace Chat")[0]!));
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "chat", chatId: "chat-1" });

    await user.click(getByTextButton(getAllByText("Workspace SSH")[0]!));
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "ssh", sshSessionId: "workspace-session-2" });
  });

  test("keeps empty parent rows expandable when they expose nested action sections", () => {
    const emptyServerId = "server-empty";
    const emptyServerName = "Empty Server";
    const serverNodes = buildServerSidebarNodes({
      servers: [
        createSshServer({
          config: {
            id: emptyServerId,
            name: emptyServerName,
            address: "empty.example.com",
            username: "ubuntu",
            repositoriesBasePath: null,
            createdAt: "2026-04-16T09:00:00.000Z",
            updatedAt: "2026-04-16T09:00:00.000Z",
          },
        }),
      ],
      sessionsByServerId: {},
      workspaces: [],
      workspaceSessions: [],
    });
    const { getAllByText, getByText, queryByRole } = renderWithUser(
      <SidebarHarness serverNodes={serverNodes} />,
    );

    expect(getByText("Workspace 2")).toBeInTheDocument();
    expect(queryByRole("button", { name: "Collapse Workspace 2" })).toBeInTheDocument();
    expect(getAllByText("Loops")[1]!.closest("button")).toBeNull();
    expect(getAllByText("Chats")[1]!.closest("button")).toBeNull();
    expect(getAllByText("SSH sessions")[1]!.closest("button")).toBeNull();

    expect(getByText(emptyServerName)).toBeInTheDocument();
    expect(queryByRole("button", { name: `Collapse ${emptyServerName}` })).toBeInTheDocument();
    expect(getByText("Sessions").closest("button")).toBeNull();
  });

  test("keeps action-only sections visible without rendering collapse arrows", () => {
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces: [
        createWorkspace({
          id: "workspace-actions",
          name: "Action Workspace",
          directory: "/workspaces/actions",
        }),
      ],
      loops: [],
      chats: [
        createChat({
          config: {
            id: "chat-actions",
            name: "Action Chat",
            workspaceId: "workspace-actions",
          },
        }),
      ],
      sessions: [],
    });
    const { getAllByText, getByRole } = renderWithUser(
      <SidebarHarness workspaceGroups={workspaceGroups} />,
    );

    const loopsHeading = getAllByText("Loops")[0]!;
    expect(loopsHeading.closest("button")).toBeNull();
    expect(getByRole("button", { name: "New Loops" })).toBeInTheDocument();
    const chatsHeading = getAllByText("Chats")[0]!;
    expect(chatsHeading.closest("button")).not.toBeNull();
  });

  test("renders workspace SSH sessions only in the SSH sessions section, not nested under loops", () => {
    const { getAllByText, queryAllByText } = renderWithUser(<SidebarHarness />);

    expect(getAllByText("Loop SSH Session")).toHaveLength(3);
    expect(queryAllByText("Expand Loop With SSH")).toHaveLength(0);
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
    expect(getAllByText("Pushed Loop")).toHaveLength(2);
    expect(getAllByText("Merged Loop")).toHaveLength(1);
    expect(getAllByText("Completed Loop")).toHaveLength(2);
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
    expect(getAllByText("Feature Loop")).toHaveLength(2);
    expect(getAllByText("Merged Loop")).toHaveLength(1);

    await user.click(getByTextButton(getAllByText("Loops")[0]!));

    expect(getAllByText("Feature Loop")).toHaveLength(1);
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

    expect(getAllByText("Workspace 1").length).toBeGreaterThan(1);

    const [activeButtonLabel] = getAllByText("Active");
    expect(activeButtonLabel).toBeDefined();
    const activeButton = getByTextButton(activeButtonLabel!);
    expect(activeButton).toHaveAttribute("aria-expanded", "true");
    expect(getSidebarButtonByTextAndSubtitle(getAllByText("Workspace 1"), "/workspaces/workspace-1")).toBeInTheDocument();

    await user.click(activeButton);
    expect(activeButton).toHaveAttribute("aria-expanded", "false");
    expect(
      querySidebarButtonByTextAndSubtitle(queryAllByText("Workspace 1"), "/workspaces/workspace-1"),
    ).not.toBeInTheDocument();

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

  test("exposes shell shortcut tooltips on global action controls", () => {
    const { getAllByRole, getByLabelText, getByRole } = renderWithUser(<SidebarHarness />);

    expect(getByRole("button", { name: "Open code explorer" })).toHaveAttribute("title", "Code explorer (Ctrl/Cmd+Shift+E)");
    expect(getByRole("button", { name: "Open settings" })).toHaveAttribute("title", "Settings (Ctrl/Cmd+Shift+,)");
    expect(getByLabelText("Search sidebar")).toHaveAttribute("title", "Search sidebar (Ctrl/Cmd+Shift+F)");
    expect(getAllByRole("button", { name: "New Loops" })[0]).toHaveAttribute("title", "New loop (Ctrl/Cmd+Shift+L)");
    expect(getAllByRole("button", { name: "New Chats" })[0]).toHaveAttribute("title", "New chat (Ctrl/Cmd+Shift+C)");
    expect(getAllByRole("button", { name: "New SSH sessions" })[0]).toHaveAttribute(
      "title",
      "New SSH session (Ctrl/Cmd+Shift+S)",
    );
  });

  test("uses the header quick chat action and footer reload action", async () => {
    const onQuickChat = mock(() => {});
    const originalReload = window.location.reload;
    const reload = mock(() => {});
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: reload,
    });

    try {
      const { getByRole, user } = renderWithUser(<SidebarHarness onQuickChat={onQuickChat} />);

      await user.click(getByRole("button", { name: "Start quick chat" }));
      expect(onQuickChat).toHaveBeenCalledTimes(1);

      await user.click(getByRole("button", { name: "Reload page" }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window.location, "reload", {
        configurable: true,
        value: originalReload,
      });
    }
  });

  test("routes incomplete quick chat settings to Settings from the header button", async () => {
    const onQuickChat = mock(() => {});
    const onConfigureQuickChat = mock(() => {});
    const { getByRole, user } = renderWithUser(
      <SidebarHarness
        quickChatUnavailableReason="Choose a quick chat workspace in Settings first"
        onQuickChat={onQuickChat}
        onConfigureQuickChat={onConfigureQuickChat}
      />,
    );

    await user.click(getByRole("button", { name: "Configure quick chat" }));

    expect(onConfigureQuickChat).toHaveBeenCalledTimes(1);
    expect(onQuickChat).not.toHaveBeenCalled();
  });

  test("opens workspace context menu with detail actions plus settings last", async () => {
    const navigateWithinShell = mock((_route: ShellRoute) => {});
    const pullLatestWorkspaceChanges = mock(async (_workspaceId: string) => {});
    const { getAllByRole, getAllByText, getByRole, queryByRole, user } = renderWithUser(
      <SidebarHarness
        navigateWithinShell={navigateWithinShell}
        pullLatestWorkspaceChanges={pullLatestWorkspaceChanges}
      />,
    );
    const workspaceButton = getSidebarButtonByTextAndSubtitle(
      getAllByText("Workspace 1"),
      "/workspaces/workspace-1",
    );
    const defaultPrevented = openContextMenuForButton(workspaceButton);

    expect(defaultPrevented).toBe(true);
    expect(getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "New Loop",
      "New Chat",
      "Open code explorer",
      "Pull Latest Changes",
      "Open in GitHub",
      "New SSH Session",
      "Workspace Settings",
    ]);

    await user.click(getByRole("menuitem", { name: "New Loop" }));
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "compose", kind: "loop", scopeId: "workspace-1" });
    expect(queryByRole("menu")).not.toBeInTheDocument();

    openContextMenuForButton(workspaceButton);
    await user.click(getByRole("menuitem", { name: "Pull Latest Changes" }));
    expect(pullLatestWorkspaceChanges).toHaveBeenCalledWith("workspace-1");

    openContextMenuForButton(workspaceButton);
    await user.click(getByRole("menuitem", { name: "Workspace Settings" }));
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "workspace-settings", workspaceId: "workspace-1" });
  });

  test("omits conditional workspace context actions when unavailable and closes on Escape", async () => {
    const { getAllByRole, getAllByText, queryByRole, user } = renderWithUser(<SidebarHarness />);
    openContextMenuForButton(getSidebarButtonByTextAndSubtitle(
      getAllByText("Workspace 2"),
      "/workspaces/workspace-2",
    ));

    expect(getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "New Loop",
      "New Chat",
      "Open code explorer",
      "Pull Latest Changes",
      "Workspace Settings",
    ]);

    await user.keyboard("{Escape}");

    expect(queryByRole("menu")).not.toBeInTheDocument();
  });

  test("suppresses the native context menu inside the custom context menu", () => {
    const { getAllByText, getByRole } = renderWithUser(<SidebarHarness />);
    openContextMenuForButton(getSidebarButtonByTextAndSubtitle(
      getAllByText("Workspace 1"),
      "/workspaces/workspace-1",
    ));

    const documentContextMenu = mock((_event: Event) => {});
    document.addEventListener("contextmenu", documentContextMenu);
    try {
      let defaultPrevented = false;
      act(() => {
        const event = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 30,
          clientY: 40,
        });
        getByRole("menu").dispatchEvent(event);
        defaultPrevented = event.defaultPrevented;
      });

      expect(defaultPrevented).toBe(true);
      expect(documentContextMenu).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("contextmenu", documentContextMenu);
    }
  });

  test("opens SSH server context menu from search results with detail actions plus settings last", async () => {
    const navigateWithinShell = mock((_route: ShellRoute) => {});
    const { getAllByRole, getByLabelText, getByRole, getByText, user } = renderWithUser(
      <SidebarHarness navigateWithinShell={navigateWithinShell} />,
    );

    await user.type(getByLabelText("Search sidebar"), "server 1");
    openContextMenuForButton(getByTextButton(getByText("Server 1")));

    expect(getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Open code explorer",
      "New Session",
      "SSH Server Settings",
    ]);

    await user.click(getByRole("menuitem", { name: "New Session" }));
    expect(navigateWithinShell).toHaveBeenCalledWith({
      view: "compose",
      kind: "ssh-session",
      scopeId: "server-1",
    });

    openContextMenuForButton(getByTextButton(getByText("Server 1")));
    await user.click(getByRole("menuitem", { name: "SSH Server Settings" }));
    expect(navigateWithinShell).toHaveBeenCalledWith({ view: "ssh-server-settings", serverId: "server-1" });
  });

  test("pins quick chats before the regular workspaces without showing the workspace", async () => {
    const { workspaceGroups } = createSidebarData();
    const quickChatWorkspace = workspaceGroups[0]!.workspaces.find(
      (workspaceNode) => workspaceNode.workspace.id === "workspace-1",
    )!;
    const { getAllByText, getByLabelText, queryByText, user } = renderWithUser(
      <SidebarHarness quickChatWorkspace={quickChatWorkspace} />,
    );

    expect(getAllByText("Quick chats")).toHaveLength(1);
    expect(queryByText("Quick chat workspace")).not.toBeInTheDocument();
    expect(getAllByText("Workspace Chat")).toHaveLength(3);
    expect(getAllByText("Workspace 1").length).toBeGreaterThan(1);
    expect(getAllByText("/workspaces/workspace-1")).toHaveLength(1);
    expect(getAllByText("Feature Loop")).toHaveLength(2);
    expect(getAllByText("Loop SSH Session")).toHaveLength(3);

    await user.type(getByLabelText("Search sidebar"), "workspace chat");

    expect(queryByText("Quick chats")).not.toBeInTheDocument();
  });

  test("keeps footer reload right aligned when the version is absent", () => {
    const { getByRole, queryByText } = renderWithUser(<SidebarHarness version={undefined} />);

    expect(queryByText(/^vtest$/)).not.toBeInTheDocument();
    expect(getByRole("button", { name: "Reload page" })).toBeInTheDocument();
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

  test("trims the search input and matches workspace section results without a submit step", async () => {
    const { getAllByText, getByLabelText, getByText, queryByRole, user } = renderWithUser(<SidebarHarness />);
    const searchInput = getByLabelText("Search sidebar");

    await user.type(searchInput, "  worksp  ");

    expect(getAllByText("Workspace 1").length).toBeGreaterThan(0);
    expect(getByText("Workspace 2")).toBeInTheDocument();
    expect(getByText("Feature Loop")).toBeInTheDocument();
    expect(getAllByText("Workspace Chat").length).toBeGreaterThan(0);
    expect(queryByRole("button", { name: "New Workspaces" })).not.toBeInTheDocument();
  });

  test("orders filtered result sections by type", async () => {
    const workspaces = [
      createWorkspace({
        id: "workspace-shared",
        name: "Shared Workspace",
        directory: "/workspaces/shared",
        sshServerId: "server-shared",
      }),
    ];
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces,
      loops: [
        createLoop({
          config: {
            id: "loop-shared",
            name: "Shared Loop",
            workspaceId: "workspace-shared",
          },
          state: {
            status: "running",
          },
        }),
      ],
      chats: [
        createChat({
          config: {
            id: "chat-shared",
            name: "Shared Chat",
            workspaceId: "workspace-shared",
          },
        }),
      ],
      sessions: [
        createSshSession({
          config: {
            id: "workspace-session-shared",
            name: "Shared Workspace Session",
            workspaceId: "workspace-shared",
            createdAt: "2026-04-16T11:00:00.000Z",
          },
          state: {
            status: "connected",
          },
        }),
      ],
    });
    const serverNodes = buildServerSidebarNodes({
      servers: [
        createSshServer({
          config: {
            id: "server-shared",
            name: "Shared Server",
            address: "shared.example.com",
            username: "ubuntu",
            repositoriesBasePath: null,
            createdAt: "2026-04-16T09:00:00.000Z",
            updatedAt: "2026-04-16T09:00:00.000Z",
          },
        }),
      ],
      sessionsByServerId: {
        "server-shared": [
          createStandaloneServerSession({
            config: {
              id: "server-session-shared",
              name: "Shared Server Session",
              sshServerId: "server-shared",
              connectionMode: "dtach",
              useTmux: true,
              remoteSessionName: "server-session-shared",
              createdAt: "2026-04-16T12:00:00.000Z",
              updatedAt: "2026-04-16T12:00:00.000Z",
            },
          }),
        ],
      },
      workspaces,
      workspaceSessions: [
        createSshSession({
          config: {
            id: "workspace-session-shared",
            name: "Shared Workspace Session",
            workspaceId: "workspace-shared",
            createdAt: "2026-04-16T11:00:00.000Z",
          },
          state: {
            status: "connected",
          },
        }),
      ],
    });
    const { getAllByRole, getByLabelText, user } = renderWithUser(
      <SidebarHarness workspaceGroups={workspaceGroups} serverNodes={serverNodes} />,
    );
    const searchInput = getByLabelText("Search sidebar");

    await user.type(searchInput, "shared");

    const searchSectionTitles = getAllByRole("heading", { level: 2 }).map((node) => node.textContent?.trim());
    expect(searchSectionTitles).toEqual([
      "Workspaces",
      "Loops",
      "Chats",
      "SSH sessions",
      "SSH servers",
    ]);
  });

  test("omits empty filtered sections and restores the default tree when the query is cleared", async () => {
    const { getAllByRole, getByLabelText, getByText, user } = renderWithUser(<SidebarHarness />);
    const searchInput = getByLabelText("Search sidebar") as HTMLInputElement;

    await user.type(searchInput, "feature");

    const filteredSectionTitles = getAllByRole("heading", { level: 2 }).map((node) => node.textContent?.trim());
    expect(filteredSectionTitles).toEqual(["Loops"]);
    expect(getByText("Feature Loop")).toBeInTheDocument();

    await user.keyboard("{Backspace}".repeat(searchInput.value.length));

    await waitFor(() => {
      expect(searchInput).toHaveValue("");
      expect(getByText("Active")).toBeInTheDocument();
      expect(getByText("Inactive")).toBeInTheDocument();
    });
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

function getSidebarButtonByTextAndSubtitle(nodes: HTMLElement[], subtitle: string): HTMLButtonElement {
  const button = querySidebarButtonByTextAndSubtitle(nodes, subtitle);
  expect(button).toBeDefined();
  return button!;
}

function querySidebarButtonByTextAndSubtitle(nodes: HTMLElement[], subtitle: string): HTMLButtonElement | null {
  return nodes
    .map((node) => node.closest("button"))
    .find((candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement && (candidate.textContent ?? "").includes(subtitle)
    ) ?? null;
}

function openContextMenuForButton(button: HTMLButtonElement): boolean {
  let defaultPrevented = false;
  act(() => {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 32,
    });
    button.dispatchEvent(event);
    defaultPrevented = event.defaultPrevented;
  });
  return defaultPrevented;
}
