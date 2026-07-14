import { canJumpstart, getTaskStatusPill, isFinalState } from "../../utils";
import type { Agent, Chat, Task, SshSession, Workspace } from "@/shared";
import type { SshServer, SshServerSession } from "@/shared/ssh-server";
import {
  getChatStatusBadgeVariant,
  getSshSessionStatusBadgeVariant,
  getSshSessionStatusLabel,
  type BadgeVariant,
} from "../common";

export type SidebarWorkspaceGroupId = "all";

export interface SidebarWorkspaceSessionNode {
  session: SshSession;
  title: string;
  subtitle: string;
  badge: string;
  badgeVariant: BadgeVariant;
  createdAt: string;
}

export interface SidebarTaskNode {
  task: Task;
  title: string;
  badge: string;
  badgeVariant: BadgeVariant;
}

export interface SidebarChatNode {
  chat: Chat;
  title: string;
  badge: string;
  badgeVariant: BadgeVariant;
}

export interface SidebarAgentNode {
  agent: Agent;
  title: string;
  badge: string;
  badgeVariant: BadgeVariant;
}

export interface SidebarWorkspaceNode {
  workspace: Workspace;
  key: string;
  tasks: SidebarTaskNode[];
  historyTasks: SidebarTaskNode[];
  chats: SidebarChatNode[];
  sshSessions: SidebarWorkspaceSessionNode[];
  hasActivity: boolean;
}

export interface SidebarWorkspaceGroupNode {
  key: SidebarWorkspaceGroupId;
  title: string;
  workspaces: SidebarWorkspaceNode[];
}

export interface SidebarServerSessionNode {
  session: SshServerSession;
  id: string;
  title: string;
  subtitle: string;
  badge: string;
  badgeVariant: BadgeVariant;
  createdAt: string;
}

export interface SidebarServerNode {
  server: SshServer;
  key: string;
  sessions: SidebarServerSessionNode[];
  chats: SidebarChatNode[];
}

export type SidebarActiveWorkItem =
  | {
      kind: "task";
      key: string;
      workspace: Workspace;
      workspaceName: string;
      taskNode: SidebarTaskNode;
    }
  | {
      kind: "chat";
      key: string;
      workspace: Workspace;
      workspaceName: string;
      chatNode: SidebarChatNode;
    }
  | {
      kind: "ssh-server-chat";
      key: string;
      server: SshServer;
      serverName: string;
      chatNode: SidebarChatNode;
    }
  | {
      kind: "ssh-session";
      key: string;
      workspace: Workspace;
      workspaceName: string;
      sessionNode: SidebarWorkspaceSessionNode;
    }
  | {
      kind: "ssh-server-session";
      key: string;
      server: SshServer;
      serverName: string;
      sessionNode: SidebarServerSessionNode;
    };

interface BuildActiveWorkSidebarItemsOptions {
  serverNodes?: SidebarServerNode[];
}

export type CodeExplorerTarget =
  | {
      contentType: "workspace";
      workspaceId: string;
      startDirectory?: string;
      filePath?: string;
    }
  | {
      contentType: "task";
      taskId: string;
      startDirectory?: string;
      filePath?: string;
    }
  | {
      contentType: "server";
      serverId: string;
      startDirectory?: string;
      filePath?: string;
    }
  | {
      contentType: "chat";
      chatId: string;
      startDirectory?: string;
      filePath?: string;
    };

export type ShellRoute =
  | { view: "home" }
  | { view: "settings" }
  | { view: "agents"; workspaceId?: string }
  | { view: "agent"; agentId: string }
  | { view: "agent-run"; agentId: string; runId: string }
  | { view: "code-explorer"; target?: CodeExplorerTarget }
  | { view: "task"; taskId: string }
  | { view: "task-files"; taskId: string; startDirectory?: string }
  | { view: "chat"; chatId: string }
  | { view: "ssh"; sshSessionId: string }
  | { view: "workspace"; workspaceId: string }
  | { view: "workspace-files"; workspaceId: string; startDirectory?: string }
  | { view: "workspace-previews"; workspaceId: string }
  | { view: "workspace-settings"; workspaceId: string }
  | { view: "ssh-server"; serverId: string }
  | { view: "vnc-session"; serverId: string }
  | { view: "ssh-server-settings"; serverId: string }
  | { view: "server-files"; serverId: string; startDirectory?: string }
  | { view: "server-arise"; serverId: string }
  | {
      view: "compose";
      kind: "task" | "chat" | "agent" | "workspace" | "ssh-session" | "ssh-server" | "ssh-server-chat";
      scopeId?: string;
      workspaceId?: string;
      serverId?: string;
    }
  | {
      view: "rebuild-workspace";
      workspaceId: string;
    }
  | {
      view: "restart-workspace";
      workspaceId: string;
    };

