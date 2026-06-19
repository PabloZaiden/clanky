import type { ActionMenuItem } from "../common";
import { insertPinActionItem } from "../common";
import type { SshServer, Workspace } from "../../types";
import type { ShellRoute } from "./shell-types";
import type { SidebarPinnedItem, SidebarPinningState } from "./sidebar-pins";

export interface WorkspaceActionItemOptions {
  workspace: Workspace;
  githubUrl: string | null;
  pullingLatestChanges: boolean;
  onNavigate: (route: ShellRoute) => void;
  onPullLatestChanges: () => void;
  onOpenGitHub: (url: string) => void;
  sidebarPinning?: SidebarPinningState;
}

export interface SshServerActionItemOptions {
  server: SshServer;
  onNavigate: (route: ShellRoute) => void;
  sidebarPinning?: SidebarPinningState;
}

export interface TaskActionItemOptions {
  taskId: string;
  onOpenCodeExplorer: () => void;
  sidebarPinning?: SidebarPinningState;
}

export interface SshSessionActionItemOptions {
  sessionId: string;
  includeOpenSession?: boolean;
  canRename: boolean;
  onOpenSession: () => void;
  onRename: () => void;
  onDelete: () => void;
  sidebarPinning?: SidebarPinningState;
}

export function buildPinActionItem(
  sidebarPinning: SidebarPinningState | undefined,
  item: SidebarPinnedItem,
): ActionMenuItem | null {
  if (!sidebarPinning) {
    return null;
  }

  return {
    id: "toggle-sidebar-pin",
    label: sidebarPinning.isPinned(item) ? "Unpin from sidebar" : "Pin to sidebar",
    onClick: () => sidebarPinning.togglePinned(item),
  };
}

function withPinAction(items: ActionMenuItem[], pinItem: ActionMenuItem | null): ActionMenuItem[] {
  return pinItem ? insertPinActionItem(items, pinItem) : items;
}

export function buildWorkspaceActionItems({
  workspace,
  githubUrl,
  pullingLatestChanges,
  onNavigate,
  onPullLatestChanges,
  onOpenGitHub,
  sidebarPinning,
}: WorkspaceActionItemOptions): ActionMenuItem[] {
  const workspaceSshEnabled = workspace.serverSettings.agent.transport === "ssh";
  const items: ActionMenuItem[] = [
    {
      id: "new-task",
      label: "New Task",
      onClick: () => onNavigate({ view: "compose", kind: "task", scopeId: workspace.id }),
    },
    {
      id: "new-chat",
      label: "New Chat",
      onClick: () => onNavigate({ view: "compose", kind: "chat", scopeId: workspace.id }),
    },
    {
      id: "new-agent",
      label: "New Agent",
      onClick: () => onNavigate({ view: "compose", kind: "agent", scopeId: workspace.id }),
    },
    {
      id: "open-code-explorer",
      label: "Open code explorer",
      onClick: () => onNavigate({ view: "code-explorer", target: { contentType: "workspace", workspaceId: workspace.id } }),
    },
    {
      id: "pull-latest-changes",
      label: pullingLatestChanges ? "Pulling Latest Changes..." : "Pull Latest Changes",
      onClick: onPullLatestChanges,
      disabled: pullingLatestChanges,
    },
    {
      id: "open-github",
      label: "Open in GitHub",
      onClick: () => {
        if (githubUrl) {
          onOpenGitHub(githubUrl);
        }
      },
      disabled: !githubUrl,
    },
    ...(workspaceSshEnabled
      ? [{
          id: "new-ssh-session",
          label: "New SSH Session",
          onClick: () => onNavigate({ view: "compose", kind: "ssh-session", scopeId: workspace.id }),
        }]
      : []),
    {
      id: "workspace-settings",
      label: "Workspace Settings",
      onClick: () => onNavigate({ view: "workspace-settings", workspaceId: workspace.id }),
    },
  ];

  return withPinAction(items, buildPinActionItem(sidebarPinning, { kind: "workspace", id: workspace.id }));
}

export function buildSshServerActionItems({
  server,
  onNavigate,
  sidebarPinning,
}: SshServerActionItemOptions): ActionMenuItem[] {
  const items: ActionMenuItem[] = [
    {
      id: "open-code-explorer",
      label: "Open code explorer",
      onClick: () => onNavigate({ view: "code-explorer", target: { contentType: "server", serverId: server.config.id } }),
    },
    {
      id: "new-session",
      label: "New Session",
      onClick: () => onNavigate({ view: "compose", kind: "ssh-session", scopeId: server.config.id }),
    },
    {
      id: "new-chat",
      label: "New Chat",
      onClick: () => onNavigate({ view: "compose", kind: "ssh-server-chat", scopeId: server.config.id }),
    },
    {
      id: "start-vnc-session",
      label: "Start VNC Session",
      onClick: () => onNavigate({ view: "vnc-session", serverId: server.config.id }),
    },
    {
      id: "ssh-server-settings",
      label: "SSH Server Settings",
      onClick: () => onNavigate({ view: "ssh-server-settings", serverId: server.config.id }),
    },
  ];

  return withPinAction(items, buildPinActionItem(sidebarPinning, { kind: "ssh-server", id: server.config.id }));
}

export function buildTaskActionItems({
  taskId,
  onOpenCodeExplorer,
  sidebarPinning,
}: TaskActionItemOptions): ActionMenuItem[] {
  return withPinAction([
    {
      id: "open-code-explorer",
      label: "Open code explorer",
      onClick: onOpenCodeExplorer,
    },
  ], buildPinActionItem(sidebarPinning, { kind: "task", id: taskId }));
}

export function buildSshSessionActionItems({
  sessionId,
  includeOpenSession = true,
  canRename,
  onOpenSession,
  onRename,
  onDelete,
  sidebarPinning,
}: SshSessionActionItemOptions): ActionMenuItem[] {
  return withPinAction([
    ...(includeOpenSession
      ? [{
          id: "open-session",
          label: "Open session",
          onClick: onOpenSession,
        }]
      : []),
    {
      id: "rename",
      label: "Rename",
      onClick: onRename,
      disabled: !canRename,
    },
    {
      id: "delete",
      label: "Delete",
      onClick: onDelete,
      destructive: true,
    },
  ], buildPinActionItem(sidebarPinning, { kind: "ssh-session", id: sessionId }));
}
