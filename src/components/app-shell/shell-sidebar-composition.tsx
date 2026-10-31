import type {
  SidebarNode,
  SidebarNodeSnapshot,
  SidebarTab,
  WebAppRootProps,
} from "@pablozaiden/webapp/web";
import {
  ActivityIcon,
  FolderTreeIcon,
  ServerIcon,
} from "../common";
import {
  filterSidebarNodes,
  flattenSidebarNodes,
} from "./shell-sidebar-utils";
import {
  buildSidebarDomainNodes,
  type SidebarDomainBuilderContexts,
} from "./shell-sidebar-groups";
import type {
  SearchableSidebarNode,
  ShellSidebarComposition,
  ShellSidebarCompositionOptions,
} from "./shell-sidebar-types";
import { getClankyClientCapabilities } from "../../client-sdk/capabilities";
import { isReadOnlyWorkspaceAction, isReadOnlyWorkspaceRoute } from "../../lib/workspace-access";

export type {
  ShellSidebarActionHandlers,
  ShellSidebarComposition,
  ShellSidebarCompositionOptions,
  SidebarTabId,
  TerminalSessionActionTarget,
} from "./shell-sidebar-types";

export const SIDEBAR_TABS: SidebarTab[] = [
  { id: "active", title: "Active", label: "Active", icon: <ActivityIcon size="h-5 w-5" /> },
  { id: "workspaces", title: "Workspaces", label: "Workspaces", icon: <FolderTreeIcon size="h-5 w-5" /> },
  { id: "servers", title: "Servers", label: "Servers", icon: <ServerIcon size="h-5 w-5" /> },
];

function buildSidebarNodes(options: ShellSidebarCompositionOptions): SidebarNode[] {
  const { handlers } = options;
  const chatContext = {
    route: handlers.route,
    selectedChat: handlers.selectedChat,
    selectedChatActions: handlers.selectedChatActions,
    openHarnessActivity: handlers.openHarnessActivity,
    navigateWithinShell: handlers.navigateWithinShell,
    markChatDone: handlers.markChatDone,
    toggleChatPrivate: handlers.toggleChatPrivate,
    showPrivateItems: handlers.showPrivateItems,
  };
  const taskContext = {
    openHarnessActivity: handlers.openHarnessActivity,
    navigateWithinShell: handlers.navigateWithinShell,
    stopSidebarTask: handlers.stopSidebarTask,
    toggleTaskPrivate: handlers.toggleTaskPrivate,
    showPrivateItems: handlers.showPrivateItems,
  };
  const terminalContext = {
    toggleTerminalSessionPrivate: handlers.toggleTerminalSessionPrivate,
    openRenameTerminalSession: handlers.openRenameTerminalSession,
    openDeleteTerminalSession: handlers.openDeleteTerminalSession,
    showPrivateItems: handlers.showPrivateItems,
  };
  const agentContext = {
    setEditingAgentId: handlers.setEditingAgentId,
    setDeleteAgentTarget: handlers.setDeleteAgentTarget,
    setPurgeAgentTarget: handlers.setPurgeAgentTarget,
    exportAgent: handlers.exportAgent,
    agents: handlers.agents,
    onError: handlers.onError,
    toggleAgentPrivate: handlers.toggleAgentPrivate,
    showPrivateItems: handlers.showPrivateItems,
  };
  const executionContext = {
    navigateWithinShell: handlers.navigateWithinShell,
  };
  const workspaceContext = {
    navigateWithinShell: handlers.navigateWithinShell,
    onError: handlers.onError,
    toggleWorkspacePrivate: handlers.toggleWorkspacePrivate,
    startAgentImport: handlers.startAgentImport,
    pullLatestWorkspaceChanges: handlers.pullLatestWorkspaceChanges,
    pullingLatestWorkspaceIds: handlers.pullingLatestWorkspaceIds,
    toggleWorkspaceArchived: handlers.toggleWorkspaceArchived,
    archivingWorkspaceIds: handlers.archivingWorkspaceIds,
    showPrivateItems: handlers.showPrivateItems,
  };
  const contexts: SidebarDomainBuilderContexts = {
    chat: chatContext,
    task: taskContext,
    terminal: terminalContext,
    agent: agentContext,
    workspace: workspaceContext,
    server: {
      execution: executionContext,
      chat: chatContext,
      terminal: terminalContext,
      showPrivateItems: handlers.showPrivateItems,
    },
  };

  const nodes = buildSidebarDomainNodes({
    sidebarWorkspaceGroups: options.sidebarWorkspaceGroups,
    executionHostNodes: options.executionHostNodes,
    executionHosts: options.executionHosts,
    remoteOnly: options.remoteOnly,
    chats: options.chats,
    terminalSessions: options.terminalSessions,
    workspaces: options.workspaces,
    agents: options.agents,
    contexts,
  });
  const trashIndex = nodes.findIndex((node) => node.id === "execution-hosts");
  nodes.splice(trashIndex < 0 ? nodes.length : trashIndex, 0, {
    type: "section", id: "trash", title: "Trash",
    action: { id: "open-trash", title: "Open Trash", label: "Open", route: { view: "trash" } },
    children: [
      {
        type: "item", id: "trash-all", title: "All deleted chats", route: { view: "trash" },
        subtitle: options.trash.error ? "Could not load Trash" : options.trash.loading ? "Loading..." : undefined,
        actions: options.trashActions.emptyActions,
      },
      ...options.trash.items.map((chat): SidebarNode => ({
        type: "item", id: `trash-chat:${chat.id}`, title: chat.name,
        subtitle: `${chat.origin} · ${new Date(chat.deletedAt).toLocaleDateString()}`,
        route: { view: "trash", chatId: chat.id },
        actions: options.trashActions.items(chat),
      })),
    ],
  });
  const accessResources = {
    ...options,
    tasks: options.sidebarWorkspaceGroups.flatMap((group) => group.workspaces.flatMap((workspace) =>
      [...workspace.tasks, ...workspace.historyTasks].map((node) => node.task))),
  };
  function applyWorkspacePermissions(node: SidebarNode, inherited = false): SidebarNode {
    const readOnly = inherited || Boolean(node.route && isReadOnlyWorkspaceRoute(node.route, accessResources));
    return {
      ...node,
      ...(readOnly ? {
        actions: node.actions?.filter(isReadOnlyWorkspaceAction),
        action: undefined,
      } : {}),
      ...(node.children ? { children: node.children.map((child) => applyWorkspacePermissions(child, readOnly)) } : {}),
    };
  }
  return nodes.map((node) => applyWorkspacePermissions(node));
}

