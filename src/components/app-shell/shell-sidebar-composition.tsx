import type {
  ActionMenuItem,
  SidebarNode,
  WebAppRootProps,
  WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { Agent, Chat, SshServer, SshServerSession, SshSession, Task, Workspace } from "@/shared";
import type { UseAgentsResult } from "../../hooks/useAgents";
import { normalizeGitHubRepositoryUrl } from "../../lib/github-repository-url";
import { appFetch } from "../../lib/public-path";
import {
  isEffectivelyPrivate,
  privateSidebarPresentation,
  shouldObscurePrivateItem,
  type PrivateEntity,
  type PrivateSidebarNode,
} from "../../lib/private-items";
import { isTaskActive, isTaskGenerating } from "../../utils";
import {
  buildActiveWorkSidebarItems,
  type SidebarServerNode,
  type SidebarWorkspaceGroupNode,
} from "./shell-types";
import { getRouteString } from "./route-fields";

export type SshSessionActionTarget =
  | { kind: "workspace"; id: string; name: string }
  | { kind: "standalone"; id: string; name: string; serverId: string };

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
  toggleAgentPrivate: (agent: Agent) => void | Promise<void>;
  toggleWorkspacePrivate: (workspace: Workspace) => void | Promise<void>;
  toggleWorkspaceSshSessionPrivate: (session: SshSession) => void | Promise<void>;
  toggleSshServerPrivate: (server: SshServer) => void | Promise<void>;
  toggleStandaloneSshSessionPrivate: (
    serverId: string,
    session: SshServerSession,
  ) => void | Promise<void>;
  stopSidebarTask: (task: Task) => void | Promise<void>;
  openRenameSshSession: (target: SshSessionActionTarget) => void;
  openDeleteSshSession: (target: SshSessionActionTarget) => void;
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
  workspaces: Workspace[];
  agents: Agent[];
  handlers: ShellSidebarActionHandlers;
  quickChatUnavailableReason: string | null;
  quickChatCreating: boolean;
  onQuickChat: () => void;
}