export type ComposeKind = Extract<ShellRoute, { view: "compose" }>["kind"];

export function getSshConnectionModeLabel(mode: "direct" | "dtach" | string): string {
  return mode === "direct" ? "Direct SSH" : "Persistent SSH";
}

export function getProvisioningStatusBadgeVariant(status: string | undefined): BadgeVariant {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "running":
      return "info";
    case "pending":
      return "warning";
    case "cancelled":
      return "default";
    default:
      return "default";
  }
}

function createWorkspaceSessionNode(
  session: SshSession,
  taskNameById: ReadonlyMap<string, string>,
): SidebarWorkspaceSessionNode {
  const linkedTaskName = session.config.taskId ? taskNameById.get(session.config.taskId) : undefined;
  return {
    session,
    title: session.config.name,
    subtitle: linkedTaskName
      ? `${linkedTaskName} · ${getSshConnectionModeLabel(session.config.connectionMode)}`
      : getSshConnectionModeLabel(session.config.connectionMode),
    badge: getSshSessionStatusLabel(session.state.status),
    badgeVariant: getSshSessionStatusBadgeVariant(session.state.status),
    createdAt: session.config.createdAt,
  };
}

function sortByDesc<T>(items: T[], getValue: (item: T) => string): T[] {
  return [...items].sort((left, right) => getValue(right).localeCompare(getValue(left)));
}

function isTerminalSidebarTask(task: Task): boolean {
  const { status } = task.state;
  return status !== "completed" && status !== "pushed" && (canJumpstart(status) || isFinalState(status));
}

export function buildWorkspaceSidebarGroups({
  workspaces,
  tasks,
  chats,
  sessions,
}: {
  workspaces: Workspace[];
  tasks: Task[];
  chats: Chat[];
  sessions: SshSession[];
}): SidebarWorkspaceGroupNode[] {
  const tasksByWorkspaceId = new Map<string, Task[]>();
  const chatsByWorkspaceId = new Map<string, Chat[]>();
  const sessionsByWorkspaceId = new Map<string, SshSession[]>();
  const taskNameById = new Map(tasks.map((task) => [task.config.id, task.config.name]));

  for (const task of tasks) {
    const workspaceTasks = tasksByWorkspaceId.get(task.config.workspaceId) ?? [];
    workspaceTasks.push(task);
    tasksByWorkspaceId.set(task.config.workspaceId, workspaceTasks);
  }

  for (const chat of chats) {
    const workspaceChats = chatsByWorkspaceId.get(chat.config.workspaceId) ?? [];
    workspaceChats.push(chat);
    chatsByWorkspaceId.set(chat.config.workspaceId, workspaceChats);
  }

  for (const session of sessions) {
    const workspaceSessions = sessionsByWorkspaceId.get(session.config.workspaceId) ?? [];
    workspaceSessions.push(session);
    sessionsByWorkspaceId.set(session.config.workspaceId, workspaceSessions);
  }

  const workspaceNodes = workspaces.map((workspace) => {
    const workspaceTasks = tasksByWorkspaceId.get(workspace.id) ?? [];
    const workspaceChats = [...(chatsByWorkspaceId.get(workspace.id) ?? [])]
      .sort((left, right) => right.config.updatedAt.localeCompare(left.config.updatedAt));
    const workspaceSessions = sortByDesc(
      sessionsByWorkspaceId.get(workspace.id) ?? [],
      (session) => session.config.createdAt,
    )
      .map((session) => createWorkspaceSessionNode(session, taskNameById));
    const taskNodes = workspaceTasks.map((task) => {
      const statusPill = getTaskStatusPill(task);
      return {
        task,
        title: task.config.name,
        badge: statusPill.label,
        badgeVariant: statusPill.variant,
      };
    });
    const activeTaskNodes = taskNodes.filter((taskNode) => !isTerminalSidebarTask(taskNode.task));
    const historyTaskNodes = taskNodes.filter((taskNode) => isTerminalSidebarTask(taskNode.task));

    return {
      workspace,
      key: workspace.id,
      tasks: activeTaskNodes,
      historyTasks: historyTaskNodes,
      chats: workspaceChats.map((chat) => ({
        chat,
        title: chat.config.name,
        badge: chat.state.status,
        badgeVariant: getChatStatusBadgeVariant(chat.state.status),
      })),
      sshSessions: workspaceSessions,
      hasActivity: taskNodes.length > 0 || workspaceChats.length > 0 || workspaceSessions.length > 0,
    } satisfies SidebarWorkspaceNode;
  });

  return [
    {
      key: "all",
      title: "Workspaces",
      workspaces: workspaceNodes,
    },
  ];
}

