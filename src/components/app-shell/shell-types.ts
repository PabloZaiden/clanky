import { canJumpstart, getTaskStatusPill, isFinalState } from "../../utils";
import { createLogger } from "../../lib/logger";
import type { Chat, Task, SshSession, Workspace } from "../../types";
import type { SshServer, SshServerSession } from "../../types/ssh-server";
import {
  getChatStatusBadgeVariant,
  getSshSessionStatusBadgeVariant,
  getSshSessionStatusLabel,
  type BadgeVariant,
} from "../common";

const log = createLogger("AppShell");

export const SIDEBAR_SECTION_STORAGE_KEY = "clanky.sidebarSectionCollapseState";

export type SidebarSectionId = "workspaces" | "ssh-servers";
export type SidebarWorkspaceGroupId = "active" | "inactive";
export type SidebarCollapseState = Record<string, boolean>;

export interface SidebarCollapseStateLoadResult {
  state: SidebarCollapseState;
  invalidReason: string | null;
}

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
}

export type SidebarActiveWorkItem =
  | {
      kind: "task";
      key: string;
      workspaceName: string;
      taskNode: SidebarTaskNode;
    }
  | {
      kind: "chat";
      key: string;
      workspaceName: string;
      chatNode: SidebarChatNode;
    }
  | {
      kind: "ssh-session";
      key: string;
      workspaceName: string;
      sessionNode: SidebarWorkspaceSessionNode;
    };

