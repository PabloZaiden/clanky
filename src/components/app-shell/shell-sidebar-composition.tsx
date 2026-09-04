import type {
  ActionMenuItem,
  SidebarItemRenderContext,
  SidebarNode,
  SidebarNodeSnapshot,
  SidebarTab,
  WebAppRootProps,
  WebAppRoute,
} from "@pablozaiden/webapp/web";
import type {
  Agent,
  Chat,
  ExecutionHostDescriptor,
  SshServer,
  SshServerSession,
  Task,
  Workspace,
  WorkspaceTerminalSession,
} from "@/shared";
import type { UseAgentsResult } from "../../hooks/useAgents";
import { normalizeGitHubRepositoryUrl } from "../../lib/github-repository-url";
import { apiRequest } from "../../lib/api-client";
import { isChatBusyStatus, isStandaloneChat } from "@/shared/chat";
import {
  isEffectivelyPrivate,
  privateSidebarPresentation,
  shouldObscurePrivateItem,
  type PrivateEntity,
  type PrivateSidebarNode,
} from "../../lib/private-items";
import {
  ActivityIcon,
  FolderTreeIcon,
  formatStatusLabel,
  ServerIcon,
} from "../common";
import { isTaskActive, isTaskGenerating } from "../../utils";
import {
  buildActiveWorkSidebarItems,
  type SidebarServerNode,
  type SidebarWorkspaceGroupNode,
} from "./shell-types";
import { getRouteString } from "./route-fields";
import {
  ActiveWorkSidebarItem,
  type ActiveWorkSidebarItemType,
} from "./active-work-sidebar-item";
import {
  ServerSidebarItem,
  type ServerTransportKind,
} from "./server-sidebar-item";

export type StandaloneSshSessionActionTarget = { id: string; name: string; serverId: string };

export type TerminalSessionActionTarget = { id: string; name: string };

type SearchableSidebarNode = PrivateSidebarNode & {
  searchText?: string;
};

type SidebarAction = (...args: never[]) => void | Promise<void>;

export interface ShellSidebarActionHandlers {
  route: WebAppRoute;
  selectedChat: Chat | null;
  selectedChatActions: ActionMenuItem[];
  navigateWithinShell: (route: WebAppRoute) => void;
  onError: (message: string) => void;
  toggleTaskPrivate: (task: Task) => void | Promise<void>;
  toggleChatPrivate: (chat: Chat) => void | Promise<void>;
  markChatDone: (chat: Chat) => void | Promise<void>;
  toggleAgentPrivate: (agent: Agent) => void | Promise<void>;
  toggleWorkspacePrivate: (workspace: Workspace) => void | Promise<void>;
  toggleSshServerPrivate: (server: SshServer) => void | Promise<void>;
  toggleStandaloneSshSessionPrivate: (
    serverId: string,
    session: SshServerSession,
  ) => void | Promise<void>;
  stopSidebarTask: (task: Task) => void | Promise<void>;
  openRenameStandaloneSshSession: (target: StandaloneSshSessionActionTarget) => void;
  openDeleteStandaloneSshSession: (target: StandaloneSshSessionActionTarget) => void;
  toggleTerminalSessionPrivate: (session: WorkspaceTerminalSession) => void | Promise<void>;
  openRenameTerminalSession: (target: TerminalSessionActionTarget) => void;
  openDeleteTerminalSession: (target: TerminalSessionActionTarget) => void;
  pullLatestWorkspaceChanges: (workspaceId: string) => void | Promise<void>;
  pullingLatestWorkspaceIds: ReadonlySet<string>;
  toggleWorkspaceArchived: (workspace: Workspace) => void | Promise<void>;
  archivingWorkspaceIds: ReadonlySet<string>;
  setEditingAgentId: (agentId: string) => void;
  setDeleteAgentTarget: (agent: Agent) => void;
  setPurgeAgentTarget: (agent: Agent) => void;
  agents: Pick<UseAgentsResult, "pauseAgent" | "resumeAgent" | "interruptAgent" | "runAgent">;
  showPrivateItems: boolean;
}

export interface ShellSidebarCompositionOptions {
  sidebarWorkspaceGroups: SidebarWorkspaceGroupNode[];
  serverNodes: SidebarServerNode[];
  executionHosts: ExecutionHostDescriptor[];
  chats: Chat[];
  terminalSessions: WorkspaceTerminalSession[];
  workspaces: Workspace[];
  agents: Agent[];
  handlers: ShellSidebarActionHandlers;
  sidebarSnapshotReady: boolean;
  quickChatUnavailableReason: string | null;
  quickChatCreating: boolean;
  onQuickChat: () => void;
}

export interface ShellSidebarComposition {
  sidebar: NonNullable<WebAppRootProps["sidebar"]>;
  headerNodes: SidebarNode[];
}

export type SidebarTabId = "active" | "workspaces" | "servers";

export const SIDEBAR_TABS: SidebarTab[] = [
  { id: "active", title: "Active", label: "Active", icon: <ActivityIcon size="h-5 w-5" /> },
  { id: "workspaces", title: "Workspaces", label: "Workspaces", icon: <FolderTreeIcon size="h-5 w-5" /> },
  { id: "servers", title: "Servers", label: "Servers", icon: <ServerIcon size="h-5 w-5" /> },
];

function sidebarActionItems(
  items: Array<{
    id?: string;
    label: string;
    disabled?: boolean;
    destructive?: boolean;
    onClick: SidebarAction;
  }>,
): ActionMenuItem[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    disabled: item.disabled,
    destructive: item.destructive,
    onAction: () => void item.onClick(),
  }));
}