function selectSidebarTabNodes(nodes: SidebarNode[], activeTab: string | undefined): SidebarNode[] {
  switch (activeTab) {
    case "workspaces":
      return nodes.filter((node) => node.id === "workspaces" || node.id === "archived-workspaces" || node.id === "trash");
    case "servers":
      return nodes.filter((node) => node.id === "execution-hosts");
    case "active":
    default:
      return nodes.filter((node) => node.id === "active-work");
  }
}

export function buildShellSidebarComposition(
  options: ShellSidebarCompositionOptions,
): ShellSidebarComposition {
  const getNodes = ({ search, activeTab }: { search: string; activeTab?: string }): SidebarNodeSnapshot => {
    const nodes = selectSidebarTabNodes(buildSidebarNodes(options), activeTab);
    return {
      nodes: search ? filterSidebarNodes(nodes as SearchableSidebarNode[], search) : nodes,
      ready: options.sidebarSnapshotReady,
    };
  };
  const sidebar = {
    search: true,
    tabs: SIDEBAR_TABS.filter((tab) => tab.id !== "servers" || getClankyClientCapabilities().executionHosts),
    pinning: { sectionTitle: "Pinned", storageKey: "clanky.frameworkSidebarPins" },
    topActions: [
      ...options.voiceActions,
      {
        id: "quick-chat",
        title: options.quickChatUnavailableReason ?? "Start Quick Chat",
        label: options.quickChatCreating ? "Creating..." : "Start Quick Chat",
        disabled: Boolean(options.quickChatUnavailableReason),
        icon: "chat" as const,
        systemImage: "bubble.left",
        onAction: options.onQuickChat,
      },
    ],
    bottomContent: options.voiceControls,
    getNodes,
  } satisfies NonNullable<WebAppRootProps["sidebar"]>;

  return {
    sidebar,
    headerNodes: flattenSidebarNodes(buildSidebarNodes(options)),
  };
}
