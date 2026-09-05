import {
  canJumpstart,
  getTaskStatusPill,
  isFinalState,
} from "../../utils";
import { getChatWorkspaceId, isStandaloneChat, isWorkspaceChat } from "@/shared/chat";
import {
  executionHostRefsEqual,
  type Agent,
  type Chat,
  type ExecutionHostDescriptor,
  type Task,
  type TerminalSession,
  type Workspace,
} from "@/shared";
import type { SshServer } from "@/shared/ssh-server";
import {
  getChatStatusBadgeVariant,
  getTerminalSessionStatusBadgeVariant,
  getTerminalSessionStatusLabel,
  formatStatusLabel,
  type BadgeVariant,
} from "../common";

export type SidebarWorkspaceGroupId = "all";

export interface SidebarWorkspaceTerminalNode {
  session: TerminalSession;
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
  historyChats: SidebarChatNode[];
  terminalSessions: SidebarWorkspaceTerminalNode[];
  hasActivity: boolean;
}

export interface SidebarWorkspaceGroupNode {
  key: SidebarWorkspaceGroupId;
  title: string;
  workspaces: SidebarWorkspaceNode[];
}

export interface SidebarExecutionHostTerminalNode {
  session: TerminalSession;
  title: string;
  subtitle: string;
  badge: string;
  badgeVariant: BadgeVariant;
  createdAt: string;
}

export interface SidebarExecutionHostNode {
  host: ExecutionHostDescriptor;
  sshServer?: SshServer;
  key: string;
  terminalSessions: SidebarExecutionHostTerminalNode[];
  chats: SidebarChatNode[];
  historyChats: SidebarChatNode[];
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
      kind: "execution-host-chat";
      key: string;
      host: ExecutionHostDescriptor;
      chatNode: SidebarChatNode;
    }
  | {
      kind: "terminal-session";
      key: string;
      workspace: Workspace;
      workspaceName: string;
      sessionNode: SidebarWorkspaceTerminalNode;
    }
  | {
      kind: "execution-host-terminal";
      key: string;
      host: ExecutionHostDescriptor;
      sessionNode: SidebarExecutionHostTerminalNode;
    };

export type SidebarChatHistoryItem =
  | {
      kind: "chat";
      key: string;
      workspace: Workspace;
      workspaceName: string;
      chatNode: SidebarChatNode;
    }
  | {
      kind: "execution-host-chat";
      key: string;
      host: ExecutionHostDescriptor;
      chatNode: SidebarChatNode;
    };

interface BuildActiveWorkSidebarItemsOptions {
  executionHostNodes?: SidebarExecutionHostNode[];
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
      contentType: "execution-host";
      hostKind: "local" | "mesh" | "ssh";
      hostId: string;
      startDirectory?: string;
      filePath?: string;
    }
  | {
      contentType: "chat";
      chatId: string;
      startDirectory?: string;
      filePath?: string;
    };

export function getTerminalConnectionModeLabel(mode: "direct" | "dtach" | string): string {
  return mode === "direct" ? "Direct" : "Persistent";
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
    case "interrupted":
      return "default";
    default:
      return "default";
  }
}