async function openWorkspaceGitHubUrl(
  workspace: Workspace,
  onError: (message: string) => void,
): Promise<void> {
  const persistedUrl = normalizeGitHubRepositoryUrl(workspace.repoUrl ?? "");
  if (persistedUrl) {
    window.open(persistedUrl, "_blank", "noopener,noreferrer");
    return;
  }

  let fetchedUrl: string | null;
  try {
    const data = await apiRequest<{ githubUrl?: unknown }>(
      `/api/git/github-repository-url?workspaceId=${encodeURIComponent(workspace.id)}`,
      {
        action: "Load GitHub repository URL",
        fallbackMessage: "GitHub repository URL is not available for this workspace",
      },
    );
    fetchedUrl = typeof data.githubUrl === "string"
      ? normalizeGitHubRepositoryUrl(data.githubUrl)
      : null;
  } catch (error) {
    onError(String(error));
    return;
  }

  if (!fetchedUrl) {
    onError("GitHub repository URL is not available for this workspace");
    return;
  }

  window.open(fetchedUrl, "_blank", "noopener,noreferrer");
}

function withPrivateToggleAction(
  items: ActionMenuItem[],
  entity: PrivateEntity,
  onToggle: () => void,
): ActionMenuItem[] {
  return [
    ...items,
    {
      id: entity.isPrivate ? "unmark-private" : "mark-private",
      label: entity.isPrivate ? "Unmark private" : "Mark as private",
      onAction: onToggle,
    },
  ];
}

function privateActions(
  items: ActionMenuItem[],
  privateHidden: boolean,
  selfPrivate: boolean,
): ActionMenuItem[] {
  if (!privateHidden) {
    return items;
  }
  if (!selfPrivate) {
    return [];
  }
  return items.filter((item) => item.id === "unmark-private");
}

function filterSidebarNodes(nodes: SearchableSidebarNode[], search: string): SidebarNode[] {
  const normalized = search.trim().toLowerCase();
  if (!normalized) {
    return nodes;
  }

  const matches = (node: SearchableSidebarNode) => {
    if (node.privateHidden) {
      return false;
    }
    return `${node.title} ${node.subtitle ?? ""} ${node.searchText ?? ""}`.toLowerCase().includes(normalized);
  };
  return nodes.flatMap((node) => {
    const children = node.children
      ? filterSidebarNodes(node.children as SearchableSidebarNode[], search)
      : undefined;
    const childMatches = children !== undefined && children.length > 0;
    if (childMatches || (node.type !== "section" && matches(node))) {
      return [{ ...node, children, defaultCollapsed: false }];
    }
    return [];
  });
}

export function flattenSidebarNodes(nodes: SidebarNode[]): SidebarNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.children ? flattenSidebarNodes(node.children) : []),
  ]);
}

export function sidebarNodeMatchesRoute(node: SidebarNode, route: WebAppRoute): boolean {
  if (!node.route || node.route.view !== route.view) {
    return false;
  }
  return Object.entries(node.route).every(([key, value]) => route[key] === value);
}

