import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  ChatIcon,
  CodeIcon,
  ContextMenu,
  GearIcon,
  RefreshIcon,
  SidebarIcon,
  insertPinActionItem,
  type BadgeVariant,
  type ContextMenuPosition,
} from "../common";
import { getShellRouteUrl, getShellShortcutTitle, isModifiedNavigationClick } from "./shell-navigation";
import { EmptySection, ShellSection, SidebarTreeItem, SidebarTreeSection } from "./shell-sidebar";
import {
  type SidebarChatNode,
  type SidebarActiveWorkItem,
  buildActiveWorkSidebarItems,
  getSidebarSectionCollapseKey,
  getSidebarServerCollapseKey,
  getSidebarServerSectionCollapseKey,
  getSidebarWorkspaceCollapseKey,
  getSidebarWorkspaceSectionCollapseKey,
  type SidebarServerSessionNode,
  type ShellRoute,
  type SidebarTaskNode,
  type SidebarServerNode,
  type SidebarWorkspaceNode,
  type SidebarWorkspaceGroupNode,
  type SidebarWorkspaceSessionNode,
  isDesktopShellViewport,
} from "./shell-types";
import { buildSshServerActionItems, buildWorkspaceActionItems } from "./shell-action-items";
import { useWorkspaceGitHubUrl } from "./use-workspace-github-url";
import type { SidebarPinnedItem, SidebarPinningState } from "./sidebar-pins";

interface ShellSidebarNavProps {
  route: ShellRoute;
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  navigateWithinShell: (route: ShellRoute) => void;
  toggleSidebar: () => void;
  isNodeCollapsed: (collapseKey: string) => boolean;
  toggleNodeCollapsed: (collapseKey: string) => void;
  workspaceGroups: SidebarWorkspaceGroupNode[];
  serverNodes: SidebarServerNode[];
  quickChatWorkspace: SidebarWorkspaceNode | null;
  quickChatLoading: boolean;
  quickChatUnavailableReason: string | null;
  onQuickChat: () => void;
  onConfigureQuickChat: () => void;
  version: string | undefined;
  sidebarSearchFocusRequest: number;
  pullLatestWorkspaceChanges: (workspaceId: string) => Promise<void>;
  pullingLatestWorkspaceIds: ReadonlySet<string>;
  sidebarPinning: SidebarPinningState;
}

const iconButtonBase =
  "inline-flex h-10 w-10 items-center justify-center rounded-xl border bg-white shadow-sm transition dark:bg-neutral-900";
const iconButtonDefault =
  `${iconButtonBase} border-gray-200 text-gray-600 hover:border-gray-300 hover:text-gray-900 dark:border-gray-800 dark:text-gray-300 dark:hover:border-gray-700 dark:hover:text-gray-100`;
const iconButtonActive =
  `${iconButtonBase} border-gray-900 text-gray-900 dark:border-gray-100 dark:text-gray-100`;
const searchInputClassName =
  "block w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 shadow-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100 dark:focus:border-gray-500 dark:focus:ring-gray-700";

interface SidebarTaskSearchResult {
  key: string;
  workspaceName: string;
  taskNode: SidebarTaskNode;
}

interface SidebarChatSearchResult {
  key: string;
  workspaceName: string;
  chatNode: SidebarChatNode;
}

interface SidebarSessionSearchResult {
  key: string;
  contextName: string;
  sessionNode: SidebarWorkspaceSessionNode | SidebarServerSessionNode;
}

interface SidebarSearchResults {
  workspaces: SidebarWorkspaceNode[];
  tasks: SidebarTaskSearchResult[];
  chats: SidebarChatSearchResult[];
  sshSessions: SidebarSessionSearchResult[];
  sshServers: SidebarServerNode[];
}

type SidebarContextMenuState =
  | {
      kind: "workspace";
      workspace: SidebarWorkspaceNode["workspace"];
      pinnedItem: SidebarPinnedItem;
      position: ContextMenuPosition;
    }
  | {
      kind: "ssh-server";
      server: SidebarServerNode["server"];
      pinnedItem: SidebarPinnedItem;
      position: ContextMenuPosition;
    }
  | {
      kind: "task";
      taskNode: SidebarTaskNode;
      pinnedItem: SidebarPinnedItem;
      position: ContextMenuPosition;
    }
  | {
      kind: "chat";
      chatNode: SidebarChatNode;
      pinnedItem: SidebarPinnedItem;
      position: ContextMenuPosition;
    }
  | {
      kind: "ssh-session";
      sessionNode: SidebarWorkspaceSessionNode | SidebarServerSessionNode;
      pinnedItem: SidebarPinnedItem;
      position: ContextMenuPosition;
    };

type PinnedSidebarRenderNode =
  | {
      kind: "workspace";
      pinnedItem: SidebarPinnedItem;
      title: string;
      subtitle?: string;
      badge?: string;
      badgeVariant?: BadgeVariant;
      route: ShellRoute;
      workspace: SidebarWorkspaceNode["workspace"];
    }
  | {
      kind: "task";
      pinnedItem: SidebarPinnedItem;
      title: string;
      subtitle?: string;
      badge?: string;
      badgeVariant?: BadgeVariant;
      route: ShellRoute;
      taskNode: SidebarTaskNode;
    }
  | {
      kind: "chat";
      pinnedItem: SidebarPinnedItem;
      title: string;
      subtitle?: string;
      badge?: string;
      badgeVariant?: BadgeVariant;
      route: ShellRoute;
      chatNode: SidebarChatNode;
    }
  | {
      kind: "ssh-server";
      pinnedItem: SidebarPinnedItem;
      title: string;
      subtitle?: string;
      badge?: string;
      badgeVariant?: BadgeVariant;
      route: ShellRoute;
      server: SidebarServerNode["server"];
    }
  | {
      kind: "ssh-session";
      pinnedItem: SidebarPinnedItem;
      title: string;
      subtitle?: string;
      badge?: string;
      badgeVariant?: BadgeVariant;
      route: ShellRoute;
      sessionNode: SidebarWorkspaceSessionNode | SidebarServerSessionNode;
    };

function matchesSearchText(label: string, query: string): boolean {
  return query.length > 0 && label.toLowerCase().includes(query);
}

function getSidebarSessionId(sessionNode: SidebarWorkspaceSessionNode | SidebarServerSessionNode): string {
  return "session" in sessionNode ? sessionNode.session.config.id : sessionNode.id;
}

function getActiveWorkSessionSubtitle(item: Extract<SidebarActiveWorkItem, { kind: "ssh-session" }>): string {
  const { workspaceName, sessionNode } = item;
  return `${workspaceName} · ${sessionNode.subtitle}`;
}

function getActiveWorkServerSessionSubtitle(
  item: Extract<SidebarActiveWorkItem, { kind: "ssh-server-session" }>,
): string {
  const { serverName, sessionNode } = item;
  return `${serverName} · ${sessionNode.subtitle}`;
}