interface BuildActiveWorkSidebarItemsOptions {
  quickChatWorkspace?: SidebarWorkspaceNode | null;
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
  | { view: "code-explorer"; target?: CodeExplorerTarget }
  | { view: "task"; taskId: string }
  | { view: "task-files"; taskId: string; startDirectory?: string }
  | { view: "chat"; chatId: string }
  | { view: "ssh"; sshSessionId: string }
  | { view: "workspace"; workspaceId: string }
  | { view: "workspace-files"; workspaceId: string; startDirectory?: string }
  | { view: "workspace-settings"; workspaceId: string }
  | { view: "ssh-server"; serverId: string }
  | { view: "ssh-server-settings"; serverId: string }
  | { view: "server-files"; serverId: string; startDirectory?: string }
  | { view: "server-arise"; serverId: string }
  | {
      view: "compose";
      kind: "task" | "chat" | "workspace" | "ssh-session" | "ssh-server";
      scopeId?: string;
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

function buildSidebarCollapseKey(...parts: string[]): string {
  return parts.join(":");
}

function isRecognizedSidebarCollapseKey(key: string): boolean {
  return key === "workspaces"
    || key.startsWith("workspaces:")
    || key === "ssh-servers"
    || key.startsWith("ssh-servers:");
}

function normalizeSidebarCollapseState(state: Record<string, unknown>): SidebarCollapseState {
  return Object.entries(state).reduce<SidebarCollapseState>((normalizedState, [key, value]) => {
    if (value === true && isRecognizedSidebarCollapseKey(key)) {
      normalizedState[key] = true;
    }
    return normalizedState;
  }, {});
}

export function getSidebarSectionCollapseKey(sectionId: SidebarSectionId): string {
  return buildSidebarCollapseKey(sectionId);
}

export function getSidebarGroupCollapseKey(sectionId: SidebarSectionId, groupId: SidebarWorkspaceGroupId): string {
  return buildSidebarCollapseKey(sectionId, "group", groupId);
}

export function getSidebarWorkspaceCollapseKey(
  sectionId: SidebarSectionId,
  groupId: SidebarWorkspaceGroupId,
  workspaceId: string,
): string {
  return buildSidebarCollapseKey(sectionId, "group", groupId, "workspace", workspaceId);
}

export function getSidebarWorkspaceSectionCollapseKey(
  sectionId: SidebarSectionId,
  groupId: SidebarWorkspaceGroupId,
  workspaceId: string,
  childSectionId: "tasks" | "history" | "chats" | "ssh-sessions",
): string {
  return buildSidebarCollapseKey(sectionId, "group", groupId, "workspace", workspaceId, childSectionId);
}

export function getSidebarTaskCollapseKey(
  sectionId: SidebarSectionId,
  groupId: SidebarWorkspaceGroupId,
  workspaceId: string,
  taskId: string,
): string {
  return buildSidebarCollapseKey(sectionId, "group", groupId, "workspace", workspaceId, "task", taskId);
}

export function getSidebarServerCollapseKey(sectionId: SidebarSectionId, serverId: string): string {
  return buildSidebarCollapseKey(sectionId, "server", serverId);
}

export function getSidebarServerSectionCollapseKey(
  sectionId: SidebarSectionId,
  serverId: string,
  childSectionId: "sessions",
): string {
  return buildSidebarCollapseKey(sectionId, "server", serverId, childSectionId);
}

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
      key: "active",
      title: "Active",
      workspaces: workspaceNodes.filter((workspaceNode) => workspaceNode.hasActivity),
    },
    {
      key: "inactive",
      title: "Inactive",
      workspaces: workspaceNodes.filter((workspaceNode) => !workspaceNode.hasActivity),
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
  const quickChatIds = new Set(
    options.quickChatWorkspace?.chats.map((chatNode) => chatNode.chat.config.id) ?? [],
  );

  for (const group of workspaceGroups) {
    for (const workspaceNode of group.workspaces) {
      const workspaceName = workspaceNode.workspace.name;

      for (const taskNode of workspaceNode.tasks) {
        taskItems.push({
          kind: "task",
          key: `task:${taskNode.task.config.id}`,
          workspaceName,
          taskNode,
        });
      }

      for (const chatNode of workspaceNode.chats) {
        chatItems.push({
          kind: "chat",
          key: `chat:${chatNode.chat.config.id}`,
          workspaceName,
          chatNode,
        });
      }

      for (const sessionNode of workspaceNode.sshSessions) {
        sessionItems.push({
          kind: "ssh-session",
          key: `ssh-session:${sessionNode.session.config.id}`,
          workspaceName,
          sessionNode,
        });
      }
    }
  }

  const items = [
    ...taskItems,
    ...chatItems,
    ...sessionItems,
  ];

  if (quickChatIds.size === 0) {
    return items;
  }

  return items.filter((item) => item.kind !== "chat" || !quickChatIds.has(item.chatNode.chat.config.id));
}

function createServerSessionNodeFromWorkspaceSession(
  session: SshSession,
  workspaceName: string,
): SidebarServerSessionNode {
  return {
    id: session.config.id,
    title: session.config.name,
    subtitle: `${workspaceName} · ${getSshConnectionModeLabel(session.config.connectionMode)}`,
    badge: getSshSessionStatusLabel(session.state.status),
    badgeVariant: getSshSessionStatusBadgeVariant(session.state.status),
    createdAt: session.config.createdAt,
  };
}

function createServerSessionNodeFromStandaloneSession(session: SshServerSession): SidebarServerSessionNode {
  return {
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
  workspaces,
  workspaceSessions,
}: {
  servers: SshServer[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  workspaces: Workspace[];
  workspaceSessions: SshSession[];
}): SidebarServerNode[] {
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const workspaceSessionsByServerId = new Map<string, SidebarServerSessionNode[]>();

  for (const session of workspaceSessions) {
    const workspace = workspacesById.get(session.config.workspaceId);
    const serverId = workspace?.sshServerId;
    if (!serverId) {
      continue;
    }
    const groupedSessions = workspaceSessionsByServerId.get(serverId) ?? [];
    groupedSessions.push(
      createServerSessionNodeFromWorkspaceSession(
        session,
        workspace?.name ?? "Unknown workspace",
      ),
    );
    workspaceSessionsByServerId.set(serverId, groupedSessions);
  }

  return servers.map((server) => {
    const standaloneSessions = (sessionsByServerId[server.config.id] ?? [])
      .map(createServerSessionNodeFromStandaloneSession);
    const workspaceBackedSessions = workspaceSessionsByServerId.get(server.config.id) ?? [];
    return {
      server,
      key: server.config.id,
      sessions: sortByDesc([
        ...workspaceBackedSessions,
        ...standaloneSessions,
      ], (session) => session.createdAt),
    };
  });
}

export function isDesktopShellViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(min-width: 1024px)").matches;
}

function getSidebarSectionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch (error) {
    log.warn("Sidebar section storage is unavailable", { error: String(error) });
    return null;
  }
}

export function loadSidebarSectionCollapseState(): SidebarCollapseStateLoadResult {
  const storage = getSidebarSectionStorage();
  if (!storage) {
    return {
      state: {},
      invalidReason: null,
    };
  }

  const raw = storage.getItem(SIDEBAR_SECTION_STORAGE_KEY);
  if (!raw) {
    return {
      state: {},
      invalidReason: null,
    };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid sidebar section state payload");
    }

    const parsedState = parsed as Record<string, unknown>;
    const sanitizedState = normalizeSidebarCollapseState(parsedState);
    return {
      state: sanitizedState,
      invalidReason: null,
    };
  } catch (error) {
    return {
      state: {},
      invalidReason: String(error),
    };
  }
}

export function saveSidebarSectionCollapseState(state: SidebarCollapseState): void {
  const storage = getSidebarSectionStorage();
  if (!storage) {
    return;
  }

  try {
    const normalizedState = normalizeSidebarCollapseState(state);
    if (Object.keys(normalizedState).length === 0) {
      storage.removeItem(SIDEBAR_SECTION_STORAGE_KEY);
      return;
    }
    storage.setItem(SIDEBAR_SECTION_STORAGE_KEY, JSON.stringify(normalizedState));
  } catch (error) {
    log.warn("Failed to persist sidebar section state", { error: String(error) });
  }
}