export interface ShellSidebarComposition {
  sidebar: NonNullable<WebAppRootProps["sidebar"]>;
  headerNodes: SidebarNode[];
}

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
    const response = await appFetch(
      `/api/git/github-repository-url?workspaceId=${encodeURIComponent(workspace.id)}`,
    );
    if (!response.ok) {
      onError("GitHub repository URL is not available for this workspace");
      return;
    }

    const data = await response.json() as { githubUrl?: unknown };
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
      return getRouteString(route, "sshSessionId")
        ? { view: "ssh", sshSessionId: getRouteString(route, "sshSessionId")! }
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
      ]);
  return withPrivateToggleAction(
    baseActions,
    chat.config,
    () => void handlers.toggleChatPrivate(chat),
  );
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
  return withPrivateToggleAction(
    sidebarActionItems([
      {
        id: "new-task",
        label: "New Task",
        onClick: () => handlers.navigateWithinShell({
          view: "compose",
          kind: "task",
          scopeId: workspaceId,
        }),
      },
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
      ...(workspaceNode.workspace.serverSettings.agent.transport === "ssh"
        ? [{
            id: "new-ssh-session",
            label: "New SSH Session",
            onClick: () => handlers.navigateWithinShell({
              view: "compose",
              kind: "ssh-session",
              workspaceId,
            }),
          }]
        : []),
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
  handlers: ShellSidebarActionHandlers,
): ActionMenuItem[] {
  const serverId = server.config.id;
  return withPrivateToggleAction(
    sidebarActionItems([
      {
        id: "open-code-explorer",
        label: "Open code explorer",
        onClick: () => handlers.navigateWithinShell({
          view: "code-explorer",
          contentType: "server",
          serverId,
        }),
      },
      {
        id: "new-session",
        label: "New Session",
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

function getSshSessionSidebarActions(
  target: SshSessionActionTarget,
  session: SshSession | SshServerSession,
  handlers: ShellSidebarActionHandlers,
): ActionMenuItem[] {
  const baseActions = sidebarActionItems([
    {
      id: "rename-ssh-session",
      label: "Rename",
      onClick: () => handlers.openRenameSshSession(target),
    },
    {
      id: "delete-ssh-session",
      label: "Delete Session",
      destructive: true,
      onClick: () => handlers.openDeleteSshSession(target),
    },
  ]);
  return withPrivateToggleAction(baseActions, session.config, () => {
    if (target.kind === "workspace") {
      void handlers.toggleWorkspaceSshSessionPrivate(session as SshSession);
      return;
    }
    void handlers.toggleStandaloneSshSessionPrivate(target.serverId, session as SshServerSession);
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

function buildSidebarNodes(
  {
    sidebarWorkspaceGroups,
    serverNodes,
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
        route: { view: "chat", chatId: item.chatNode.chat.config.id },
        actions: privateActions(actions, privateHidden, item.chatNode.chat.config.isPrivate === true),
        pinnable: true,
        pinId: item.key,
      }, privateHidden);
    }

    const sessionId = item.kind === "ssh-session"
      ? item.sessionNode.session.config.id
      : item.sessionNode.id;
    const session = item.sessionNode.session;
    const ancestors = item.kind === "ssh-session" ? [item.workspace] : [item.server.config];
    const privateHidden = getPrivateHidden(session.config, ancestors, handlers.showPrivateItems);
    const sessionActions = item.kind === "ssh-session"
      ? getSshSessionSidebarActions({
          kind: "workspace",
          id: sessionId,
          name: item.sessionNode.session.config.name,
        }, session, handlers)
      : getSshSessionSidebarActions({
          kind: "standalone",
          id: sessionId,
          name: item.sessionNode.title,
          serverId: item.server.config.id,
        }, session, handlers);
    return privateSidebarPresentation({
      type: "item",
      id: item.key,
      title: item.sessionNode.title,
      subtitle: item.kind === "ssh-session" ? item.workspaceName : item.serverName,
      badge: item.sessionNode.badge,
      badgeVariant: item.sessionNode.badgeVariant,
      route: { view: "ssh", sshSessionId: sessionId },
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
      badge: agent.config.enabled ? "enabled" : "paused",
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
    const children: SidebarNode[] = [
      {
        type: "section",
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
      },
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
        children: workspaceNode.chats.map((chatNode): SidebarNode => {
          const privateHidden = getPrivateHidden(
            chatNode.chat.config,
            [workspaceNode.workspace],
            handlers.showPrivateItems,
          );
          const actions = getChatSidebarActions(chatNode.chat, handlers);
          return privateSidebarPresentation({
            type: "item",
            id: `chat:${chatNode.chat.config.id}`,
            title: chatNode.title,
            badge: chatNode.badge,
            badgeVariant: chatNode.badgeVariant,
            route: { view: "chat", chatId: chatNode.chat.config.id },
            actions: privateActions(actions, privateHidden, chatNode.chat.config.isPrivate === true),
            pinnable: true,
            pinId: `chat:${chatNode.chat.config.id}`,
          }, privateHidden);
        }),
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
        id: `workspace:${workspaceId}:ssh-sessions`,
        title: "SSH sessions",
        action: {
          id: "new-ssh-session",
          title: "New SSH session",
          label: "New",
          route: workspacePrivateHidden
            ? undefined
            : { view: "compose", kind: "ssh-session", workspaceId },
        },
        children: workspaceNode.sshSessions.map((sessionNode): SidebarNode => {
          const privateHidden = getPrivateHidden(
            sessionNode.session.config,
            [workspaceNode.workspace],
            handlers.showPrivateItems,
          );
          const actions = getSshSessionSidebarActions({
            kind: "workspace",
            id: sessionNode.session.config.id,
            name: sessionNode.session.config.name,
          }, sessionNode.session, handlers);
          return privateSidebarPresentation({
            type: "item",
            id: `ssh-session:${sessionNode.session.config.id}`,
            title: sessionNode.title,
            subtitle: sessionNode.subtitle,
            badge: sessionNode.badge,
            badgeVariant: sessionNode.badgeVariant,
            route: { view: "ssh", sshSessionId: sessionNode.session.config.id },
            actions: privateActions(actions, privateHidden, sessionNode.session.config.isPrivate === true),
            pinnable: true,
            pinId: `ssh-session:${sessionNode.session.config.id}`,
          }, privateHidden);
        }),
      },
    ];

    return privateSidebarPresentation({
      type: "item",
      id: `workspace:${workspaceId}`,
      title: workspaceNode.workspace.name,
      searchText: workspaceNode.workspace.directory,
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
      route: { view: "ssh-server", serverId },
      actions: privateActions(
        getSshServerSidebarActions(serverNode.server, handlers),
        serverPrivateHidden,
        serverNode.server.config.isPrivate === true,
      ),
      pinnable: true,
      pinId: `ssh-server:${serverId}`,
      children: [
        {
          type: "section",
          id: `ssh-server:${serverId}:sessions`,
          title: "Sessions",
          action: {
            id: "new-session",
            title: "New SSH session",
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
            const actions = getSshSessionSidebarActions({
              kind: "standalone",
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
              route: { view: "ssh", sshSessionId: sessionNode.id },
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
          children: serverNode.chats.map((chatNode): SidebarNode => {
            const privateHidden = getPrivateHidden(
              chatNode.chat.config,
              [serverNode.server.config],
              handlers.showPrivateItems,
            );
            const actions = getChatSidebarActions(chatNode.chat, handlers);
            return privateSidebarPresentation({
              type: "item",
              id: `ssh-server-chat:${chatNode.chat.config.id}`,
              title: chatNode.title,
              badge: chatNode.badge,
              badgeVariant: chatNode.badgeVariant,
              route: { view: "chat", chatId: chatNode.chat.config.id },
              actions: privateActions(actions, privateHidden, chatNode.chat.config.isPrivate === true),
              pinnable: true,
              pinId: `ssh-server-chat:${chatNode.chat.config.id}`,
            }, privateHidden);
          }),
        },
      ],
    }, serverPrivateHidden);
  });

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
      title: "SSH servers",
      action: {
        id: "new-ssh-server",
        title: "New SSH server",
        label: "New",
        route: { view: "compose", kind: "ssh-server" },
      },
      children: sshServerNodes,
    },
  ], "");
}

export function buildShellSidebarComposition(
  options: ShellSidebarCompositionOptions,
): ShellSidebarComposition {
  const getNodes = ({ search }: { search: string }): SidebarNode[] => {
    const nodes = buildSidebarNodes(options);
    return search ? filterSidebarNodes(nodes as SearchableSidebarNode[], search) : nodes;
  };
  const sidebar = {
    search: true,
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
    headerNodes: flattenSidebarNodes(getNodes({ search: "" })),
  };
}
