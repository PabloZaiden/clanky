import { canJumpstart, getLoopStatusLabel, isFinalState } from "../../utils";
import { createLogger } from "../../lib/logger";
import type { Chat, Loop, SshSession, Workspace } from "../../types";
import type { SshServer, SshServerSession } from "../../types/ssh-server";
import {
  getChatStatusBadgeVariant,
  getLoopStatusBadgeVariant,
  getSshSessionStatusBadgeVariant,
  getSshSessionStatusLabel,
  type BadgeVariant,
} from "../common";

const log = createLogger("AppShell");

export const SIDEBAR_SECTION_STORAGE_KEY = "ralpher.sidebarSectionCollapseState";

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

export interface SidebarLoopNode {
  loop: Loop;
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
  loops: SidebarLoopNode[];
  historyLoops: SidebarLoopNode[];
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

export type CodeExplorerTarget =
  | {
      contentType: "workspace";
      workspaceId: string;
      startDirectory?: string;
    }
  | {
      contentType: "loop";
      loopId: string;
      startDirectory?: string;
    }
  | {
      contentType: "server";
      serverId: string;
      startDirectory?: string;
    }
  | {
      contentType: "chat";
      chatId: string;
      startDirectory?: string;
    };

export type ShellRoute =
  | { view: "home" }
  | { view: "settings" }
  | { view: "code-explorer"; target?: CodeExplorerTarget }
  | { view: "loop"; loopId: string }
  | { view: "loop-files"; loopId: string; startDirectory?: string }
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
      kind: "loop" | "chat" | "workspace" | "ssh-session" | "ssh-server";
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
  childSectionId: "loops" | "history" | "chats" | "ssh-sessions",
): string {
  return buildSidebarCollapseKey(sectionId, "group", groupId, "workspace", workspaceId, childSectionId);
}

export function getSidebarLoopCollapseKey(
  sectionId: SidebarSectionId,
  groupId: SidebarWorkspaceGroupId,
  workspaceId: string,
  loopId: string,
): string {
  return buildSidebarCollapseKey(sectionId, "group", groupId, "workspace", workspaceId, "loop", loopId);
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
  loopNameById: ReadonlyMap<string, string>,
): SidebarWorkspaceSessionNode {
  const linkedLoopName = session.config.loopId ? loopNameById.get(session.config.loopId) : undefined;
  return {
    session,
    title: session.config.name,
    subtitle: linkedLoopName
      ? `${linkedLoopName} · ${getSshConnectionModeLabel(session.config.connectionMode)}`
      : getSshConnectionModeLabel(session.config.connectionMode),
    badge: getSshSessionStatusLabel(session.state.status),
    badgeVariant: getSshSessionStatusBadgeVariant(session.state.status),
    createdAt: session.config.createdAt,
  };
}

function sortByDesc<T>(items: T[], getValue: (item: T) => string): T[] {
  return [...items].sort((left, right) => getValue(right).localeCompare(getValue(left)));
}

function isTerminalSidebarLoop(loop: Loop): boolean {
  const { status } = loop.state;
  return status !== "completed" && status !== "pushed" && (canJumpstart(status) || isFinalState(status));
}

export function buildWorkspaceSidebarGroups({
  workspaces,
  loops,
  chats,
  sessions,
}: {
  workspaces: Workspace[];
  loops: Loop[];
  chats: Chat[];
  sessions: SshSession[];
}): SidebarWorkspaceGroupNode[] {
  const loopsByWorkspaceId = new Map<string, Loop[]>();
  const chatsByWorkspaceId = new Map<string, Chat[]>();
  const sessionsByWorkspaceId = new Map<string, SshSession[]>();
  const loopNameById = new Map(loops.map((loop) => [loop.config.id, loop.config.name]));

  for (const loop of loops) {
    const workspaceLoops = loopsByWorkspaceId.get(loop.config.workspaceId) ?? [];
    workspaceLoops.push(loop);
    loopsByWorkspaceId.set(loop.config.workspaceId, workspaceLoops);
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
    const workspaceLoops = loopsByWorkspaceId.get(workspace.id) ?? [];
    const workspaceChats = [...(chatsByWorkspaceId.get(workspace.id) ?? [])]
      .sort((left, right) => right.config.updatedAt.localeCompare(left.config.updatedAt));
    const workspaceSessions = sortByDesc(
      sessionsByWorkspaceId.get(workspace.id) ?? [],
      (session) => session.config.createdAt,
    )
      .map((session) => createWorkspaceSessionNode(session, loopNameById));
    const loopNodes = workspaceLoops.map((loop) => ({
      loop,
      title: loop.config.name,
      badge: getLoopStatusLabel(loop),
      badgeVariant: getLoopStatusBadgeVariant(
        loop.state.status,
        loop.state.planMode?.isPlanReady ?? false,
      ),
    }));
    const activeLoopNodes = loopNodes.filter((loopNode) => !isTerminalSidebarLoop(loopNode.loop));
    const historyLoopNodes = loopNodes.filter((loopNode) => isTerminalSidebarLoop(loopNode.loop));

    return {
      workspace,
      key: workspace.id,
      loops: activeLoopNodes,
      historyLoops: historyLoopNodes,
      chats: workspaceChats.map((chat) => ({
        chat,
        title: chat.config.name,
        badge: chat.state.status,
        badgeVariant: getChatStatusBadgeVariant(chat.state.status),
      })),
      sshSessions: workspaceSessions,
      hasActivity: activeLoopNodes.length > 0 || workspaceChats.length > 0 || workspaceSessions.length > 0,
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
