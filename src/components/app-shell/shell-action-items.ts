import type { ActionMenuItem } from "../common";
import type { SshServer, Workspace } from "../../types";
import type { ShellRoute } from "./shell-types";

export interface WorkspaceActionItemOptions {
  workspace: Workspace;
  githubUrl: string | null;
  pullingLatestChanges: boolean;
  onNavigate: (route: ShellRoute) => void;
  onPullLatestChanges: () => void;
  onOpenGitHub: (url: string) => void;
}

export interface SshServerActionItemOptions {
  server: SshServer;
  onNavigate: (route: ShellRoute) => void;
}

export function buildWorkspaceActionItems({
  workspace,
  githubUrl,
  pullingLatestChanges,
  onNavigate,
  onPullLatestChanges,
  onOpenGitHub,
}: WorkspaceActionItemOptions): ActionMenuItem[] {
  const workspaceSshEnabled = workspace.serverSettings.agent.transport === "ssh";

  return [
    {
      label: "New Task",
      onClick: () => onNavigate({ view: "compose", kind: "task", scopeId: workspace.id }),
    },
    {
      label: "New Chat",
      onClick: () => onNavigate({ view: "compose", kind: "chat", scopeId: workspace.id }),
    },
    {
      label: "Open code explorer",
      onClick: () => onNavigate({ view: "code-explorer", target: { contentType: "workspace", workspaceId: workspace.id } }),
    },
    {
      id: "pull-latest-changes",
      label: pullingLatestChanges ? "Pulling Latest Changes..." : "Pull Latest Changes",
      onClick: onPullLatestChanges,
      disabled: pullingLatestChanges,
    },
    ...(githubUrl
      ? [{
          label: "Open in GitHub",
          onClick: () => onOpenGitHub(githubUrl),
        }]
      : []),
    ...(workspaceSshEnabled
      ? [{
          label: "New SSH Session",
          onClick: () => onNavigate({ view: "compose", kind: "ssh-session", scopeId: workspace.id }),
        }]
      : []),
  ];
}

export function buildSshServerActionItems({
  server,
  onNavigate,
}: SshServerActionItemOptions): ActionMenuItem[] {
  return [
    {
      label: "Open code explorer",
      onClick: () => onNavigate({ view: "code-explorer", target: { contentType: "server", serverId: server.config.id } }),
    },
    {
      label: "New Session",
      onClick: () => onNavigate({ view: "compose", kind: "ssh-session", scopeId: server.config.id }),
    },
  ];
}