function createWorkspaceTerminalNode(
  session: TerminalSession,
  taskNameById: ReadonlyMap<string, string>,
): SidebarWorkspaceTerminalNode {
  const linkedTaskName = session.config.taskId ? taskNameById.get(session.config.taskId) : undefined;
  return {
    session,
    title: session.config.name,
    subtitle: linkedTaskName
      ? `${linkedTaskName} · ${getTerminalConnectionModeLabel(session.config.connectionMode)}`
      : getTerminalConnectionModeLabel(session.config.connectionMode),
    badge: getTerminalSessionStatusLabel(session.state.status),
    badgeVariant: getTerminalSessionStatusBadgeVariant(session.state.status),
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
  terminalSessions = [],
}: {
  workspaces: Workspace[];
  tasks: Task[];
  chats: Chat[];
  terminalSessions?: TerminalSession[];
}): SidebarWorkspaceGroupNode[] {
  const tasksByWorkspaceId = new Map<string, Task[]>();
  const chatsByWorkspaceId = new Map<string, Chat[]>();
  const terminalsByWorkspaceId = new Map<string, TerminalSession[]>();
  const taskNameById = new Map(tasks.map((task) => [task.config.id, task.config.name]));

  for (const task of tasks) {
    const workspaceTasks = tasksByWorkspaceId.get(task.config.workspaceId) ?? [];
    workspaceTasks.push(task);
    tasksByWorkspaceId.set(task.config.workspaceId, workspaceTasks);
  }

  for (const chat of chats) {
    if (!isStandaloneChat(chat) || !isWorkspaceChat(chat)) {
      continue;
    }
    const workspaceId = getChatWorkspaceId(chat);
    const workspaceChats = chatsByWorkspaceId.get(workspaceId) ?? [];
    workspaceChats.push(chat);
    chatsByWorkspaceId.set(workspaceId, workspaceChats);
  }

  for (const terminal of terminalSessions) {
    if (!terminal.config.workspaceId) {
      continue;
    }
    const workspaceTerminals = terminalsByWorkspaceId.get(terminal.config.workspaceId) ?? [];
    workspaceTerminals.push(terminal);
    terminalsByWorkspaceId.set(terminal.config.workspaceId, workspaceTerminals);
  }

  const workspaceNodes = workspaces.map((workspace) => {
    const workspaceTasks = tasksByWorkspaceId.get(workspace.id) ?? [];
    const workspaceChats = [...(chatsByWorkspaceId.get(workspace.id) ?? [])]
      .sort((left, right) => right.config.updatedAt.localeCompare(left.config.updatedAt));
    const workspaceTerminals = sortByDesc(
      terminalsByWorkspaceId.get(workspace.id) ?? [],
      (terminal) => terminal.config.createdAt,
    )
      .map((terminal) => createWorkspaceTerminalNode(terminal, taskNameById));
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
    const chatNodes = workspaceChats.map((chat) => ({
      chat,
      title: chat.config.name,
      badge: formatStatusLabel(chat.state.status),
      badgeVariant: getChatStatusBadgeVariant(chat.state.status),
    }));
    const activeChatNodes = chatNodes.filter((chatNode) => chatNode.chat.state.status !== "done");
    const historyChatNodes = chatNodes.filter((chatNode) => chatNode.chat.state.status === "done");

    return {
      workspace,
      key: workspace.id,
      tasks: activeTaskNodes,
      historyTasks: historyTaskNodes,
      chats: activeChatNodes,
      historyChats: historyChatNodes,
      terminalSessions: workspaceTerminals,
      hasActivity: activeTaskNodes.length > 0 || activeChatNodes.length > 0 || workspaceTerminals.length > 0,
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

      for (const terminalNode of workspaceNode.terminalSessions) {
        sessionItems.push({
          kind: "terminal-session",
          key: `terminal-session:${terminalNode.session.config.id}`,
          workspace: workspaceNode.workspace,
          workspaceName,
          sessionNode: terminalNode,
        });
      }
    }
  }

  for (const hostNode of options.executionHostNodes ?? []) {
    for (const chatNode of hostNode.chats) {
      chatItems.push({
        kind: "execution-host-chat",
        key: `execution-host-chat:${chatNode.chat.config.id}`,
        host: hostNode.host,
        chatNode,
      });
    }

    for (const sessionNode of hostNode.terminalSessions) {
      sessionItems.push({
        kind: "execution-host-terminal",
        key: `execution-host-terminal:${sessionNode.session.config.id}`,
        host: hostNode.host,
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

export function buildChatHistorySidebarItems(
  workspaceGroups: SidebarWorkspaceGroupNode[],
  options: BuildActiveWorkSidebarItemsOptions = {},
): SidebarChatHistoryItem[] {
  const historyItems: SidebarChatHistoryItem[] = [];

  for (const group of workspaceGroups) {
    for (const workspaceNode of group.workspaces) {
      for (const chatNode of workspaceNode.historyChats) {
        historyItems.push({
          kind: "chat",
          key: `chat:${chatNode.chat.config.id}`,
          workspace: workspaceNode.workspace,
          workspaceName: workspaceNode.workspace.name,
          chatNode,
        });
      }
    }
  }

  for (const hostNode of options.executionHostNodes ?? []) {
    for (const chatNode of hostNode.historyChats) {
      historyItems.push({
        kind: "execution-host-chat",
        key: `execution-host-chat:${chatNode.chat.config.id}`,
        host: hostNode.host,
        chatNode,
      });
    }
  }

  return historyItems;
}

function createExecutionHostTerminalNode(session: TerminalSession): SidebarExecutionHostTerminalNode {
  return {
    session,
    title: session.config.name,
    subtitle: getTerminalConnectionModeLabel(session.config.connectionMode),
    badge: getTerminalSessionStatusLabel(session.state.status),
    badgeVariant: getTerminalSessionStatusBadgeVariant(session.state.status),
    createdAt: session.config.createdAt,
  };
}

export function buildExecutionHostSidebarNodes({
  executionHosts,
  servers,
  terminalSessions,
  chats = [],
}: {
  executionHosts: ExecutionHostDescriptor[];
  servers: SshServer[];
  terminalSessions: TerminalSession[];
  chats?: Chat[];
}): SidebarExecutionHostNode[] {
  return executionHosts.map((host) => {
    const sshServerId = host.ref.kind === "ssh" ? host.ref.serverId : null;
    const hostChats = chats.filter((chat) => {
      const source = chat.config.source;
      return isStandaloneChat(chat)
        && source?.kind === "execution_host"
        && executionHostRefsEqual(source.executionHost.host, host.ref);
    });
    const hostTerminalSessions = terminalSessions
      .filter((session) => (
        !session.config.workspaceId
        && executionHostRefsEqual(session.config.executionHostBinding.host, host.ref)
      ))
      .map(createExecutionHostTerminalNode);
    return {
      host,
      sshServer: sshServerId
        ? servers.find((server) => server.config.id === sshServerId)
        : undefined,
      key: host.targetKey,
      terminalSessions: sortByDesc(hostTerminalSessions, (session) => session.createdAt),
      chats: sortByDesc(hostChats, (chat) => chat.config.updatedAt)
        .filter((chat) => chat.state.status !== "done")
        .map((chat) => ({
          chat,
          title: chat.config.name,
          badge: formatStatusLabel(chat.state.status),
          badgeVariant: getChatStatusBadgeVariant(chat.state.status),
        })),
      historyChats: sortByDesc(hostChats, (chat) => chat.config.updatedAt)
        .filter((chat) => chat.state.status === "done")
        .map((chat) => ({
          chat,
          title: chat.config.name,
          badge: formatStatusLabel(chat.state.status),
          badgeVariant: getChatStatusBadgeVariant(chat.state.status),
        })),
    };
  });
}