export function buildActiveWorkSidebarItems(
  workspaceGroups: SidebarWorkspaceGroupNode[],
  options: BuildActiveWorkSidebarItemsOptions = {},
): SidebarActiveWorkItem[] {
  const taskItems: SidebarActiveWorkItem[] = [];
  const chatItems: SidebarActiveWorkItem[] = [];
  const sessionItems: SidebarActiveWorkItem[] = [];
  const workspaceSessionIds = new Set<string>();

  for (const group of workspaceGroups) {
    for (const workspaceNode of group.workspaces) {
      if (workspaceNode.workspace.archived === true) {
        continue;
      }

      const workspaceName = workspaceNode.workspace.name;

      for (const taskNode of workspaceNode.tasks) {
        taskItems.push({
          kind: "task",
          key: `task:${taskNode.task.config.id}`,
          workspace: workspaceNode.workspace,
          workspaceName,
          taskNode,
        });
      }

      for (const chatNode of workspaceNode.chats) {
        chatItems.push({
          kind: "chat",
          key: `chat:${chatNode.chat.config.id}`,
          workspace: workspaceNode.workspace,
          workspaceName,
          chatNode,
        });
      }

      for (const sessionNode of workspaceNode.sshSessions) {
        workspaceSessionIds.add(sessionNode.session.config.id);
        sessionItems.push({
          kind: "ssh-session",
          key: `ssh-session:${sessionNode.session.config.id}`,
          workspace: workspaceNode.workspace,
          workspaceName,
          sessionNode,
        });
      }
    }
  }

  for (const serverNode of options.serverNodes ?? []) {
    for (const chatNode of serverNode.chats) {
      chatItems.push({
        kind: "ssh-server-chat",
        key: `ssh-server-chat:${chatNode.chat.config.id}`,
        server: serverNode.server,
        serverName: serverNode.server.config.name,
        chatNode,
      });
    }

    for (const sessionNode of serverNode.sessions) {
      if (workspaceSessionIds.has(sessionNode.id)) {
        continue;
      }

      sessionItems.push({
        kind: "ssh-server-session",
        key: `ssh-server-session:${sessionNode.id}`,
        server: serverNode.server,
        serverName: serverNode.server.config.name,
        sessionNode,
      });
    }
  }

  return [
    ...taskItems,
    ...chatItems,
    ...sessionItems,
  ];
}

function createServerSessionNodeFromStandaloneSession(session: SshServerSession): SidebarServerSessionNode {
  return {
    session,
    id: session.config.id,
    title: session.config.name,
    subtitle: getSshConnectionModeLabel(session.config.connectionMode),
    badge: getSshSessionStatusLabel(session.state.status),
    badgeVariant: getSshSessionStatusBadgeVariant(session.state.status),
    createdAt: session.config.createdAt,
  };
}

export function buildServerSidebarNodes({
  servers,
  sessionsByServerId,
  chats = [],
}: {
  servers: SshServer[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  chats?: Chat[];
}): SidebarServerNode[] {
  const chatsByServerId = new Map<string, Chat[]>();

  for (const chat of chats) {
    if (chat.config.source?.kind !== "ssh_server") {
      continue;
    }
    const serverChats = chatsByServerId.get(chat.config.source.sshServerId) ?? [];
    serverChats.push(chat);
    chatsByServerId.set(chat.config.source.sshServerId, serverChats);
  }

  return servers.map((server) => {
    const standaloneSessions = (sessionsByServerId[server.config.id] ?? [])
      .map(createServerSessionNodeFromStandaloneSession);
    return {
      server,
      key: server.config.id,
      sessions: sortByDesc(standaloneSessions, (session) => session.createdAt),
      chats: sortByDesc(chatsByServerId.get(server.config.id) ?? [], (chat) => chat.config.updatedAt)
        .map((chat) => ({
          chat,
          title: chat.config.name,
          badge: chat.state.status,
          badgeVariant: getChatStatusBadgeVariant(chat.state.status),
        })),
    };
  });
}