export function getHeaderOwnerRoute(route: WebAppRoute): WebAppRoute | null {
  switch (route.view) {
    case "task":
      return getRouteString(route, "taskId")
        ? { view: "task", taskId: getRouteString(route, "taskId")! }
        : null;
    case "task-files":
      return getRouteString(route, "taskId")
        ? { view: "task", taskId: getRouteString(route, "taskId")! }
        : null;
    case "chat":
    case "chat-transcript":
      return getRouteString(route, "chatId")
        ? { view: "chat", chatId: getRouteString(route, "chatId")! }
        : null;
    case "ssh":
      return getRouteString(route, "sshServerSessionId")
        ? { view: "ssh", sshServerSessionId: getRouteString(route, "sshServerSessionId")! }
        : null;
    case "terminal":
      return getRouteString(route, "terminalSessionId")
        ? { view: "terminal", terminalSessionId: getRouteString(route, "terminalSessionId")! }
        : null;
    case "workspace":
    case "workspace-files":
    case "workspace-previews":
    case "workspace-settings":
    case "rebuild-workspace":
    case "restart-workspace":
      return getRouteString(route, "workspaceId")
        ? { view: "workspace", workspaceId: getRouteString(route, "workspaceId")! }
        : null;
    case "ssh-server":
    case "vnc-session":
    case "ssh-server-settings":
    case "server-files":
    case "server-arise":
      return getRouteString(route, "serverId")
        ? { view: "ssh-server", serverId: getRouteString(route, "serverId")! }
        : null;
    case "execution-host":
    case "execution-host-files":
      return getRouteString(route, "hostKind") && getRouteString(route, "hostId")
        ? {
            view: "execution-host",
            hostKind: getRouteString(route, "hostKind")!,
            hostId: getRouteString(route, "hostId")!,
          }
        : null;
    case "agent":
    case "agent-run":
      return getRouteString(route, "agentId")
        ? { view: "agent", agentId: getRouteString(route, "agentId")! }
        : null;
    case "code-explorer": {
      const contentType = getRouteString(route, "contentType");
      if (contentType === "task" && getRouteString(route, "taskId")) {
        return { view: "task", taskId: getRouteString(route, "taskId")! };
      }
      if (contentType === "chat" && getRouteString(route, "chatId")) {
        return { view: "chat", chatId: getRouteString(route, "chatId")! };
      }
      if (contentType === "workspace" && getRouteString(route, "workspaceId")) {
        return { view: "workspace", workspaceId: getRouteString(route, "workspaceId")! };
      }
      if (contentType === "server" && getRouteString(route, "serverId")) {
        return { view: "ssh-server", serverId: getRouteString(route, "serverId")! };
      }
      if (contentType === "execution-host") {
        const hostKind = getRouteString(route, "hostKind");
        const hostId = getRouteString(route, "hostId");
        if ((hostKind === "local" || hostKind === "mesh") && hostId) {
          return { view: "execution-host", hostKind, hostId };
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function getChatSidebarActions(
  chat: Chat,
  handlers: ShellSidebarActionHandlers,
): ActionMenuItem[] {
  const chatId = chat.config.id;
  const markDoneAction = !isStandaloneChat(chat) || chat.state.status === "done"
    ? []
    : [{
        id: "mark-done",
        label: "Mark as Done",
        disabled: isChatBusyStatus(chat.state.status) || chat.state.status === "reconnecting",
        onClick: () => void handlers.markChatDone(chat),
      }];
  const baseActions = handlers.route.view === "chat" && handlers.selectedChat?.config.id === chatId
    ? handlers.selectedChatActions
    : sidebarActionItems([
        {
          id: "open-code-explorer",
          label: "Open code explorer",
          onClick: () => handlers.navigateWithinShell({
            view: "code-explorer",
            contentType: "chat",
            chatId,
          }),
        },
        ...markDoneAction,
      ]);
  return withPrivateToggleAction(
    baseActions,
    chat.config,
    () => void handlers.toggleChatPrivate(chat),
  );
}

function createChatSidebarNode(
  chatNode: SidebarWorkspaceGroupNode["workspaces"][number]["chats"][number],
  ancestors: PrivateEntity[],
  idPrefix: "chat" | "ssh-server-chat",
  handlers: ShellSidebarActionHandlers,
): SidebarNode {
  const privateHidden = getPrivateHidden(chatNode.chat.config, ancestors, handlers.showPrivateItems);
  const actions = getChatSidebarActions(chatNode.chat, handlers);
  return privateSidebarPresentation({
    type: "item",
    id: `${idPrefix}:${chatNode.chat.config.id}`,
    title: chatNode.title,
    badge: chatNode.badge,
    badgeVariant: chatNode.badgeVariant,
    route: { view: "chat", chatId: chatNode.chat.config.id },
    actions: privateActions(actions, privateHidden, chatNode.chat.config.isPrivate === true),
    pinnable: true,
    pinId: `${idPrefix}:${chatNode.chat.config.id}`,
  }, privateHidden);
}

function getTaskSidebarActions(
  task: Task,
  handlers: ShellSidebarActionHandlers,
): ActionMenuItem[] {
  const stopAction = isTaskGenerating(task)
    && (isTaskActive(task.state.status) || task.state.status === "planning")
    ? [{
        id: "stop-task",
        label: "Stop task",
        destructive: true,
        onClick: () => void handlers.stopSidebarTask(task),
      }]
    : [];
  return withPrivateToggleAction(
    sidebarActionItems([
      {
        id: "open-code-explorer",
        label: "Open code explorer",
        onClick: () => handlers.navigateWithinShell({
          view: "code-explorer",
          contentType: "task",
          taskId: task.config.id,
        }),
      },
      ...stopAction,
    ]),
    task.config,
    () => void handlers.toggleTaskPrivate(task),
  );
}

function getWorkspaceSidebarActions(
  workspaceNode: SidebarWorkspaceGroupNode["workspaces"][number],
  handlers: ShellSidebarActionHandlers,
): ActionMenuItem[] {
  const workspaceId = workspaceNode.workspace.id;
  const workspaceArchived = workspaceNode.workspace.archived === true;
  const workspaceArchiving = handlers.archivingWorkspaceIds.has(workspaceId);
  const isGitBacked = workspaceNode.workspace.workspaceType === "git";
  return withPrivateToggleAction(
    sidebarActionItems([
      ...(isGitBacked ? [{
          id: "new-task",
          label: "New Task",
          onClick: () => handlers.navigateWithinShell({
            view: "compose",
            kind: "task",
            scopeId: workspaceId,
          }),
        }] : []),
      {
        id: "new-chat",
        label: "New Chat",
        onClick: () => handlers.navigateWithinShell({
          view: "compose",
          kind: "chat",
          scopeId: workspaceId,
        }),
      },
      {
        id: "new-agent",
        label: "New Agent",
        onClick: () => handlers.navigateWithinShell({
          view: "compose",
          kind: "agent",
          workspaceId,
        }),
      },
      {
        id: "open-code-explorer",
        label: "Open code explorer",
        onClick: () => handlers.navigateWithinShell({
          view: "code-explorer",
          contentType: "workspace",
          workspaceId,
        }),
      },
      {
        id: "workspace-previews",
        label: "Previews",
        onClick: () => handlers.navigateWithinShell({
          view: "workspace-previews",
          workspaceId,
        }),
      },
      ...(isGitBacked ? [
        {
          id: "pull-latest-changes",
          label: handlers.pullingLatestWorkspaceIds.has(workspaceId)
            ? "Pulling Latest Changes..."
            : "Pull Latest Changes",
          disabled: handlers.pullingLatestWorkspaceIds.has(workspaceId),
          onClick: () => void handlers.pullLatestWorkspaceChanges(workspaceId),
        },
        {
          id: "open-github",
          label: "Open in GitHub",
          onClick: () => void openWorkspaceGitHubUrl(
            workspaceNode.workspace,
            handlers.onError,
          ),
        },
      ] : []),
      {
        id: "new-terminal-session",
        label: "New Terminal",
        onClick: () => handlers.navigateWithinShell({
          view: "compose",
          kind: "terminal-session",
          workspaceId,
        }),
      },
      {
        id: workspaceArchived ? "unarchive-workspace" : "archive-workspace",
        label: workspaceArchiving
          ? (workspaceArchived ? "Unarchiving Workspace..." : "Archiving Workspace...")
          : (workspaceArchived ? "Unarchive Workspace" : "Archive Workspace"),
        disabled: workspaceArchiving,
        onClick: () => void handlers.toggleWorkspaceArchived(workspaceNode.workspace),
      },
      {
        id: "workspace-settings",
        label: "Workspace Settings",
        onClick: () => handlers.navigateWithinShell({
          view: "workspace-settings",
          workspaceId,
        }),
      },
    ]),
    workspaceNode.workspace,
    () => void handlers.toggleWorkspacePrivate(workspaceNode.workspace),
  );
}

function getSshServerSidebarActions(
  server: SshServer,
  executionHost: ExecutionHostDescriptor | undefined,
  handlers: ShellSidebarActionHandlers,
): ActionMenuItem[] {
  const serverId = server.config.id;
  return withPrivateToggleAction(
    sidebarActionItems([
      {
        id: "new-workspace",
        label: "New Workspace",
        disabled: !executionHost?.capabilities.provisioning,
        onClick: () => handlers.navigateWithinShell({
          view: "compose",
          kind: "workspace",
          workspaceMode: "automatic",
          executionHostKind: "ssh",
          executionHostId: serverId,
          basePath: executionHost?.repositoriesBasePath ?? server.config.repositoriesBasePath ?? "/workspaces",
        }),
      },
      {
        id: "new-session",
        label: "New Terminal",
        onClick: () => handlers.navigateWithinShell({
          view: "compose",
          kind: "ssh-session",
          serverId,
        }),
      },
      {
        id: "new-chat",
        label: "New Chat",
        onClick: () => handlers.navigateWithinShell({
          view: "compose",
          kind: "ssh-server-chat",
          scopeId: serverId,
        }),
      },
      {
        id: "start-vnc-session",
        label: "Start VNC Session",
        onClick: () => handlers.navigateWithinShell({ view: "vnc-session", serverId }),
      },
      {
        id: "ssh-server-settings",
        label: "SSH Server Settings",
        onClick: () => handlers.navigateWithinShell({
          view: "ssh-server-settings",
          serverId,
        }),
      },
    ]),
    server.config,
    () => void handlers.toggleSshServerPrivate(server),
  );
}

function getStandaloneSshSessionSidebarActions(
  target: StandaloneSshSessionActionTarget,
  session: SshServerSession,
  handlers: ShellSidebarActionHandlers,
): ActionMenuItem[] {
  const baseActions = sidebarActionItems([
    {
      id: "rename-standalone-ssh-session",
      label: "Rename",
      onClick: () => handlers.openRenameStandaloneSshSession(target),
    },
    {
      id: "delete-standalone-ssh-session",
      label: "Delete Session",
      destructive: true,
      onClick: () => handlers.openDeleteStandaloneSshSession(target),
    },
  ]);
  return withPrivateToggleAction(baseActions, session.config, () => {
    void handlers.toggleStandaloneSshSessionPrivate(target.serverId, session);
  });
}

function getTerminalSessionSidebarActions(
  target: TerminalSessionActionTarget,
  session: WorkspaceTerminalSession,
  handlers: ShellSidebarActionHandlers,
): ActionMenuItem[] {
  const baseActions = sidebarActionItems([
    {
      id: "rename-terminal-session",
      label: "Rename",
      onClick: () => handlers.openRenameTerminalSession(target),
    },
    {
      id: "delete-terminal-session",
      label: "Delete Session",
      destructive: true,
      onClick: () => handlers.openDeleteTerminalSession(target),
    },
  ]);
  return withPrivateToggleAction(baseActions, session.config, () => {
    void handlers.toggleTerminalSessionPrivate(session);
  });
}

function getAgentSidebarActions(
  agent: Agent,
  handlers: ShellSidebarActionHandlers,
): ActionMenuItem[] {
  return withPrivateToggleAction(
    sidebarActionItems([
      {
        id: "edit-agent",
        label: "Edit",
        onClick: () => handlers.setEditingAgentId(agent.config.id),
      },
      {
        id: "toggle-agent-paused",
        label: agent.config.enabled ? "Pause" : "Resume",
        onClick: () => {
          const request = agent.config.enabled
            ? handlers.agents.pauseAgent(agent.config.id)
            : handlers.agents.resumeAgent(agent.config.id);
          void request.then((updated) => {
            if (!updated) {
              handlers.onError(agent.config.enabled ? "Failed to pause agent" : "Failed to resume agent");
            }
          });
        },
      },
      agent.state.status === "running"
        ? {
            id: "interrupt-agent",
            label: "Interrupt",
            onClick: () => void handlers.agents.interruptAgent(agent.config.id),
          }
        : {
            id: "run-agent",
            label: "Run now",
            onClick: () => void handlers.agents.runAgent(agent.config.id),
          },
      {
        id: "purge-agent-runs",
        label: "Purge runs",
        destructive: true,
        onClick: () => handlers.setPurgeAgentTarget(agent),
      },
      {
        id: "delete-agent",
        label: "Delete",
        destructive: true,
        onClick: () => handlers.setDeleteAgentTarget(agent),
      },
    ]),
    agent.config,
    () => void handlers.toggleAgentPrivate(agent),
  );
}

function getPrivateHidden(
  entity: PrivateEntity | null | undefined,
  ancestors: Array<PrivateEntity | null | undefined>,
  showPrivateItems: boolean,
): boolean {
  return shouldObscurePrivateItem(
    isEffectivelyPrivate(entity, ancestors),
    showPrivateItems,
  );
}

function renderActiveWorkSidebarItem(itemType: ActiveWorkSidebarItemType) {
  return ({ node }: SidebarItemRenderContext) => (
    <ActiveWorkSidebarItem node={node} itemType={itemType} />
  );
}

function renderServerSidebarItem(transport: ServerTransportKind) {
  return ({ node }: SidebarItemRenderContext) => (
    <ServerSidebarItem node={node} transport={transport} />
  );
}

function executionHostId(host: ExecutionHostDescriptor): string {
  return host.ref.kind === "ssh" ? host.ref.serverId : host.ref.nodeId;
}

function executionHostDirectory(host: ExecutionHostDescriptor): string {
  return host.repositoriesBasePath ?? "/workspaces";
}

function executionHostAvailable(host: ExecutionHostDescriptor): boolean {
  return host.availability === "local" || host.availability === "online";
}

function createExecutionHostWorkspace(
  host: ExecutionHostDescriptor,
  handlers: ShellSidebarActionHandlers,
): void {
  handlers.navigateWithinShell({
    view: "compose",
    kind: "workspace",
    workspaceMode: "automatic",
    executionHostKind: host.ref.kind,
    executionHostId: executionHostId(host),
    basePath: executionHostDirectory(host),
  });
}

async function createExecutionHostTerminal(
  host: ExecutionHostDescriptor,
  handlers: ShellSidebarActionHandlers,
): Promise<void> {
  try {
    const session = await apiRequest<WorkspaceTerminalSession>("/api/terminal-sessions", {
      method: "POST",
      body: JSON.stringify({
        executionHost: host.ref,
        name: `${host.name} terminal`,
        directory: executionHostDirectory(host),
        connectionMode: "direct",
      }),
      headers: { "Content-Type": "application/json" },
      action: "Create terminal",
      fallbackMessage: "Failed to create terminal",
    });
    handlers.navigateWithinShell({ view: "terminal", terminalSessionId: session.config.id });
  } catch (error) {
    handlers.onError(String(error));
  }
}

async function createExecutionHostChat(
  host: ExecutionHostDescriptor,
  handlers: ShellSidebarActionHandlers,
): Promise<void> {
  try {
    const chat = await apiRequest<Chat>(
      `/api/execution-hosts/${host.ref.kind}/${encodeURIComponent(executionHostId(host))}/chats`,
      {
        method: "POST",
        body: JSON.stringify({
          name: `${host.name} chat`,
          directory: executionHostDirectory(host),
          model: { providerID: "copilot", modelID: "default", variant: "" },
          autoApprovePermissions: true,
        }),
        headers: { "Content-Type": "application/json" },
        action: "Create chat",
        fallbackMessage: "Failed to create chat",
      },
    );
    handlers.navigateWithinShell({ view: "chat", chatId: chat.config.id });
  } catch (error) {
    handlers.onError(String(error));
  }
}

function getExecutionHostSidebarActions(
  host: ExecutionHostDescriptor,
  handlers: ShellSidebarActionHandlers,
): ActionMenuItem[] {
  const available = executionHostAvailable(host);
  return sidebarActionItems([
    {
      id: "new-workspace",
      label: "New Workspace",
      disabled: !available || !host.capabilities.provisioning,
      onClick: () => createExecutionHostWorkspace(host, handlers),
    },
    {
      id: "new-terminal",
      label: "New Terminal",
      disabled: !available || !host.capabilities.interactiveTerminal,
      onClick: () => createExecutionHostTerminal(host, handlers),
    },
    {
      id: "new-chat",
      label: "New Chat",
      disabled: !available || !host.capabilities.acpRuntime,
      onClick: () => createExecutionHostChat(host, handlers),
    },
  ]);
}

function buildSidebarNodes(
  {
    sidebarWorkspaceGroups,
    serverNodes,
    executionHosts,
    chats,
    terminalSessions,
    workspaces,
    agents,
    handlers,
  }: ShellSidebarCompositionOptions,
): SidebarNode[] {
  const activeWork = buildActiveWorkSidebarItems(sidebarWorkspaceGroups, { serverNodes }).map((item): SidebarNode => {
    if (item.kind === "task") {
      const privateHidden = getPrivateHidden(item.taskNode.task.config, [item.workspace], handlers.showPrivateItems);
      const actions = getTaskSidebarActions(item.taskNode.task, handlers);
      return privateSidebarPresentation({
        type: "item",
        id: item.key,
        title: item.taskNode.title,
        subtitle: item.workspaceName,
        badge: item.taskNode.badge,
        badgeVariant: item.taskNode.badgeVariant,
        badgeAppearance: "text",
        itemLayout: "subtitle-above-title",
        render: renderActiveWorkSidebarItem("Task"),
        route: { view: "task", taskId: item.taskNode.task.config.id },
        actions: privateActions(actions, privateHidden, item.taskNode.task.config.isPrivate === true),
        pinnable: true,
        pinId: item.key,
      }, privateHidden);
    }
    if (item.kind === "chat" || item.kind === "ssh-server-chat") {
      const ancestors = item.kind === "chat" ? [item.workspace] : [item.server.config];
      const privateHidden = getPrivateHidden(item.chatNode.chat.config, ancestors, handlers.showPrivateItems);
      const actions = getChatSidebarActions(item.chatNode.chat, handlers);
      return privateSidebarPresentation({
        type: "item",
        id: item.key,
        title: item.chatNode.title,
        subtitle: item.kind === "chat" ? item.workspaceName : item.serverName,
        badge: item.chatNode.badge,
        badgeVariant: item.chatNode.badgeVariant,
        badgeAppearance: "text",
        itemLayout: "subtitle-above-title",
        render: renderActiveWorkSidebarItem("Chat"),
        route: { view: "chat", chatId: item.chatNode.chat.config.id },
        actions: privateActions(actions, privateHidden, item.chatNode.chat.config.isPrivate === true),
        pinnable: true,
        pinId: item.key,
      }, privateHidden);
    }

    // Workspace terminal sessions (canonical terminal domain)
    if (item.kind === "terminal-session") {
      const terminalId = item.sessionNode.session.config.id;
      const terminalSession = item.sessionNode.session;
      const privateHidden = getPrivateHidden(terminalSession.config, [item.workspace], handlers.showPrivateItems);
      const terminalActions = getTerminalSessionSidebarActions({
        id: terminalId,
        name: terminalSession.config.name,
      }, terminalSession, handlers);
      return privateSidebarPresentation({
        type: "item",
        id: item.key,
        title: item.sessionNode.title,
        subtitle: item.workspaceName,
        badge: item.sessionNode.badge,
        badgeVariant: item.sessionNode.badgeVariant,
        badgeAppearance: "text",
        itemLayout: "subtitle-above-title",
        render: renderActiveWorkSidebarItem("Terminal"),
        route: { view: "terminal", terminalSessionId: terminalId },
        actions: privateActions(terminalActions, privateHidden, terminalSession.config.isPrivate === true),
        pinnable: true,
        pinId: item.key,
      }, privateHidden);
    }

    const sessionId = item.sessionNode.id;
    const session = item.sessionNode.session;
    const ancestors = [item.server.config];
    const privateHidden = getPrivateHidden(session.config, ancestors, handlers.showPrivateItems);
    const sessionActions = getStandaloneSshSessionSidebarActions({
      id: sessionId,
      name: item.sessionNode.title,
      serverId: item.server.config.id,
    }, session, handlers);
    return privateSidebarPresentation({
      type: "item",
      id: item.key,
      title: item.sessionNode.title,
      subtitle: item.serverName,
      badge: item.sessionNode.badge,
      badgeVariant: item.sessionNode.badgeVariant,
      badgeAppearance: "text",
      itemLayout: "subtitle-above-title",
      render: renderActiveWorkSidebarItem("Terminal"),
      route: { view: "ssh", sshServerSessionId: sessionId },
      actions: privateActions(sessionActions, privateHidden, session.config.isPrivate === true),
      pinnable: true,
      pinId: item.key,
    }, privateHidden);
  });

  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const agentNodesByWorkspace = new Map<string, SidebarNode[]>();
  for (const agent of agents) {
    const workspaceAgents = agentNodesByWorkspace.get(agent.config.workspaceId) ?? [];
    const workspace = workspaceById.get(agent.config.workspaceId) ?? null;
    const privateHidden = getPrivateHidden(agent.config, [workspace], handlers.showPrivateItems);
    const actions = getAgentSidebarActions(agent, handlers);
    workspaceAgents.push(privateSidebarPresentation({
      type: "item",
      id: `agent:${agent.config.id}`,
      title: agent.config.name,
      subtitle: agent.config.enabled ? "Agent" : "Paused agent",
      badge: formatStatusLabel(agent.config.enabled ? "enabled" : "paused"),
      badgeVariant: agent.config.enabled ? "success" : "disabled",
      route: { view: "agent", agentId: agent.config.id },
      actions: privateActions(actions, privateHidden, agent.config.isPrivate === true),
      pinnable: true,
      pinId: `agent:${agent.config.id}`,
    }, privateHidden));
    agentNodesByWorkspace.set(agent.config.workspaceId, workspaceAgents);
  }

  const buildWorkspaceNode = (
    workspaceNode: SidebarWorkspaceGroupNode["workspaces"][number],
  ): SearchableSidebarNode => {
    const workspaceId = workspaceNode.workspace.id;
    const workspacePrivateHidden = getPrivateHidden(
      workspaceNode.workspace,
      [],
      handlers.showPrivateItems,
    );
    const isGitBacked = workspaceNode.workspace.workspaceType === "git";
    const children: SidebarNode[] = [
      ...(isGitBacked ? [{
        type: "section" as const,
        id: `workspace:${workspaceId}:tasks`,
        title: "Tasks",
        action: {
          id: "new-task",
          title: "New task",
          label: "New",
          route: workspacePrivateHidden
            ? undefined
            : { view: "compose", kind: "task", scopeId: workspaceId },
        },
        children: [
          ...workspaceNode.tasks.map((taskNode): SidebarNode => {
            const privateHidden = getPrivateHidden(
              taskNode.task.config,
              [workspaceNode.workspace],
              handlers.showPrivateItems,
            );
            const actions = getTaskSidebarActions(taskNode.task, handlers);
            return privateSidebarPresentation({
              type: "item",
              id: `task:${taskNode.task.config.id}`,
              title: taskNode.title,
              badge: taskNode.badge,
              badgeVariant: taskNode.badgeVariant,
              route: { view: "task", taskId: taskNode.task.config.id },
              actions: privateActions(actions, privateHidden, taskNode.task.config.isPrivate === true),
              pinnable: true,
              pinId: `task:${taskNode.task.config.id}`,
            }, privateHidden);
          }),
          ...(workspaceNode.historyTasks.length > 0 ? [{
            type: "section" as const,
            id: `workspace:${workspaceId}:history`,
            title: "History",
            defaultCollapsed: true,
            children: workspaceNode.historyTasks.map((taskNode): SidebarNode => {
              const privateHidden = getPrivateHidden(
                taskNode.task.config,
                [workspaceNode.workspace],
                handlers.showPrivateItems,
              );
              const actions = getTaskSidebarActions(taskNode.task, handlers);
              return privateSidebarPresentation({
                type: "item",
                id: `task:${taskNode.task.config.id}`,
                title: taskNode.title,
                badge: taskNode.badge,
                badgeVariant: taskNode.badgeVariant,
                route: { view: "task", taskId: taskNode.task.config.id },
                actions: privateActions(actions, privateHidden, taskNode.task.config.isPrivate === true),
                pinnable: true,
                pinId: `task:${taskNode.task.config.id}`,
              }, privateHidden);
            }),
          }] : []),
        ],
      }] : []),
      {
        type: "section",
        id: `workspace:${workspaceId}:chats`,
        title: "Chats",
        action: {
          id: "new-chat",
          title: "New chat",
          label: "New",
          route: workspacePrivateHidden
            ? undefined
            : { view: "compose", kind: "chat", scopeId: workspaceId },
        },
        children: [
          ...workspaceNode.chats.map((chatNode) =>
            createChatSidebarNode(chatNode, [workspaceNode.workspace], "chat", handlers)
          ),
          ...(workspaceNode.historyChats.length > 0 ? [{
            type: "section" as const,
            id: `workspace:${workspaceId}:chat-history`,
            title: "History",
            defaultCollapsed: true,
            children: workspaceNode.historyChats.map((chatNode) =>
              createChatSidebarNode(chatNode, [workspaceNode.workspace], "chat", handlers)
            ),
          }] : []),
        ],
      },
      {
        type: "section",
        id: `workspace:${workspaceId}:agents`,
        title: "Agents",
        action: {
          id: "new-agent",
          title: "New agent",
          label: "New",
          route: workspacePrivateHidden
            ? undefined
            : { view: "compose", kind: "agent", workspaceId },
        },
        children: agentNodesByWorkspace.get(workspaceId) ?? [],
      },
      {
        type: "section",
        id: `workspace:${workspaceId}:terminal-sessions`,
        title: "Terminals",
        action: {
          id: "new-terminal-session",
          title: "New terminal",
          label: "New",
          route: workspacePrivateHidden
            ? undefined
            : { view: "compose", kind: "terminal-session", workspaceId },
        },
        children: workspaceNode.terminalSessions.map((terminalNode): SidebarNode => {
          const privateHidden = getPrivateHidden(
            terminalNode.session.config,
            [workspaceNode.workspace],
            handlers.showPrivateItems,
          );
          const actions = getTerminalSessionSidebarActions({
            id: terminalNode.session.config.id,
            name: terminalNode.session.config.name,
          }, terminalNode.session, handlers);
          return privateSidebarPresentation({
            type: "item",
            id: `terminal-session:${terminalNode.session.config.id}`,
            title: terminalNode.title,
            subtitle: terminalNode.subtitle,
            badge: terminalNode.badge,
            badgeVariant: terminalNode.badgeVariant,
            route: { view: "terminal", terminalSessionId: terminalNode.session.config.id },
            actions: privateActions(actions, privateHidden, terminalNode.session.config.isPrivate === true),
            pinnable: true,
            pinId: `terminal-session:${terminalNode.session.config.id}`,
          }, privateHidden);
        }),
      },
    ];

    return privateSidebarPresentation({
      type: "item",
      id: `workspace:${workspaceId}`,
      title: workspaceNode.workspace.name,
      searchText: `${workspaceNode.workspace.directory} ${isGitBacked ? "git" : "directory"}`,
      route: { view: "workspace", workspaceId },
      actions: privateActions(
        getWorkspaceSidebarActions(workspaceNode, handlers),
        workspacePrivateHidden,
        workspaceNode.workspace.isPrivate === true,
      ),
      pinnable: true,
      pinId: `workspace:${workspaceId}`,
      children,
    }, workspacePrivateHidden);
  };

  const workspaceNodes = sidebarWorkspaceGroups.flatMap((group) => group.workspaces
    .filter((workspaceNode) => workspaceNode.workspace.archived !== true)
    .map(buildWorkspaceNode));
  const archivedWorkspaceNodes = sidebarWorkspaceGroups.flatMap((group) => group.workspaces
    .filter((workspaceNode) => workspaceNode.workspace.archived === true)
    .map(buildWorkspaceNode));

  const sshServerNodes = serverNodes.map((serverNode): SidebarNode => {
    const serverId = serverNode.server.config.id;
    const executionHost = executionHosts.find((host) => (
      host.ref.kind === "ssh" && host.ref.serverId === serverId
    ));
    const serverPrivateHidden = getPrivateHidden(
      serverNode.server.config,
      [],
      handlers.showPrivateItems,
    );
    return privateSidebarPresentation({
      type: "item",
      id: `ssh-server:${serverId}`,
      title: serverNode.server.config.name,
      subtitle: serverNode.server.config.address,
      badge: executionHost?.availability ?? "offline",
      badgeVariant: executionHost?.availability === "online"
        ? "success"
        : "disabled",
      render: renderServerSidebarItem("ssh"),
      route: { view: "ssh-server", serverId },
      actions: privateActions(
        getSshServerSidebarActions(serverNode.server, executionHost, handlers),
        serverPrivateHidden,
        serverNode.server.config.isPrivate === true,
      ),
      pinnable: true,
      pinId: `ssh-server:${serverId}`,
      children: [
        {
          type: "section",
          id: `ssh-server:${serverId}:workspaces`,
          title: "Workspaces",
          action: {
            id: "new-workspace",
            title: "New workspace",
            label: "New",
            route: !serverPrivateHidden && executionHost?.capabilities.provisioning
              ? {
                  view: "compose",
                  kind: "workspace",
                  workspaceMode: "automatic",
                  executionHostKind: "ssh",
                  executionHostId: serverId,
                  basePath: executionHost.repositoriesBasePath
                    ?? serverNode.server.config.repositoriesBasePath
                    ?? "/workspaces",
                }
              : undefined,
          },
          children: [],
        },
        {
          type: "section",
          id: `ssh-server:${serverId}:sessions`,
          title: "Terminals",
          action: {
            id: "new-session",
            title: "New terminal",
            label: "New",
            route: serverPrivateHidden
              ? undefined
              : { view: "compose", kind: "ssh-session", serverId },
          },
          children: serverNode.sessions.map((sessionNode): SidebarNode => {
            const privateHidden = getPrivateHidden(
              sessionNode.session.config,
              [serverNode.server.config],
              handlers.showPrivateItems,
            );
            const actions = getStandaloneSshSessionSidebarActions({
              id: sessionNode.id,
              name: sessionNode.title,
              serverId,
            }, sessionNode.session, handlers);
            return privateSidebarPresentation({
              type: "item",
              id: `ssh-server-session:${sessionNode.id}`,
              title: sessionNode.title,
              subtitle: sessionNode.subtitle,
              badge: sessionNode.badge,
              badgeVariant: sessionNode.badgeVariant,
              route: { view: "ssh", sshServerSessionId: sessionNode.id },
              actions: privateActions(actions, privateHidden, sessionNode.session.config.isPrivate === true),
              pinnable: true,
              pinId: `ssh-server-session:${sessionNode.id}`,
            }, privateHidden);
          }),
        },
        {
          type: "section",
          id: `ssh-server:${serverId}:chats`,
          title: "Chats",
          action: {
            id: "new-chat",
            title: "New chat",
            label: "New",
            route: serverPrivateHidden
              ? undefined
              : { view: "compose", kind: "ssh-server-chat", scopeId: serverId },
          },
          children: [
            ...serverNode.chats.map((chatNode) =>
              createChatSidebarNode(chatNode, [serverNode.server.config], "ssh-server-chat", handlers)
            ),
            ...(serverNode.historyChats.length > 0 ? [{
              type: "section" as const,
              id: `ssh-server:${serverId}:chat-history`,
              title: "History",
              defaultCollapsed: true,
              children: serverNode.historyChats.map((chatNode) =>
                createChatSidebarNode(chatNode, [serverNode.server.config], "ssh-server-chat", handlers)
              ),
            }] : []),
          ],
        },
      ],
    }, serverPrivateHidden);
  });
  const directExecutionHostNodes = executionHosts
    .filter((host) => host.ref.kind === "mesh")
    .map((host): SidebarNode => {
      const hostId = executionHostId(host);
      const belongsToHost = (ref: import("@/shared").ExecutionHostRef | undefined) => {
        if (!ref || ref.kind !== host.ref.kind) {
          return false;
        }
        return (ref.kind === "ssh" ? ref.serverId : ref.nodeId) === hostId;
      };
      const hostChats = chats.filter((chat) => {
        const source = chat.config.source;
        return source?.kind === "execution_host"
          && belongsToHost(source.executionHost.host);
      });
      const hostTerminals = terminalSessions.filter((session) => (
        belongsToHost(session.config.executionHostBinding?.host)
      ));
      const subtitle = host.endpoint ?? (
        host.ref.kind === "local" ? "This server" : "Endpoint unavailable"
      );
      return {
        type: "item",
        id: `execution-host:${host.ref.kind}:${hostId}`,
        title: host.name,
        subtitle,
        badge: host.availability,
        badgeVariant: host.availability === "online" || host.availability === "local"
          ? "success"
          : "disabled",
        render: renderServerSidebarItem(host.ref.kind),
        route: {
          view: "execution-host",
          hostKind: host.ref.kind,
          hostId,
        },
        actions: getExecutionHostSidebarActions(host, handlers),
        pinnable: true,
        pinId: `execution-host:${host.ref.kind}:${hostId}`,
        children: [
          {
            type: "section",
            id: `execution-host:${host.ref.kind}:${hostId}:workspaces`,
            title: "Workspaces",
            action: {
              id: "new-workspace",
              title: "New workspace",
              label: "New",
              onAction: executionHostAvailable(host) && host.capabilities.provisioning
                ? () => createExecutionHostWorkspace(host, handlers)
                : undefined,
            },
            children: [],
          },
          {
            type: "section",
            id: `execution-host:${host.ref.kind}:${hostId}:terminals`,
            title: "Terminals",
            action: {
              id: "new-terminal",
              title: "New terminal",
              label: "New",
              onAction: executionHostAvailable(host) && host.capabilities.interactiveTerminal
                ? () => void createExecutionHostTerminal(host, handlers)
                : undefined,
            },
            children: hostTerminals.map((session): SidebarNode => ({
              type: "item",
              id: `terminal-session:${session.config.id}`,
              title: session.config.name,
              route: { view: "terminal", terminalSessionId: session.config.id },
              actions: getTerminalSessionSidebarActions({
                id: session.config.id,
                name: session.config.name,
              }, session, handlers),
              pinnable: true,
              pinId: `terminal-session:${session.config.id}`,
            })),
          },
          {
            type: "section",
            id: `execution-host:${host.ref.kind}:${hostId}:chats`,
            title: "Chats",
            action: {
              id: "new-chat",
              title: "New chat",
              label: "New",
              onAction: executionHostAvailable(host) && host.capabilities.acpRuntime
                ? () => void createExecutionHostChat(host, handlers)
                : undefined,
            },
            children: hostChats.map((chat): SidebarNode => ({
              type: "item",
              id: `chat:${chat.config.id}`,
              title: chat.config.name,
              route: { view: "chat", chatId: chat.config.id },
              actions: getChatSidebarActions(chat, handlers),
              pinnable: true,
              pinId: `chat:${chat.config.id}`,
            })),
          },
        ],
      };
    });
  const unifiedServerNodes = [...directExecutionHostNodes, ...sshServerNodes]
    .sort((left, right) => left.title.localeCompare(right.title));

  return filterSidebarNodes([
    ...(activeWork.length > 0
      ? [{ type: "section" as const, id: "active-work", title: "Active work", children: activeWork }]
      : []),
    {
      type: "section",
      id: "workspaces",
      title: "Workspaces",
      action: {
        id: "new-workspace",
        title: "New workspace",
        label: "New",
        route: { view: "compose", kind: "workspace" },
      },
      children: workspaceNodes,
    },
    ...(archivedWorkspaceNodes.length > 0 ? [{
      type: "section" as const,
      id: "archived-workspaces",
      title: "Archived",
      children: archivedWorkspaceNodes,
    }] : []),
    {
      type: "section",
      id: "ssh-servers",
      title: "Servers",
      action: {
        id: "new-ssh-server",
        title: "New SSH server",
        label: "New",
        route: { view: "compose", kind: "ssh-server" },
      },
      children: unifiedServerNodes,
    },
  ], "");
}

function selectSidebarTabNodes(nodes: SidebarNode[], activeTab: string | undefined): SidebarNode[] {
  switch (activeTab) {
    case "workspaces":
      return nodes.filter((node) => node.id === "workspaces" || node.id === "archived-workspaces");
    case "servers":
      return nodes.filter((node) => node.id === "ssh-servers");
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
    tabs: SIDEBAR_TABS,
    pinning: { sectionTitle: "Pinned", storageKey: "clanky.frameworkSidebarPins" },
    topActions: [
      {
        id: "quick-chat",
        title: options.quickChatUnavailableReason ?? "Start Quick Chat",
        label: options.quickChatCreating ? "Creating..." : "Start Quick Chat",
        icon: "chat" as const,
        onAction: options.onQuickChat,
      },
      {
        id: "code-explorer",
        title: "Code Explorer",
        label: "Code Explorer",
        icon: "code" as const,
        route: { view: "code-explorer" as const },
      },
    ],
    getNodes,
  } satisfies NonNullable<WebAppRootProps["sidebar"]>;

  return {
    sidebar,
    headerNodes: flattenSidebarNodes(buildSidebarNodes(options)),
  };
}