function getPinMenuItem(sidebarPinning: SidebarPinningState, item: SidebarPinnedItem) {
  return {
    id: "toggle-sidebar-pin",
    label: sidebarPinning.isPinned(item) ? "Unpin from sidebar" : "Pin to sidebar",
    onClick: () => sidebarPinning.togglePinned(item),
  };
}

function SearchResultsSection({
  title,
  bordered = false,
  children,
}: {
  title: string;
  bordered?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={bordered ? "border-t border-gray-200 pt-4 dark:border-gray-800" : ""}>
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
        {title}
      </h2>
      <div className="mt-2 space-y-2">
        {children}
      </div>
    </section>
  );
}

function WorkspaceSidebarContextMenu({
  workspace,
  pinnedItem,
  position,
  onClose,
  onNavigate,
  pullLatestWorkspaceChanges,
  pullingLatestWorkspaceIds,
  sidebarPinning,
}: {
  workspace: SidebarWorkspaceNode["workspace"];
  pinnedItem: SidebarPinnedItem;
  position: ContextMenuPosition;
  onClose: () => void;
  onNavigate: (route: ShellRoute) => void;
  pullLatestWorkspaceChanges: (workspaceId: string) => Promise<void>;
  pullingLatestWorkspaceIds: ReadonlySet<string>;
  sidebarPinning: SidebarPinningState;
}) {
  const githubUrl = useWorkspaceGitHubUrl(workspace);
  const items = buildWorkspaceActionItems({
    workspace,
    githubUrl,
    pullingLatestChanges: pullingLatestWorkspaceIds.has(workspace.id),
    onNavigate,
    onPullLatestChanges: () => {
      void pullLatestWorkspaceChanges(workspace.id);
    },
    onOpenGitHub: (url) => window.open(url, "_blank", "noopener,noreferrer"),
  });

  return (
    <ContextMenu
      ariaLabel={`Workspace actions for ${workspace.name}`}
      position={position}
      onClose={onClose}
      items={insertPinActionItem([
        ...items,
        {
          id: "workspace-settings",
          label: "Workspace Settings",
          onClick: () => onNavigate({ view: "workspace-settings", workspaceId: workspace.id }),
        },
      ], getPinMenuItem(sidebarPinning, pinnedItem))}
    />
  );
}

function SshServerSidebarContextMenu({
  server,
  pinnedItem,
  position,
  onClose,
  onNavigate,
  sidebarPinning,
}: {
  server: SidebarServerNode["server"];
  pinnedItem: SidebarPinnedItem;
  position: ContextMenuPosition;
  onClose: () => void;
  onNavigate: (route: ShellRoute) => void;
  sidebarPinning: SidebarPinningState;
}) {
  const items = buildSshServerActionItems({ server, onNavigate });

  return (
    <ContextMenu
      ariaLabel={`SSH server actions for ${server.config.name}`}
      position={position}
      onClose={onClose}
      items={insertPinActionItem([
        ...items,
        {
          id: "ssh-server-settings",
          label: "SSH Server Settings",
          onClick: () => onNavigate({ view: "ssh-server-settings", serverId: server.config.id }),
        },
      ], getPinMenuItem(sidebarPinning, pinnedItem))}
    />
  );
}

function ItemSidebarContextMenu({
  kind,
  title,
  pinnedItem,
  position,
  onClose,
  onNavigate,
  sidebarPinning,
}: {
  kind: "task" | "chat" | "ssh-session";
  title: string;
  pinnedItem: SidebarPinnedItem;
  position: ContextMenuPosition;
  onClose: () => void;
  onNavigate: (route: ShellRoute) => void;
  sidebarPinning: SidebarPinningState;
}) {
  const items = kind === "task"
    ? [{
        id: "code-explorer",
        label: "Open code explorer",
        onClick: () => onNavigate({ view: "code-explorer", target: { contentType: "task", taskId: pinnedItem.id } }),
      }]
    : kind === "chat"
      ? [{
          id: "code-explorer",
          label: "Open code explorer",
          onClick: () => onNavigate({ view: "code-explorer", target: { contentType: "chat", chatId: pinnedItem.id } }),
        }]
      : [{
          id: "open-session",
          label: "Open session",
          onClick: () => onNavigate({ view: "ssh", sshSessionId: pinnedItem.id }),
        }];

  return (
    <ContextMenu
      ariaLabel={`${title} actions`}
      position={position}
      onClose={onClose}
      items={insertPinActionItem(items, getPinMenuItem(sidebarPinning, pinnedItem))}
    />
  );
}

export function ShellSidebarNav({
  route,
  sidebarOpen,
  sidebarCollapsed,
  navigateWithinShell,
  toggleSidebar,
  isNodeCollapsed,
  toggleNodeCollapsed,
  workspaceGroups,
  serverNodes,
  quickChatWorkspace,
  quickChatLoading,
  quickChatUnavailableReason,
  onQuickChat,
  onConfigureQuickChat,
  version,
  sidebarSearchFocusRequest,
  pullLatestWorkspaceChanges,
  pullingLatestWorkspaceIds,
  sidebarPinning,
}: ShellSidebarNavProps) {
  const [searchInput, setSearchInput] = useState("");
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchQuery = searchInput.trim().toLowerCase();
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (sidebarSearchFocusRequest <= 0 || sidebarCollapsed) {
      return;
    }

    searchInputRef.current?.focus();
  }, [sidebarCollapsed, sidebarSearchFocusRequest]);

  function handleSidebarItemClick(event: MouseEvent<HTMLButtonElement>, nextRoute: ShellRoute) {
    closeContextMenu();
    if (isModifiedNavigationClick(event)) {
      window.open(getShellRouteUrl(nextRoute), "_blank", "noopener,noreferrer");
      return;
    }

    navigateWithinShell(nextRoute);
  }

  function openWorkspaceContextMenu(
    event: MouseEvent<HTMLButtonElement>,
    workspace: SidebarWorkspaceNode["workspace"],
  ) {
    event.preventDefault();
    setContextMenu({
      kind: "workspace",
      workspace,
      pinnedItem: { kind: "workspace", id: workspace.id },
      position: { x: event.clientX, y: event.clientY },
    });
  }

  function openServerContextMenu(
    event: MouseEvent<HTMLButtonElement>,
    server: SidebarServerNode["server"],
  ) {
    event.preventDefault();
    setContextMenu({
      kind: "ssh-server",
      server,
      pinnedItem: { kind: "ssh-server", id: server.config.id },
      position: { x: event.clientX, y: event.clientY },
    });
  }

  function openTaskContextMenu(
    event: MouseEvent<HTMLButtonElement>,
    taskNode: SidebarTaskNode,
  ) {
    event.preventDefault();
    setContextMenu({
      kind: "task",
      taskNode,
      pinnedItem: { kind: "task", id: taskNode.task.config.id },
      position: { x: event.clientX, y: event.clientY },
    });
  }

  function openChatContextMenu(
    event: MouseEvent<HTMLButtonElement>,
    chatNode: SidebarChatNode,
  ) {
    event.preventDefault();
    setContextMenu({
      kind: "chat",
      chatNode,
      pinnedItem: { kind: "chat", id: chatNode.chat.config.id },
      position: { x: event.clientX, y: event.clientY },
    });
  }

  function openSessionContextMenu(
    event: MouseEvent<HTMLButtonElement>,
    sessionNode: SidebarWorkspaceSessionNode | SidebarServerSessionNode,
  ) {
    event.preventDefault();
    const sessionId = getSidebarSessionId(sessionNode);
    setContextMenu({
      kind: "ssh-session",
      sessionNode,
      pinnedItem: { kind: "ssh-session", id: sessionId },
      position: { x: event.clientX, y: event.clientY },
    });
  }

  function openPinnedContextMenu(event: MouseEvent<HTMLButtonElement>, node: PinnedSidebarRenderNode) {
    if (node.kind === "workspace") {
      openWorkspaceContextMenu(event, node.workspace);
      return;
    }
    if (node.kind === "ssh-server") {
      openServerContextMenu(event, node.server);
      return;
    }
    if (node.kind === "task") {
      openTaskContextMenu(event, node.taskNode);
      return;
    }
    if (node.kind === "chat") {
      openChatContextMenu(event, node.chatNode);
      return;
    }
    openSessionContextMenu(event, node.sessionNode);
  }

  function isWorkspaceActive(workspaceId: string): boolean {
    return (
      (
        (route.view === "workspace" || route.view === "workspace-settings")
        && route.workspaceId === workspaceId
      )
      || (
        route.view === "code-explorer"
        && route.target?.contentType === "workspace"
        && route.target.workspaceId === workspaceId
      )
    );
  }

  function isTaskActive(taskId: string): boolean {
    return (
      ((route.view === "task" || route.view === "task-files") && route.taskId === taskId)
      || (
        route.view === "code-explorer"
        && route.target?.contentType === "task"
        && route.target.taskId === taskId
      )
    );
  }

  function isChatActive(chatId: string): boolean {
    return (
      (route.view === "chat" && route.chatId === chatId)
      || (
        route.view === "code-explorer"
        && route.target?.contentType === "chat"
        && route.target.chatId === chatId
      )
    );
  }

  function isServerActive(serverId: string): boolean {
    return (
      ((
        route.view === "ssh-server"
        || route.view === "vnc-session"
        || route.view === "ssh-server-settings"
        || route.view === "server-files"
        || route.view === "server-arise"
      )
      && route.serverId === serverId)
      || (
        route.view === "code-explorer"
        && route.target?.contentType === "server"
        && route.target.serverId === serverId
      )
    );
  }

  function renderTaskNodes({
    taskNodes,
    indentLevel = 3,
  }: {
    taskNodes: SidebarTaskNode[];
    indentLevel?: number;
  }) {
    return taskNodes.map((taskNode) => (
      <SidebarTreeItem
        key={taskNode.task.config.id}
        active={isTaskActive(taskNode.task.config.id)}
        title={taskNode.title}
        badge={taskNode.badge}
        badgeVariant={taskNode.badgeVariant}
        indentLevel={indentLevel}
        onClick={(event) => handleSidebarItemClick(event, {
          view: "task",
          taskId: taskNode.task.config.id,
        })}
        onContextMenu={(event) => openTaskContextMenu(event, taskNode)}
      />
    ));
  }

  function renderChatNodes({
    chatNodes,
    indentLevel = 3,
  }: {
    chatNodes: SidebarChatNode[];
    indentLevel?: number;
  }) {
    return chatNodes.map((chatNode) => (
      <SidebarTreeItem
        key={chatNode.chat.config.id}
        active={isChatActive(chatNode.chat.config.id)}
        title={chatNode.title}
        badge={chatNode.badge}
        badgeVariant={chatNode.badgeVariant}
        indentLevel={indentLevel}
        onClick={(event) => handleSidebarItemClick(event, {
          view: "chat",
          chatId: chatNode.chat.config.id,
        })}
        onContextMenu={(event) => openChatContextMenu(event, chatNode)}
      />
    ));
  }

  const pinnedCollapseKey = getSidebarSectionCollapseKey("pinned");
  const quickChatsCollapseKey = getSidebarSectionCollapseKey("quick-chats");
  const activeWorkCollapseKey = getSidebarSectionCollapseKey("active-work");
  const workspacesCollapseKey = getSidebarSectionCollapseKey("workspaces");
  const serversCollapseKey = getSidebarSectionCollapseKey("ssh-servers");
  const visibleWorkspaceNodes = workspaceGroups.flatMap((group) => (
    group.workspaces.map((workspaceNode) => ({ groupKey: group.key, workspaceNode }))
  ));
  const activeWorkItems = useMemo(
    () => buildActiveWorkSidebarItems(workspaceGroups, { quickChatWorkspace, serverNodes }),
    [quickChatWorkspace, serverNodes, workspaceGroups],
  );
  const pinnedRenderNodes = useMemo<PinnedSidebarRenderNode[]>(() => {
    const nodesByKey = new Map<string, PinnedSidebarRenderNode>();
    const addNode = (node: PinnedSidebarRenderNode) => {
      nodesByKey.set(`${node.pinnedItem.kind}:${node.pinnedItem.id}`, node);
    };

    for (const group of workspaceGroups) {
      for (const workspaceNode of group.workspaces) {
        addNode({
          kind: "workspace",
          pinnedItem: { kind: "workspace", id: workspaceNode.workspace.id },
          title: workspaceNode.workspace.name,
          subtitle: workspaceNode.workspace.directory,
          route: { view: "workspace", workspaceId: workspaceNode.workspace.id },
          workspace: workspaceNode.workspace,
        });

        for (const taskNode of [...workspaceNode.tasks, ...workspaceNode.historyTasks]) {
          addNode({
            kind: "task",
            pinnedItem: { kind: "task", id: taskNode.task.config.id },
            title: taskNode.title,
            subtitle: workspaceNode.workspace.name,
            badge: taskNode.badge,
            badgeVariant: taskNode.badgeVariant,
            route: { view: "task", taskId: taskNode.task.config.id },
            taskNode,
          });
        }

        for (const chatNode of workspaceNode.chats) {
          addNode({
            kind: "chat",
            pinnedItem: { kind: "chat", id: chatNode.chat.config.id },
            title: chatNode.title,
            subtitle: workspaceNode.workspace.name,
            badge: chatNode.badge,
            badgeVariant: chatNode.badgeVariant,
            route: { view: "chat", chatId: chatNode.chat.config.id },
            chatNode,
          });
        }

        for (const sessionNode of workspaceNode.sshSessions) {
          addNode({
            kind: "ssh-session",
            pinnedItem: { kind: "ssh-session", id: sessionNode.session.config.id },
            title: sessionNode.title,
            subtitle: `${workspaceNode.workspace.name} · ${sessionNode.subtitle}`,
            badge: sessionNode.badge,
            badgeVariant: sessionNode.badgeVariant,
            route: { view: "ssh", sshSessionId: sessionNode.session.config.id },
            sessionNode,
          });
        }
      }
    }

    for (const serverNode of serverNodes) {
      addNode({
        kind: "ssh-server",
        pinnedItem: { kind: "ssh-server", id: serverNode.server.config.id },
        title: serverNode.server.config.name,
        subtitle: `${serverNode.server.config.username}@${serverNode.server.config.address}`,
        route: { view: "ssh-server", serverId: serverNode.server.config.id },
        server: serverNode.server,
      });

      for (const sessionNode of serverNode.sessions) {
        addNode({
          kind: "ssh-session",
          pinnedItem: { kind: "ssh-session", id: sessionNode.id },
          title: sessionNode.title,
          subtitle: `${serverNode.server.config.name} · ${sessionNode.subtitle}`,
          badge: sessionNode.badge,
          badgeVariant: sessionNode.badgeVariant,
          route: { view: "ssh", sshSessionId: sessionNode.id },
          sessionNode,
        });
      }

      for (const chatNode of serverNode.chats) {
        addNode({
          kind: "chat",
          pinnedItem: { kind: "chat", id: chatNode.chat.config.id },
          title: chatNode.title,
          subtitle: serverNode.server.config.name,
          badge: chatNode.badge,
          badgeVariant: chatNode.badgeVariant,
          route: { view: "chat", chatId: chatNode.chat.config.id },
          chatNode,
        });
      }
    }

    return sidebarPinning.pinnedItems
      .map((item) => nodesByKey.get(`${item.kind}:${item.id}`))
      .filter((node): node is PinnedSidebarRenderNode => Boolean(node));
  }, [serverNodes, sidebarPinning.pinnedItems, workspaceGroups]);
  const sidebarToggleLabel = sidebarOpen
    ? "Close sidebar"
    : !isDesktopShellViewport()
      ? "Open sidebar"
      : "Hide sidebar";
  const searchResults = useMemo<SidebarSearchResults | null>(() => {
    if (!searchQuery) {
      return null;
    }

    const results: SidebarSearchResults = {
      workspaces: [],
      tasks: [],
      chats: [],
      sshSessions: [],
      sshServers: [],
    };
    const seenWorkspaceIds = new Set<string>();
    const seenTaskIds = new Set<string>();
    const seenChatIds = new Set<string>();
    const seenSessionIds = new Set<string>();
    const seenServerIds = new Set<string>();

    const matchesWorkspacesSection = matchesSearchText("Workspaces", searchQuery);
    const matchesTasksSection = matchesSearchText("Tasks", searchQuery);
    const matchesChatsSection = matchesSearchText("Chats", searchQuery);
    const matchesSshSessionsSection = matchesSearchText("SSH sessions", searchQuery);
    const matchesHistorySection = matchesSearchText("History", searchQuery);
    const matchesSshServersSection = matchesSearchText("SSH servers", searchQuery);
    const matchesServerSessionsSection = matchesSearchText("Sessions", searchQuery);

    for (const group of workspaceGroups) {
      const matchesGroup = matchesSearchText(group.title, searchQuery);

      for (const workspaceNode of group.workspaces) {
        const workspaceId = workspaceNode.workspace.id;
        const matchesWorkspace = matchesSearchText(workspaceNode.workspace.name, searchQuery);
        if ((matchesWorkspacesSection || matchesGroup || matchesWorkspace) && !seenWorkspaceIds.has(workspaceId)) {
          seenWorkspaceIds.add(workspaceId);
          results.workspaces.push(workspaceNode);
        }

        for (const taskNode of workspaceNode.tasks) {
          const taskId = taskNode.task.config.id;
          if ((matchesTasksSection || matchesSearchText(taskNode.title, searchQuery)) && !seenTaskIds.has(taskId)) {
            seenTaskIds.add(taskId);
            results.tasks.push({
              key: taskId,
              workspaceName: workspaceNode.workspace.name,
              taskNode,
            });
          }
        }

        for (const taskNode of workspaceNode.historyTasks) {
          const taskId = taskNode.task.config.id;
          if ((matchesTasksSection || matchesHistorySection || matchesSearchText(taskNode.title, searchQuery))
            && !seenTaskIds.has(taskId)) {
            seenTaskIds.add(taskId);
            results.tasks.push({
              key: taskId,
              workspaceName: workspaceNode.workspace.name,
              taskNode,
            });
          }
        }

        for (const chatNode of workspaceNode.chats) {
          const chatId = chatNode.chat.config.id;
          if ((matchesChatsSection || matchesSearchText(chatNode.title, searchQuery)) && !seenChatIds.has(chatId)) {
            seenChatIds.add(chatId);
            results.chats.push({
              key: chatId,
              workspaceName: workspaceNode.workspace.name,
              chatNode,
            });
          }
        }

        for (const sessionNode of workspaceNode.sshSessions) {
          const sessionId = sessionNode.session.config.id;
          if ((matchesSshSessionsSection || matchesSearchText(sessionNode.title, searchQuery))
            && !seenSessionIds.has(sessionId)) {
            seenSessionIds.add(sessionId);
            results.sshSessions.push({
              key: sessionId,
              contextName: workspaceNode.workspace.name,
              sessionNode,
            });
          }
        }
      }
    }

    for (const serverNode of serverNodes) {
      const serverId = serverNode.server.config.id;
      const matchesServer = matchesSearchText(serverNode.server.config.name, searchQuery);
      if ((matchesSshServersSection || matchesServer) && !seenServerIds.has(serverId)) {
        seenServerIds.add(serverId);
        results.sshServers.push(serverNode);
      }

      for (const sessionNode of serverNode.sessions) {
        const sessionId = sessionNode.id;
        if ((matchesSshSessionsSection || matchesServerSessionsSection || matchesSearchText(sessionNode.title, searchQuery))
          && !seenSessionIds.has(sessionId)) {
          seenSessionIds.add(sessionId);
          results.sshSessions.push({
            key: sessionId,
            contextName: serverNode.server.config.name,
            sessionNode,
          });
        }
      }

      for (const chatNode of serverNode.chats) {
        const chatId = chatNode.chat.config.id;
        if ((matchesChatsSection || matchesSearchText(chatNode.title, searchQuery)) && !seenChatIds.has(chatId)) {
          seenChatIds.add(chatId);
          results.chats.push({
            key: chatId,
            workspaceName: serverNode.server.config.name,
            chatNode,
          });
        }
      }
    }

    return results;
  }, [searchQuery, serverNodes, workspaceGroups]);
  const isSearching = searchResults !== null;
  const hasSearchResults = (searchResults?.workspaces.length ?? 0) > 0
    || (searchResults?.tasks.length ?? 0) > 0
    || (searchResults?.chats.length ?? 0) > 0
    || (searchResults?.sshSessions.length ?? 0) > 0
    || (searchResults?.sshServers.length ?? 0) > 0;
  const quickChatButtonLabel = quickChatUnavailableReason
    ? "Configure quick chat"
    : "Start quick chat";

  return (
    <aside
      hidden={sidebarCollapsed && !sidebarOpen}
      aria-hidden={sidebarCollapsed && !sidebarOpen}
      className={[
        "fixed inset-y-0 left-0 z-40 flex w-80 max-w-[86vw] flex-col border-r border-gray-200 bg-gray-50/95 backdrop-blur transition-all duration-200 dark:border-gray-800 dark:bg-neutral-900/95 lg:relative lg:inset-auto lg:z-10 lg:max-w-none lg:shrink-0",
        sidebarOpen ? "translate-x-0" : "-translate-x-full",
        sidebarCollapsed
          ? "lg:w-0 lg:min-w-0 lg:-translate-x-full lg:overflow-hidden lg:border-r-0 lg:opacity-0 lg:pointer-events-none"
          : "lg:w-80 lg:translate-x-0 lg:opacity-100",
      ].join(" ")}
    >
      <div className="border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-800 dark:bg-neutral-800">
        <div className="flex min-h-14 items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => navigateWithinShell({ view: "home" })}
            className="text-xs font-semibold uppercase tracking-[0.24em] text-gray-500 transition hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
          >
            Clanky
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={quickChatUnavailableReason ? onConfigureQuickChat : onQuickChat}
              disabled={quickChatLoading}
              aria-label={quickChatButtonLabel}
              title={quickChatUnavailableReason ?? quickChatButtonLabel}
              className={iconButtonDefault}
            >
              <ChatIcon size="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => navigateWithinShell({ view: "code-explorer" })}
              aria-label="Open code explorer"
              aria-current={route.view === "code-explorer" ? "page" : undefined}
              className={route.view === "code-explorer" ? iconButtonActive : iconButtonDefault}
              title={getShellShortcutTitle("code-explorer", "Code explorer")}
            >
              <CodeIcon size="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => navigateWithinShell({ view: "settings" })}
              aria-label="Open settings"
              aria-current={route.view === "settings" ? "page" : undefined}
              className={route.view === "settings" ? iconButtonActive : iconButtonDefault}
              title={getShellShortcutTitle("settings", "Settings")}
            >
              <GearIcon size="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={sidebarToggleLabel}
              className={iconButtonDefault}
            >
              <SidebarIcon size="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto px-3 py-4 dark-scrollbar">
        <div>
          <label htmlFor="shell-sidebar-search" className="sr-only">
            Search
          </label>
          <input
            id="shell-sidebar-search"
            type="text"
            ref={searchInputRef}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search"
            title={getShellShortcutTitle("sidebar-search", "Search")}
            className={searchInputClassName}
          />
        </div>

        {pinnedRenderNodes.length > 0 && (
          <SidebarTreeSection
            title="Pinned"
            collapsed={isNodeCollapsed(pinnedCollapseKey)}
            onToggle={() => toggleNodeCollapsed(pinnedCollapseKey)}
            headerVariant="shell"
          >
            {pinnedRenderNodes.map((node) => (
              <SidebarTreeItem
                key={`pinned:${node.pinnedItem.kind}:${node.pinnedItem.id}`}
                active={
                  node.pinnedItem.kind === "workspace"
                    ? isWorkspaceActive(node.pinnedItem.id)
                    : node.pinnedItem.kind === "task"
                      ? isTaskActive(node.pinnedItem.id)
                      : node.pinnedItem.kind === "chat"
                        ? isChatActive(node.pinnedItem.id)
                        : node.pinnedItem.kind === "ssh-server"
                          ? isServerActive(node.pinnedItem.id)
                          : route.view === "ssh" && route.sshSessionId === node.pinnedItem.id
                }
                title={node.title}
                subtitle={node.subtitle}
                badge={node.badge}
                badgeVariant={node.badgeVariant}
                indentLevel={1}
                onClick={(event) => handleSidebarItemClick(event, node.route)}
                onContextMenu={(event) => openPinnedContextMenu(event, node)}
              />
            ))}
          </SidebarTreeSection>
        )}

        {isSearching ? (
          hasSearchResults ? (
            <div className="space-y-4">
              {searchResults.workspaces.length > 0 && (
                <SearchResultsSection title="Workspaces">
                  {searchResults.workspaces.map((workspaceNode) => (
                    <div key={`search-workspace:${workspaceNode.workspace.id}`} className="space-y-1">
                      <SidebarTreeItem
                        active={isWorkspaceActive(workspaceNode.workspace.id)}
                        title={workspaceNode.workspace.name}
                        subtitle={workspaceNode.workspace.directory}
                        onClick={(event) => handleSidebarItemClick(event, {
                          view: "workspace",
                          workspaceId: workspaceNode.workspace.id,
                        })}
                        onContextMenu={(event) => openWorkspaceContextMenu(event, workspaceNode.workspace)}
                      />
                      {(workspaceNode.tasks.length > 0 || workspaceNode.historyTasks.length > 0) && (
                        <SidebarTreeSection title="Tasks" indentLevel={1}>
                          {workspaceNode.tasks.length > 0 && renderTaskNodes({
                            taskNodes: workspaceNode.tasks,
                            indentLevel: 2,
                          })}
                          {workspaceNode.historyTasks.length > 0 && (
                            <SidebarTreeSection title="History" indentLevel={2}>
                              {renderTaskNodes({
                                taskNodes: workspaceNode.historyTasks,
                                indentLevel: 3,
                              })}
                            </SidebarTreeSection>
                          )}
                        </SidebarTreeSection>
                      )}
                      {workspaceNode.chats.length > 0 && (
                        <SidebarTreeSection title="Chats" indentLevel={1}>
                          {workspaceNode.chats.map((chatNode) => (
                            <SidebarTreeItem
                              key={chatNode.chat.config.id}
                              active={isChatActive(chatNode.chat.config.id)}
                              title={chatNode.title}
                              badge={chatNode.badge}
                              badgeVariant={chatNode.badgeVariant}
                              indentLevel={2}
                              onClick={(event) => handleSidebarItemClick(event, {
                                view: "chat",
                                chatId: chatNode.chat.config.id,
                              })}
                              onContextMenu={(event) => openChatContextMenu(event, chatNode)}
                            />
                          ))}
                        </SidebarTreeSection>
                      )}
                      {workspaceNode.sshSessions.length > 0 && (
                        <SidebarTreeSection title="SSH sessions" indentLevel={1}>
                          {workspaceNode.sshSessions.map((sessionNode) => (
                            <SidebarTreeItem
                              key={sessionNode.session.config.id}
                              active={route.view === "ssh" && route.sshSessionId === sessionNode.session.config.id}
                              title={sessionNode.title}
                              subtitle={sessionNode.subtitle}
                              badge={sessionNode.badge}
                              badgeVariant={sessionNode.badgeVariant}
                              indentLevel={2}
                              onClick={(event) => handleSidebarItemClick(event, {
                                view: "ssh",
                                sshSessionId: sessionNode.session.config.id,
                              })}
                              onContextMenu={(event) => openSessionContextMenu(event, sessionNode)}
                            />
                          ))}
                        </SidebarTreeSection>
                      )}
                    </div>
                  ))}
                </SearchResultsSection>
              )}

              {searchResults.tasks.length > 0 && (
                <SearchResultsSection title="Tasks" bordered={searchResults.workspaces.length > 0}>
                  {searchResults.tasks.map(({ key, workspaceName, taskNode }) => (
                    <SidebarTreeItem
                      key={`search-task:${key}`}
                      active={isTaskActive(taskNode.task.config.id)}
                      title={taskNode.title}
                      subtitle={workspaceName}
                      badge={taskNode.badge}
                      badgeVariant={taskNode.badgeVariant}
                      onClick={(event) => handleSidebarItemClick(event, {
                        view: "task",
                        taskId: taskNode.task.config.id,
                      })}
                      onContextMenu={(event) => openTaskContextMenu(event, taskNode)}
                    />
                  ))}
                </SearchResultsSection>
              )}

              {searchResults.chats.length > 0 && (
                <SearchResultsSection
                  title="Chats"
                  bordered={searchResults.workspaces.length > 0 || searchResults.tasks.length > 0}
                >
                  {searchResults.chats.map(({ key, workspaceName, chatNode }) => (
                    <SidebarTreeItem
                      key={`search-chat:${key}`}
                      active={isChatActive(chatNode.chat.config.id)}
                      title={chatNode.title}
                      subtitle={workspaceName}
                      badge={chatNode.badge}
                      badgeVariant={chatNode.badgeVariant}
                      onClick={(event) => handleSidebarItemClick(event, {
                        view: "chat",
                        chatId: chatNode.chat.config.id,
                      })}
                      onContextMenu={(event) => openChatContextMenu(event, chatNode)}
                    />
                  ))}
                </SearchResultsSection>
              )}

              {searchResults.sshSessions.length > 0 && (
                <SearchResultsSection
                  title="SSH sessions"
                  bordered={searchResults.workspaces.length > 0
                    || searchResults.tasks.length > 0
                    || searchResults.chats.length > 0}
                >
                  {searchResults.sshSessions.map(({ key, contextName, sessionNode }) => {
                    const sessionId = getSidebarSessionId(sessionNode);
                    return (
                      <SidebarTreeItem
                        key={`search-session:${key}`}
                        active={route.view === "ssh" && route.sshSessionId === sessionId}
                        title={sessionNode.title}
                        subtitle={`${contextName} · ${sessionNode.subtitle}`}
                        badge={sessionNode.badge}
                        badgeVariant={sessionNode.badgeVariant}
                        onClick={(event) => handleSidebarItemClick(event, {
                          view: "ssh",
                          sshSessionId: sessionId,
                        })}
                        onContextMenu={(event) => openSessionContextMenu(event, sessionNode)}
                      />
                    );
                  })}
                </SearchResultsSection>
              )}

              {searchResults.sshServers.length > 0 && (
                <SearchResultsSection
                  title="SSH servers"
                  bordered={searchResults.workspaces.length > 0
                    || searchResults.tasks.length > 0
                    || searchResults.chats.length > 0
                    || searchResults.sshSessions.length > 0}
                >
                  {searchResults.sshServers.map((serverNode) => (
                    <div key={`search-server:${serverNode.server.config.id}`} className="space-y-1">
                      <SidebarTreeItem
                        active={isServerActive(serverNode.server.config.id)}
                        title={serverNode.server.config.name}
                        subtitle={`${serverNode.server.config.username}@${serverNode.server.config.address}`}
                        onClick={(event) => handleSidebarItemClick(event, {
                          view: "ssh-server",
                          serverId: serverNode.server.config.id,
                        })}
                        onContextMenu={(event) => openServerContextMenu(event, serverNode.server)}
                      />
                      {serverNode.sessions.length > 0 && (
                        <SidebarTreeSection title="Sessions" indentLevel={1}>
                          {serverNode.sessions.map((sessionNode) => (
                            <SidebarTreeItem
                              key={sessionNode.id}
                              active={route.view === "ssh" && route.sshSessionId === sessionNode.id}
                              title={sessionNode.title}
                              subtitle={sessionNode.subtitle}
                              badge={sessionNode.badge}
                              badgeVariant={sessionNode.badgeVariant}
                              indentLevel={2}
                              onClick={(event) => handleSidebarItemClick(event, {
                                view: "ssh",
                                sshSessionId: sessionNode.id,
                              })}
                              onContextMenu={(event) => openSessionContextMenu(event, sessionNode)}
                            />
                          ))}
                        </SidebarTreeSection>
                      )}
                    </div>
                  ))}
                </SearchResultsSection>
              )}
            </div>
          ) : (
            <EmptySection message="No sidebar items match that search." />
          )
        ) : (
          <>
            {quickChatWorkspace && quickChatWorkspace.chats.length > 0 && (
              <SidebarTreeSection
                title="Quick chats"
                collapsed={isNodeCollapsed(quickChatsCollapseKey)}
                onToggle={() => toggleNodeCollapsed(quickChatsCollapseKey)}
                headerVariant="shell"
              >
                {renderChatNodes({
                  chatNodes: quickChatWorkspace.chats,
                  indentLevel: 1,
                })}
              </SidebarTreeSection>
            )}

            {activeWorkItems.length > 0 && (
              <SidebarTreeSection
                title="Active Work"
                collapsed={isNodeCollapsed(activeWorkCollapseKey)}
                onToggle={() => toggleNodeCollapsed(activeWorkCollapseKey)}
                headerVariant="shell"
              >
                {activeWorkItems.map((item) => {
                  if (item.kind === "task") {
                    return (
                      <SidebarTreeItem
                        key={item.key}
                        active={isTaskActive(item.taskNode.task.config.id)}
                        title={item.taskNode.title}
                        subtitle={item.workspaceName}
                        badge={item.taskNode.badge}
                        badgeVariant={item.taskNode.badgeVariant}
                        indentLevel={1}
                        onClick={(event) => handleSidebarItemClick(event, {
                          view: "task",
                          taskId: item.taskNode.task.config.id,
                        })}
                        onContextMenu={(event) => openTaskContextMenu(event, item.taskNode)}
                      />
                    );
                  }

                  if (item.kind === "chat") {
                    return (
                      <SidebarTreeItem
                        key={item.key}
                        active={isChatActive(item.chatNode.chat.config.id)}
                        title={item.chatNode.title}
                        subtitle={item.workspaceName}
                        badge={item.chatNode.badge}
                        badgeVariant={item.chatNode.badgeVariant}
                        indentLevel={1}
                        onClick={(event) => handleSidebarItemClick(event, {
                          view: "chat",
                          chatId: item.chatNode.chat.config.id,
                        })}
                        onContextMenu={(event) => openChatContextMenu(event, item.chatNode)}
                      />
                    );
                  }

                  if (item.kind === "ssh-session") {
                    return (
                      <SidebarTreeItem
                        key={item.key}
                        active={route.view === "ssh" && route.sshSessionId === item.sessionNode.session.config.id}
                        title={item.sessionNode.title}
                        subtitle={getActiveWorkSessionSubtitle(item)}
                        badge={item.sessionNode.badge}
                        badgeVariant={item.sessionNode.badgeVariant}
                        indentLevel={1}
                        onClick={(event) => handleSidebarItemClick(event, {
                          view: "ssh",
                          sshSessionId: item.sessionNode.session.config.id,
                        })}
                        onContextMenu={(event) => openSessionContextMenu(event, item.sessionNode)}
                      />
                    );
                  }

                  return (
                    <SidebarTreeItem
                      key={item.key}
                      active={route.view === "ssh" && route.sshSessionId === item.sessionNode.id}
                      title={item.sessionNode.title}
                      subtitle={getActiveWorkServerSessionSubtitle(item)}
                      badge={item.sessionNode.badge}
                      badgeVariant={item.sessionNode.badgeVariant}
                      indentLevel={1}
                      onClick={(event) => handleSidebarItemClick(event, {
                        view: "ssh",
                        sshSessionId: item.sessionNode.id,
                      })}
                      onContextMenu={(event) => openSessionContextMenu(event, item.sessionNode)}
                    />
                  );
                })}
              </SidebarTreeSection>
            )}

            <ShellSection
              title="Workspaces"
              actionLabel="New"
              onAction={() => navigateWithinShell({ view: "compose", kind: "workspace" })}
              collapsed={isNodeCollapsed(workspacesCollapseKey)}
              onToggle={() => toggleNodeCollapsed(workspacesCollapseKey)}
            >
              {visibleWorkspaceNodes.length === 0 ? (
                <EmptySection message="No workspaces registered." />
              ) : (
                visibleWorkspaceNodes.map(({ groupKey, workspaceNode }) => {
                  const hasTaskChildren = workspaceNode.tasks.length > 0 || workspaceNode.historyTasks.length > 0;
                  const hasChatChildren = workspaceNode.chats.length > 0;
                  const hasSessionChildren = workspaceNode.sshSessions.length > 0;
                  const workspaceCollapseKey = getSidebarWorkspaceCollapseKey(
                    "workspaces",
                    groupKey,
                    workspaceNode.workspace.id,
                  );
                  const tasksCollapseKey = getSidebarWorkspaceSectionCollapseKey(
                    "workspaces",
                    groupKey,
                    workspaceNode.workspace.id,
                    "tasks",
                  );
                  const chatsCollapseKey = getSidebarWorkspaceSectionCollapseKey(
                    "workspaces",
                    groupKey,
                    workspaceNode.workspace.id,
                    "chats",
                  );
                  const historyCollapseKey = getSidebarWorkspaceSectionCollapseKey(
                    "workspaces",
                    groupKey,
                    workspaceNode.workspace.id,
                    "history",
                  );
                  const sessionsCollapseKey = getSidebarWorkspaceSectionCollapseKey(
                    "workspaces",
                    groupKey,
                    workspaceNode.workspace.id,
                    "ssh-sessions",
                  );
                  return (
                    <div key={`${groupKey}:${workspaceNode.key}`} className="space-y-1">
                      <SidebarTreeItem
                        active={isWorkspaceActive(workspaceNode.workspace.id)}
                        title={workspaceNode.workspace.name}
                        subtitle={workspaceNode.workspace.directory}
                        indentLevel={1}
                        collapsed={isNodeCollapsed(workspaceCollapseKey)}
                        onToggle={() => toggleNodeCollapsed(workspaceCollapseKey)}
                        onClick={(event) => handleSidebarItemClick(event, {
                          view: "workspace",
                          workspaceId: workspaceNode.workspace.id,
                        })}
                        onContextMenu={(event) => openWorkspaceContextMenu(event, workspaceNode.workspace)}
                      />
                      {!isNodeCollapsed(workspaceCollapseKey) && (
                        <div className="space-y-1">
                          <SidebarTreeSection
                            title="Tasks"
                            actionLabel="New"
                            actionTitle={getShellShortcutTitle("new-task", "New task")}
                            onAction={() => navigateWithinShell({
                              view: "compose",
                              kind: "task",
                              scopeId: workspaceNode.workspace.id,
                            })}
                            collapsed={hasTaskChildren ? isNodeCollapsed(tasksCollapseKey) : undefined}
                            onToggle={hasTaskChildren ? () => toggleNodeCollapsed(tasksCollapseKey) : undefined}
                            indentLevel={2}
                          >
                            {workspaceNode.tasks.length > 0 && renderTaskNodes({
                              taskNodes: workspaceNode.tasks,
                            })}
                            {workspaceNode.historyTasks.length > 0 && (
                              <SidebarTreeSection
                                title="History"
                                collapsed={isNodeCollapsed(historyCollapseKey)}
                                onToggle={() => toggleNodeCollapsed(historyCollapseKey)}
                                indentLevel={3}
                              >
                                {renderTaskNodes({
                                  taskNodes: workspaceNode.historyTasks,
                                })}
                              </SidebarTreeSection>
                            )}
                          </SidebarTreeSection>

                              <SidebarTreeSection
                                title="Chats"
                                actionLabel="New"
                                actionTitle={getShellShortcutTitle("new-chat", "New chat")}
                                onAction={() => navigateWithinShell({
                                  view: "compose",
                                  kind: "chat",
                                  scopeId: workspaceNode.workspace.id,
                                })}
                                collapsed={hasChatChildren ? isNodeCollapsed(chatsCollapseKey) : undefined}
                                onToggle={hasChatChildren ? () => toggleNodeCollapsed(chatsCollapseKey) : undefined}
                                indentLevel={2}
                              >
                                {renderChatNodes({ chatNodes: workspaceNode.chats })}
                              </SidebarTreeSection>

                              <SidebarTreeSection
                                title="SSH sessions"
                                actionLabel="New"
                                actionTitle={getShellShortcutTitle("new-ssh-session", "New SSH session")}
                                onAction={() => navigateWithinShell({
                                  view: "compose",
                                  kind: "ssh-session",
                                  scopeId: workspaceNode.workspace.id,
                                })}
                                collapsed={hasSessionChildren ? isNodeCollapsed(sessionsCollapseKey) : undefined}
                                onToggle={hasSessionChildren ? () => toggleNodeCollapsed(sessionsCollapseKey) : undefined}
                                indentLevel={2}
                              >
                                {workspaceNode.sshSessions.map((sessionNode) => (
                                  <SidebarTreeItem
                                    key={sessionNode.session.config.id}
                                    active={route.view === "ssh" && route.sshSessionId === sessionNode.session.config.id}
                                    title={sessionNode.title}
                                    subtitle={sessionNode.subtitle}
                                    badge={sessionNode.badge}
                                    badgeVariant={sessionNode.badgeVariant}
                                    indentLevel={3}
                                    onClick={(event) => handleSidebarItemClick(event, {
                                      view: "ssh",
                                      sshSessionId: sessionNode.session.config.id,
                                    })}
                                    onContextMenu={(event) => openSessionContextMenu(event, sessionNode)}
                                  />
                                ))}
                              </SidebarTreeSection>
                            </div>
                          )}
                        </div>
                      );
                    })
              )}
            </ShellSection>

            <ShellSection
              title="SSH servers"
              actionLabel="New"
              onAction={() => navigateWithinShell({ view: "compose", kind: "ssh-server" })}
              collapsed={isNodeCollapsed(serversCollapseKey)}
              onToggle={() => toggleNodeCollapsed(serversCollapseKey)}
            >
              {serverNodes.length === 0 ? (
                <EmptySection message="No standalone SSH servers registered." />
              ) : (
                serverNodes.map((serverNode) => {
                  const serverCollapseKey = getSidebarServerCollapseKey("ssh-servers", serverNode.server.config.id);
                  const sessionsCollapseKey = getSidebarServerSectionCollapseKey(
                    "ssh-servers",
                    serverNode.server.config.id,
                    "sessions",
                  );
                  const chatsCollapseKey = getSidebarServerSectionCollapseKey(
                    "ssh-servers",
                    serverNode.server.config.id,
                    "chats",
                  );
                  return (
                    <div key={serverNode.key} className="space-y-1">
                      <SidebarTreeItem
                        active={isServerActive(serverNode.server.config.id)}
                        title={serverNode.server.config.name}
                        subtitle={`${serverNode.server.config.username}@${serverNode.server.config.address}`}
                        indentLevel={1}
                        collapsed={isNodeCollapsed(serverCollapseKey)}
                        onToggle={() => toggleNodeCollapsed(serverCollapseKey)}
                        onClick={(event) => handleSidebarItemClick(event, {
                          view: "ssh-server",
                          serverId: serverNode.server.config.id,
                        })}
                        onContextMenu={(event) => openServerContextMenu(event, serverNode.server)}
                      />
                      {!isNodeCollapsed(serverCollapseKey) && (
                        <div className="space-y-1">
                          <SidebarTreeSection
                            title="Sessions"
                            actionLabel="New"
                            actionTitle={getShellShortcutTitle("new-ssh-session", "New SSH session")}
                            onAction={() => navigateWithinShell({
                              view: "compose",
                              kind: "ssh-session",
                              scopeId: serverNode.server.config.id,
                            })}
                            collapsed={serverNode.sessions.length > 0 ? isNodeCollapsed(sessionsCollapseKey) : undefined}
                            onToggle={serverNode.sessions.length > 0 ? () => toggleNodeCollapsed(sessionsCollapseKey) : undefined}
                            indentLevel={2}
                          >
                            {serverNode.sessions.map((sessionNode) => (
                              <SidebarTreeItem
                                key={sessionNode.id}
                                active={route.view === "ssh" && route.sshSessionId === sessionNode.id}
                                title={sessionNode.title}
                                subtitle={sessionNode.subtitle}
                                badge={sessionNode.badge}
                                badgeVariant={sessionNode.badgeVariant}
                                indentLevel={3}
                                onClick={(event) => handleSidebarItemClick(event, {
                                  view: "ssh",
                                  sshSessionId: sessionNode.id,
                                })}
                                onContextMenu={(event) => openSessionContextMenu(event, sessionNode)}
                              />
                            ))}
                          </SidebarTreeSection>

                          <SidebarTreeSection
                            title="Chats"
                            actionLabel="New"
                            actionTitle="New chat"
                            onAction={() => navigateWithinShell({
                              view: "compose",
                              kind: "ssh-server-chat",
                              scopeId: serverNode.server.config.id,
                            })}
                            collapsed={serverNode.chats.length > 0 ? isNodeCollapsed(chatsCollapseKey) : undefined}
                            onToggle={serverNode.chats.length > 0 ? () => toggleNodeCollapsed(chatsCollapseKey) : undefined}
                            indentLevel={2}
                          >
                            {renderChatNodes({ chatNodes: serverNode.chats })}
                          </SidebarTreeSection>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </ShellSection>
          </>
        )}

        <div className={["flex items-center gap-3 px-1", version ? "justify-between" : "justify-end"].join(" ")}>
          {version && (
            <div className="min-w-0 text-[11px] leading-4 text-gray-400 dark:text-gray-500">
              v{version}
            </div>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            aria-label="Reload page"
            title="Reload page"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-900 dark:text-gray-500 dark:hover:bg-neutral-800 dark:hover:text-gray-100"
          >
            <RefreshIcon size="h-4 w-4" />
          </button>
        </div>
        {contextMenu?.kind === "workspace" && (
          <WorkspaceSidebarContextMenu
            workspace={contextMenu.workspace}
            pinnedItem={contextMenu.pinnedItem}
            position={contextMenu.position}
            onClose={closeContextMenu}
            onNavigate={navigateWithinShell}
            pullLatestWorkspaceChanges={pullLatestWorkspaceChanges}
            pullingLatestWorkspaceIds={pullingLatestWorkspaceIds}
            sidebarPinning={sidebarPinning}
          />
        )}
        {contextMenu?.kind === "ssh-server" && (
          <SshServerSidebarContextMenu
            server={contextMenu.server}
            pinnedItem={contextMenu.pinnedItem}
            position={contextMenu.position}
            onClose={closeContextMenu}
            onNavigate={navigateWithinShell}
            sidebarPinning={sidebarPinning}
          />
        )}
        {(contextMenu?.kind === "task" || contextMenu?.kind === "chat" || contextMenu?.kind === "ssh-session") && (
          <ItemSidebarContextMenu
            kind={contextMenu.kind}
            title={
              contextMenu.kind === "task"
                ? contextMenu.taskNode.title
                : contextMenu.kind === "chat"
                  ? contextMenu.chatNode.title
                  : contextMenu.sessionNode.title
            }
            pinnedItem={contextMenu.pinnedItem}
            position={contextMenu.position}
            onClose={closeContextMenu}
            onNavigate={navigateWithinShell}
            sidebarPinning={sidebarPinning}
          />
        )}
      </div>
    </aside>
  );
}
